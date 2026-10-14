/**
 * A tolerant recursive-descent parser for C# 7.3 expressions (`@(...)`) and statement blocks
 * (`@{...}`). It never throws: errors are collected and missing pieces become `missing` nodes or
 * empty names, so half-typed code still gives the binder a tree to work with.
 *
 * Ambiguities are settled the way the C# spec does: `<` after a name starts type arguments only
 * when the matching `>` is followed by a token that can follow them, and `(T)x` is a cast when `T`
 * is a predefined type or the `)` is followed by something that starts an operand.
 */

import { lexAll, PREDEFINED_TYPES, type Token, type Trivia } from './lexer';
import type { Argument, ArgumentList, Block, CatchClause, Declarator, Designation, Expr, Initializer, LambdaParam, LiteralKind, NamePart, Span, Stmt, SwitchSection, SyntaxError, TypeNode } from './syntax';

export interface ParsedExpression {
  kind: 'expr';
  root: Expr;
  errors: SyntaxError[];
  trivia: Trivia[];
}

export interface ParsedBlock {
  kind: 'block';
  root: Block;
  errors: SyntaxError[];
  trivia: Trivia[];
}

export type Parsed = ParsedExpression | ParsedBlock;

/** Parses the code between `@(` and `)`. */
export function parseExpression(code: string): ParsedExpression {
  const p = new Parser(code);
  const root = p.expression();
  p.expectEnd();
  return { kind: 'expr', root, errors: p.errors, trivia: p.trivia };
}

/** Parses the code between `@{` and `}` as a statement list. */
export function parseBlock(code: string): ParsedBlock {
  const p = new Parser(code);
  const statements = p.statementList(() => p.atEnd());
  return { kind: 'block', root: { kind: 'block', start: 0, end: code.length, statements }, errors: p.errors, trivia: p.trivia };
}

export function parse(code: string, kind: 'expr' | 'block'): Parsed {
  return kind === 'expr' ? parseExpression(code) : parseBlock(code);
}

/** Reads a type starting at `tokens[pos]`, for declaration readers like the stub loader. */
export function readType(code: string, tokens: Token[], pos: number): { type: TypeNode; pos: number; ok: boolean } {
  const p = new Parser(code, tokens, pos);
  const type = p.type();
  return { type, pos: p.position, ok: p.errors.length === 0 };
}

/** Thrown by strict (speculative) parsing when the input doesn't fit. */
class Mismatch {}
const MISMATCH = new Mismatch();

/** Tokens that may follow a type argument list in an expression (C# spec §7.6.5.2). */
const AFTER_TYPE_ARGS = new Set(['(', ')', ']', '}', ':', ';', ',', '.', '?', '==', '!=', '|', '^', '&&', '||', '&', '[', '?.', '=>']);

const ASSIGNMENT = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '??=']);

const BINARY_LEVELS: string[][] = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>=', 'is', 'as'], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];

/** Keywords that can start an operand after a parenthesised type (so `(T)` is a cast). */
const OPERAND_KEYWORDS = new Set(['this', 'base', 'new', 'typeof', 'default', 'true', 'false', 'null', 'checked', 'unchecked', 'sizeof', ...Object.keys(PREDEFINED_TYPES)]);

class Parser {
  readonly errors: SyntaxError[] = [];
  readonly trivia: Trivia[];
  private toks: Token[];
  private pos = 0;
  private strict = 0;

  constructor(
    private readonly code: string,
    tokens?: Token[],
    start = 0,
  ) {
    this.pos = start;
    if (tokens) {
      this.toks = tokens;
      this.trivia = [];
    } else {
      const lexed = lexAll(code);
      this.toks = lexed.tokens;
      this.trivia = lexed.trivia;
      for (const e of lexed.errors) this.errors.push(e);
      for (const t of this.toks) if (t.error) this.errors.push({ start: t.start, end: t.end, message: t.error });
    }
  }

  // ---- token helpers ------------------------------------------------------------------------

  get position(): number {
    return this.pos;
  }

  private get tok(): Token {
    return this.toks[this.pos];
  }

  private peek(n = 1): Token {
    return this.toks[Math.min(this.pos + n, this.toks.length - 1)];
  }

  atEnd(): boolean {
    return this.tok.kind === 'eof';
  }

  private is(text: string, t: Token = this.tok): boolean {
    return (t.kind === 'punct' || t.kind === 'keyword') && t.text === text;
  }

  private isIdent(t: Token = this.tok, name?: string): boolean {
    return t.kind === 'ident' && (name === undefined || t.text === name);
  }

  private next(): Token {
    const t = this.tok;
    if (t.kind !== 'eof') this.pos++;
    return t;
  }

  private eat(text: string): Token | undefined {
    return this.is(text) ? this.next() : undefined;
  }

  /** End offset of the last consumed token. */
  private get prevEnd(): number {
    return this.pos > 0 ? this.toks[this.pos - 1].end : 0;
  }

  private error(message: string, at: Span = this.errorSpan()): void {
    if (this.strict) throw MISMATCH;
    // One error per position: cascades after the first are noise.
    if (this.errors.some((e) => e.start === at.start)) return;
    this.errors.push({ start: at.start, end: at.end, message });
  }

  private errorSpan(): Span {
    const t = this.tok;
    if (t.kind === 'eof') return { start: this.prevEnd, end: this.prevEnd };
    return { start: t.start, end: t.end };
  }

  private expect(text: string): Token | undefined {
    const t = this.eat(text);
    if (!t) this.error(`'${text}' expected.`, this.tok.kind === 'eof' || this.pos === 0 ? this.errorSpan() : { start: this.prevEnd, end: this.prevEnd });
    return t;
  }

  expectEnd(): void {
    if (!this.atEnd()) this.error(`Unexpected '${this.code.slice(this.tok.start, this.tok.end)}'.`, { start: this.tok.start, end: this.code.length });
  }

  /** Runs `f` speculatively: on a mismatch, restores the position and returns undefined. */
  private attempt<T>(f: () => T): T | undefined {
    const save = this.pos;
    const errs = this.errors.length;
    this.strict++;
    try {
      return f();
    } catch (e) {
      if (e !== MISMATCH) throw e;
      this.pos = save;
      this.errors.length = errs;
      return undefined;
    } finally {
      this.strict--;
    }
  }

  private missing(): Expr {
    const at = this.tok.kind === 'eof' ? this.prevEnd : this.tok.start;
    return { kind: 'missing', start: at, end: at };
  }

  // ---- types --------------------------------------------------------------------------------

  type(allowArray = true): TypeNode {
    const start = this.tok.start;
    let t: TypeNode;
    if (this.tok.kind === 'keyword' && PREDEFINED_TYPES[this.tok.text] !== undefined) {
      const k = this.next();
      t = { kind: 'predefined', keyword: k.text, start: k.start, end: k.end };
    } else if (this.is('(')) {
      this.next();
      const elements: { type: TypeNode; name?: string }[] = [];
      do {
        const type = this.type();
        const name = this.isIdent() ? this.next().text : undefined;
        elements.push({ type, name });
      } while (this.eat(','));
      this.expect(')');
      if (elements.length < 2) this.error('Tuple types need at least two elements.', { start, end: this.prevEnd });
      t = { kind: 'tuple', elements, start, end: this.prevEnd };
    } else if (this.isIdent()) {
      t = this.namedType();
    } else {
      this.error('Type expected.');
      const at = this.tok.kind === 'eof' ? this.prevEnd : this.tok.start;
      return { kind: 'named', parts: [{ name: '', start: at, end: at }], start: at, end: at };
    }
    for (;;) {
      if (this.is('?') && !this.strictNullableAmbiguity()) {
        this.next();
        t = { kind: 'nullable', element: t, start, end: this.prevEnd };
      } else if (allowArray && this.is('[') && (this.is(']', this.peek()) || this.is(',', this.peek()))) {
        const ranks: number[] = [];
        while (this.is('[') && (this.is(']', this.peek()) || this.is(',', this.peek()))) {
          this.next();
          let rank = 1;
          while (this.eat(',')) rank++;
          this.expect(']');
          ranks.push(rank);
        }
        t = { kind: 'array', element: t, ranks, start, end: this.prevEnd };
      } else break;
    }
    return t;
  }

  /** In `a is T ? x : y`, the `?` is the conditional operator. Only matters in strict mode. */
  private strictNullableAmbiguity(): boolean {
    if (!this.strict) return false;
    const n = this.peek();
    return n.kind !== 'eof' && !this.is('[', n) && !this.is(')', n) && !this.is(',', n) && !this.is('>', n) && !this.is('=>', n) && !this.isIdent(n) && !this.is(';', n);
  }

  private namedType(): TypeNode {
    const start = this.tok.start;
    let global = false;
    if (this.isIdent(this.tok, 'global') && this.is('::', this.peek())) {
      this.next();
      this.next();
      global = true;
    }
    const parts: NamePart[] = [];
    do {
      if (!this.isIdent()) {
        this.error('Identifier expected.');
        const at = this.tok.kind === 'eof' ? this.prevEnd : this.tok.start;
        parts.push({ name: '', start: at, end: at });
        break;
      }
      const id = this.next();
      const part: NamePart = { name: id.text, start: id.start, end: id.end };
      if (this.is('<')) part.typeArgs = this.typeArgs();
      parts.push(part);
    } while (this.eat('.'));
    return { kind: 'named', parts, global, start, end: this.prevEnd };
  }

  private typeArgs(): TypeNode[] {
    this.expect('<');
    const args: TypeNode[] = [];
    if (this.is('>')) {
      this.error('Type expected.'); // unbound generic names (typeof(List<>)) aren't supported
    } else {
      do args.push(this.type());
      while (this.eat(','));
    }
    this.expect('>');
    return args;
  }

  /** Type arguments after a name in an expression, if this `<` really starts them. */
  private typeArgsInExpression(): TypeNode[] | undefined {
    return this.attempt(() => {
      const args = this.typeArgs();
      const t = this.tok;
      if (t.kind === 'eof' || ((t.kind === 'punct' || t.kind === 'keyword') && AFTER_TYPE_ARGS.has(t.text))) return args;
      throw MISMATCH;
    });
  }

  // ---- expressions --------------------------------------------------------------------------

  expression(): Expr {
    if (this.isLambdaStart()) return this.lambda();
    const left = this.conditional();
    const op = this.assignmentOp();
    if (op) {
      if (left.kind === 'missing') this.error('Expression expected.');
      for (let i = 0; i < op.tokens; i++) this.next();
      const right = this.expression();
      return { kind: 'assign', op: op.text, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private assignmentOp(): { text: string; tokens: number } | undefined {
    const t = this.tok;
    if (t.kind !== 'punct') return undefined;
    // `>>=` lexes as `>` `>=`.
    if (t.text === '>' && this.is('>=', this.peek()) && this.peek().start === t.end) return { text: '>>=', tokens: 2 };
    return ASSIGNMENT.has(t.text) ? { text: t.text, tokens: 1 } : undefined;
  }

  private isLambdaStart(): boolean {
    if (this.isIdent() && this.is('=>', this.peek())) return true;
    if (!this.is('(')) return false;
    let depth = 0;
    for (let k = this.pos; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.kind === 'eof') return false;
      if (this.is('(', t)) depth++;
      else if (this.is(')', t)) {
        if (--depth === 0) return this.is('=>', this.toks[k + 1]);
      } else if (t.kind === 'punct' && !['<', '>', ',', '.', '[', ']', '?', '::'].includes(t.text)) return false;
    }
    return false;
  }

  private lambda(): Expr {
    const start = this.tok.start;
    const params: LambdaParam[] = [];
    if (this.isIdent()) {
      const id = this.next();
      params.push({ name: id.text, start: id.start, end: id.end });
    } else {
      this.expect('(');
      if (!this.is(')')) {
        do {
          const pStart = this.tok.start;
          const modifier = this.is('out') || this.is('ref') || this.is('in') ? (this.next().text as LambdaParam['modifier']) : undefined;
          if (this.isIdent() && (this.is(',', this.peek()) || this.is(')', this.peek()))) {
            const id = this.next();
            params.push({ name: id.text, start: id.start, end: id.end, modifier });
          } else {
            const type = this.type();
            const id = this.isIdent() ? this.next() : undefined;
            if (!id) this.error('Identifier expected.');
            params.push({ name: id?.text ?? '', type, start: pStart, end: this.prevEnd, modifier });
          }
        } while (this.eat(','));
      }
      this.expect(')');
    }
    const arrow = this.tok.start;
    this.expect('=>');
    const body = this.is('{') ? this.block() : this.expression();
    return { kind: 'lambda', params, body, arrow, start, end: body.end };
  }

  private conditional(): Expr {
    const condition = this.coalesce();
    if (!this.is('?')) return condition;
    this.next();
    const whenTrue = this.expression();
    this.expect(':');
    const whenFalse = this.expression();
    return { kind: 'conditional', condition, whenTrue, whenFalse, start: condition.start, end: whenFalse.end };
  }

  private coalesce(): Expr {
    const left = this.binary(0);
    if (!this.is('??')) return left;
    this.next();
    const right = this.is('throw') ? this.unary() : this.coalesce();
    return { kind: 'binary', op: '??', left, right, start: left.start, end: right.end };
  }

  /** The binary operator at the cursor: `>>` is two adjacent `>` tokens. */
  private binaryOp(): { text: string; tokens: number } | undefined {
    const t = this.tok;
    if (t.kind === 'keyword' && (t.text === 'is' || t.text === 'as')) return { text: t.text, tokens: 1 };
    if (t.kind !== 'punct') return undefined;
    if (t.text === '>' && this.is('>', this.peek()) && this.peek().start === t.end) {
      const third = this.peek(2);
      if ((this.is('=', third) || this.is('>=', third)) && third.start === this.peek().end) return undefined;
      return { text: '>>', tokens: 2 };
    }
    if (t.text === '>' && this.is('>=', this.peek()) && this.peek().start === t.end) return undefined; // >>=
    return { text: t.text, tokens: 1 };
  }

  private binary(level: number): Expr {
    if (level >= BINARY_LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const op = this.binaryOp();
      if (!op || !BINARY_LEVELS[level].includes(op.text)) return left;
      for (let i = 0; i < op.tokens; i++) this.next();
      if (op.text === 'is') {
        left = this.isPattern(left);
      } else if (op.text === 'as') {
        const type = this.type();
        left = { kind: 'as', operand: left, type, start: left.start, end: type.end };
      } else {
        const right = this.binary(level + 1);
        if (right.kind === 'missing') this.error('Expression expected.');
        left = { kind: 'binary', op: op.text, left, right, start: left.start, end: right.end };
      }
    }
  }

  private isPattern(operand: Expr): Expr {
    const t = this.tok;
    const constant = t.kind === 'number' || t.kind === 'string' || t.kind === 'char' || this.is('null') || this.is('true') || this.is('false') || this.is('-');
    if (!constant) {
      if (this.isIdent(t, 'var') && this.isIdent(this.peek())) {
        const v = this.next();
        const d = this.next();
        return { kind: 'is', operand, type: { kind: 'var', start: v.start, end: v.end }, designation: { name: d.text, start: d.start, end: d.end }, start: operand.start, end: d.end };
      }
      const type = this.attempt(() => this.type()) ?? this.type();
      let designation: Designation | undefined;
      if (this.isIdent() && !this.isIdent(this.tok, 'when')) {
        const d = this.next();
        designation = { name: d.text, start: d.start, end: d.end };
      }
      return { kind: 'is', operand, type, designation, start: operand.start, end: this.prevEnd };
    }
    const pattern = this.binary(7); // shift level and tighter
    return { kind: 'is', operand, pattern, start: operand.start, end: pattern.end };
  }

  private unary(): Expr {
    const t = this.tok;
    if (t.kind === 'punct' && ['!', '-', '+', '~', '++', '--'].includes(t.text)) {
      this.next();
      const operand = this.unary();
      if (operand.kind === 'missing') this.error('Expression expected.');
      return { kind: 'unary', op: t.text, operand, postfix: false, start: t.start, end: operand.end };
    }
    if (this.is('throw')) {
      this.next();
      const operand = this.expression();
      return { kind: 'throw', operand, start: t.start, end: operand.end };
    }
    if (this.is('(')) {
      const cast = this.attempt(() => {
        this.next();
        const type = this.type();
        if (!this.is(')')) throw MISMATCH;
        this.next();
        if (!this.startsCastOperand(type)) throw MISMATCH;
        return type;
      });
      if (cast) {
        const operand = this.unary();
        return { kind: 'cast', type: cast, operand, start: t.start, end: operand.end };
      }
    }
    return this.postfix(this.primary());
  }

  private startsCastOperand(type: TypeNode): boolean {
    let inner = type;
    while (inner.kind === 'nullable' || inner.kind === 'array') inner = inner.element;
    const t = this.tok;
    if (inner.kind === 'predefined') return t.kind !== 'eof' && !(t.kind === 'punct' && [')', ']', '}', ',', ';', '.', '?', ':', '=', '=>'].includes(t.text));
    if (t.kind === 'ident' || t.kind === 'number' || t.kind === 'string' || t.kind === 'char' || t.kind === 'interp' || t.kind === 'namedValue') return true;
    if (t.kind === 'keyword') return OPERAND_KEYWORDS.has(t.text);
    return t.kind === 'punct' && ['(', '!', '~'].includes(t.text);
  }

  private primary(): Expr {
    const t = this.tok;
    switch (t.kind) {
      case 'number':
        this.next();
        return { kind: 'literal', literal: t.numberKind ?? 'int', text: t.text, start: t.start, end: t.end };
      case 'string':
        this.next();
        return { kind: 'literal', literal: 'string', text: t.text, start: t.start, end: t.end };
      case 'char':
        this.next();
        return { kind: 'literal', literal: 'char', text: t.text, start: t.start, end: t.end };
      case 'interp': {
        this.next();
        const holes = (t.holes ?? []).map((h) => {
          const sub = new Parser(this.code, h.tokens);
          const e = sub.expression();
          sub.expectEnd();
          for (const err of sub.errors) this.errors.push(err);
          return e;
        });
        return { kind: 'interp', holes, start: t.start, end: t.end };
      }
      case 'namedValue':
        this.next();
        return { kind: 'namedValue', name: t.text, start: t.start, end: t.end };
      case 'ident': {
        if (t.text === 'global' && this.is('::', this.peek())) {
          this.next();
          this.next();
          const id = this.isIdent() ? this.next() : undefined;
          if (!id) this.error('Identifier expected.');
          return { kind: 'name', name: `global::${id?.text ?? ''}`, start: t.start, end: this.prevEnd };
        }
        if (t.text === 'nameof' && this.is('(', this.peek())) {
          this.next();
          this.next();
          const inner = this.expression();
          this.expect(')');
          return { kind: 'nameof', inner, start: t.start, end: this.prevEnd };
        }
        this.next();
        const typeArgs = this.is('<') ? this.typeArgsInExpression() : undefined;
        return { kind: 'name', name: t.text, typeArgs, start: t.start, end: this.prevEnd };
      }
      case 'keyword':
        return this.keywordPrimary(t);
      case 'punct':
        if (t.text === '(') return this.parenOrTuple();
        break;
    }
    this.error('Expression expected.');
    return this.missing();
  }

  private keywordPrimary(t: Token): Expr {
    if (PREDEFINED_TYPES[t.text] !== undefined) {
      this.next();
      return { kind: 'predefined', keyword: t.text, start: t.start, end: t.end };
    }
    switch (t.text) {
      case 'true':
      case 'false':
        this.next();
        return { kind: 'literal', literal: 'bool', text: t.text, start: t.start, end: t.end };
      case 'null':
        this.next();
        return { kind: 'literal', literal: 'null', text: t.text, start: t.start, end: t.end };
      case 'this':
      case 'base':
        this.next();
        return { kind: 'name', name: t.text, start: t.start, end: t.end };
      case 'new':
        return this.newExpression();
      case 'typeof': {
        this.next();
        this.expect('(');
        const type = this.type();
        this.expect(')');
        return { kind: 'typeof', type, start: t.start, end: this.prevEnd };
      }
      case 'default': {
        this.next();
        if (!this.is('(')) return { kind: 'default', start: t.start, end: t.end };
        this.next();
        const type = this.type();
        this.expect(')');
        return { kind: 'default', type, start: t.start, end: this.prevEnd };
      }
      case 'checked':
      case 'unchecked': {
        this.next();
        this.expect('(');
        const inner = this.expression();
        this.expect(')');
        return { kind: 'checked', inner, start: t.start, end: this.prevEnd };
      }
    }
    this.error(`Unexpected keyword '${t.text}'.`);
    this.next();
    return { kind: 'missing', start: t.start, end: t.end };
  }

  private parenOrTuple(): Expr {
    const open = this.next();
    const first = this.tupleItem();
    if (!this.is(',')) {
      this.expect(')');
      return { kind: 'paren', inner: first.value, start: open.start, end: this.prevEnd };
    }
    const items = [first];
    while (this.eat(',')) items.push(this.tupleItem());
    this.expect(')');
    return { kind: 'tuple', items, start: open.start, end: this.prevEnd };
  }

  private tupleItem(): { name?: string; value: Expr } {
    if (this.isIdent() && this.is(':', this.peek())) {
      const name = this.next().text;
      this.next();
      return { name, value: this.expression() };
    }
    return { value: this.expression() };
  }

  private newExpression(): Expr {
    const start = this.next().start;
    // new { A = 1, B }
    if (this.is('{')) {
      this.next();
      const anonymous: { name: string; nameSpan: Span; value: Expr }[] = [];
      while (!this.is('}') && !this.atEnd()) {
        const before = this.pos;
        if (this.isIdent() && this.is('=', this.peek())) {
          const id = this.next();
          this.next();
          anonymous.push({ name: id.text, nameSpan: { start: id.start, end: id.end }, value: this.expression() });
        } else {
          const value = this.expression();
          const name = value.kind === 'name' ? value.name : value.kind === 'member' ? value.name : '';
          const nameSpan = value.kind === 'member' ? value.nameSpan : { start: value.start, end: value.end };
          if (!name) this.error('Invalid anonymous type member declarator.', value);
          anonymous.push({ name, nameSpan, value });
        }
        if (!this.eat(',')) break;
        if (this.pos === before) break;
      }
      this.expect('}');
      return { kind: 'new', anonymous, start, end: this.prevEnd };
    }
    // new[] { ... }
    if (this.is('[') && (this.is(']', this.peek()) || this.is(',', this.peek()))) {
      this.next();
      while (this.eat(','));
      this.expect(']');
      const arrayInit = this.arrayInitializer();
      return { kind: 'new', arrayRanks: [1], arrayInit, start, end: this.prevEnd };
    }
    const type = this.type(false);
    // new T[n] or new T[] { ... }
    if (this.is('[')) {
      this.next();
      const arraySizes: Expr[] = [];
      const ranks: number[] = [];
      if (!this.is(']') && !this.is(',')) {
        do arraySizes.push(this.expression());
        while (this.eat(','));
        ranks.push(arraySizes.length);
      } else {
        let rank = 1;
        while (this.eat(',')) rank++;
        ranks.push(rank);
      }
      this.expect(']');
      while (this.is('[') && (this.is(']', this.peek()) || this.is(',', this.peek()))) {
        this.next();
        let rank = 1;
        while (this.eat(',')) rank++;
        this.expect(']');
        ranks.push(rank);
      }
      const arrayInit = this.is('{') ? this.arrayInitializer() : undefined;
      if (arraySizes.length === 0 && !arrayInit) this.error('Array creation must have an array size or an initializer.', { start, end: this.prevEnd });
      return { kind: 'new', type, arrayRanks: ranks, arraySizes, arrayInit, start, end: this.prevEnd };
    }
    let args: ArgumentList | undefined;
    if (this.is('(')) args = this.argumentList(')');
    let init: Initializer | undefined;
    if (this.is('{')) init = this.initializer();
    if (!args && !init) this.error("'(' expected.", { start: this.prevEnd, end: this.prevEnd });
    return { kind: 'new', type, args, init, start, end: this.prevEnd };
  }

  private arrayInitializer(): Expr[] {
    this.expect('{');
    const items: Expr[] = [];
    while (!this.is('}') && !this.atEnd()) {
      items.push(this.is('{') ? this.nestedArrayInit() : this.expression());
      if (!this.eat(',')) break;
    }
    this.expect('}');
    return items;
  }

  private nestedArrayInit(): Expr {
    const start = this.tok.start;
    const items = this.arrayInitializer();
    return { kind: 'arrayInit', items, start, end: this.prevEnd };
  }

  private initializer(): Initializer {
    const start = this.next().start;
    const members: Initializer['members'] = [];
    let kind: Initializer['kind'] | undefined;
    while (!this.is('}') && !this.atEnd()) {
      if (this.isIdent() && this.is('=', this.peek())) {
        kind ??= 'object';
        const id = this.next();
        this.next();
        const value = this.is('{') ? this.nestedArrayInit() : this.expression();
        members.push({ name: id.text, nameSpan: { start: id.start, end: id.end }, value });
      } else if (this.is('[')) {
        // Index initializer: [key] = value
        kind ??= 'object';
        const args = this.argumentList(']');
        this.expect('=');
        const value = this.expression();
        members.push({ value: { kind: 'tuple', items: [...args.args.map((a) => ({ value: a.value })), { value }], start: args.start, end: value.end } });
      } else {
        kind ??= 'collection';
        members.push({ value: this.is('{') ? this.nestedArrayInit() : this.expression() });
      }
      if (!this.eat(',')) break;
    }
    this.expect('}');
    return { kind: kind ?? 'object', members, start, end: this.prevEnd };
  }

  private postfix(expr: Expr): Expr {
    for (;;) {
      const t = this.tok;
      if (this.is('.') || this.is('?.')) {
        this.next();
        expr = this.memberAccess(expr, t.text === '?.');
      } else if (this.is('?') && this.is('[', this.peek()) && this.peek().start === t.end) {
        this.next();
        const args = this.argumentList(']');
        expr = { kind: 'index', target: expr, args, conditional: true, start: expr.start, end: this.prevEnd };
      } else if (this.is('::') && expr.kind === 'name') {
        this.next();
        expr = this.memberAccess(expr, false);
      } else if (this.is('(')) {
        const args = this.argumentList(')');
        expr = { kind: 'call', target: expr, args, start: expr.start, end: this.prevEnd };
      } else if (this.is('[')) {
        const args = this.argumentList(']');
        expr = { kind: 'index', target: expr, args, conditional: false, start: expr.start, end: this.prevEnd };
      } else if (this.is('++') || this.is('--')) {
        this.next();
        expr = { kind: 'unary', op: t.text, operand: expr, postfix: true, start: expr.start, end: t.end };
      } else {
        return expr;
      }
    }
  }

  private memberAccess(target: Expr, conditional: boolean): Expr {
    if (!this.isIdent()) {
      // Keep going with an empty name: `context.Request.` is exactly what completion asks about.
      this.error('Identifier expected.', { start: this.prevEnd, end: this.prevEnd });
      const at = this.prevEnd;
      return { kind: 'member', target, name: '', nameSpan: { start: at, end: at }, conditional, start: target.start, end: at };
    }
    const id = this.next();
    const typeArgs = this.is('<') ? this.typeArgsInExpression() : undefined;
    return { kind: 'member', target, name: id.text, nameSpan: { start: id.start, end: id.end }, typeArgs, conditional, start: target.start, end: this.prevEnd };
  }

  private argumentList(close: string): ArgumentList {
    const o = this.next();
    const args: Argument[] = [];
    const commas: number[] = [];
    let closeAt: number | undefined;
    if (this.is(close)) {
      closeAt = this.next().start;
      return { args, commas, open: o.start, close: closeAt, start: o.start, end: this.prevEnd };
    }
    for (;;) {
      args.push(this.argument());
      const comma = this.eat(',');
      if (!comma) break;
      commas.push(comma.start);
    }
    const c = this.expect(close);
    closeAt = c?.start;
    return { args, commas, open: o.start, close: closeAt, start: o.start, end: this.prevEnd };
  }

  private argument(): Argument {
    const start = this.tok.start;
    let name: string | undefined;
    if (this.isIdent() && this.is(':', this.peek()) && !this.is('::', this.peek())) {
      name = this.next().text;
      this.next();
    }
    let modifier: Argument['modifier'];
    if (this.is('out') || this.is('ref') || this.is('in')) modifier = this.next().text as Argument['modifier'];
    if (modifier === 'out') {
      // out var x / out T x
      const decl = this.attempt(() => {
        const tStart = this.tok.start;
        const type: TypeNode = this.isIdent(this.tok, 'var') && this.isIdent(this.peek()) ? { kind: 'var', start: tStart, end: this.next().end } : this.type();
        if (!this.isIdent()) throw MISMATCH;
        const d = this.next();
        return { kind: 'declaration' as const, type, designation: { name: d.text, start: d.start, end: d.end }, start: tStart, end: d.end };
      });
      if (decl) return { name, modifier, value: decl, start, end: decl.end };
    }
    const value = this.expression();
    if (value.kind === 'missing' && !name && !modifier) {
      // `f(a, )`: report once, at the gap.
      this.error('Expression expected.');
    }
    return { name, modifier, value, start, end: Math.max(value.end, this.prevEnd) };
  }

  // ---- statements ---------------------------------------------------------------------------

  statementList(done: () => boolean): Stmt[] {
    const out: Stmt[] = [];
    while (!done() && !this.atEnd()) {
      const before = this.pos;
      out.push(this.statement());
      if (this.pos === before) {
        const t = this.next();
        this.error(`Unexpected '${this.code.slice(t.start, t.end)}'.`, t);
      }
    }
    return out;
  }

  block(): Block {
    const start = this.tok.start;
    this.expect('{');
    const statements = this.statementList(() => this.is('}'));
    this.expect('}');
    return { kind: 'block', statements, start, end: this.prevEnd };
  }

  private statement(): Stmt {
    const t = this.tok;
    if (this.is('{')) return this.block();
    if (this.is(';')) {
      this.next();
      return { kind: 'empty', start: t.start, end: t.end };
    }
    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'if':
          return this.ifStatement();
        case 'return': {
          this.next();
          const value = this.is(';') ? undefined : this.expression();
          this.expect(';');
          return { kind: 'return', value, start: t.start, end: this.prevEnd };
        }
        case 'throw': {
          this.next();
          const value = this.is(';') ? undefined : this.expression();
          this.expect(';');
          return { kind: 'throw', value, start: t.start, end: this.prevEnd };
        }
        case 'break':
        case 'continue':
          this.next();
          this.expect(';');
          return { kind: t.text, start: t.start, end: this.prevEnd };
        case 'foreach':
          return this.foreachStatement();
        case 'for':
          return this.forStatement();
        case 'while': {
          this.next();
          this.expect('(');
          const condition = this.expression();
          this.expect(')');
          const body = this.embedded();
          return { kind: 'while', condition, body, start: t.start, end: body.end };
        }
        case 'do': {
          this.next();
          const body = this.embedded();
          this.expect('while');
          this.expect('(');
          const condition = this.expression();
          this.expect(')');
          this.expect(';');
          return { kind: 'do', body, condition, start: t.start, end: this.prevEnd };
        }
        case 'switch':
          return this.switchStatement();
        case 'try':
          return this.tryStatement();
        case 'using':
        case 'lock': {
          this.next();
          this.expect('(');
          const resource: Stmt = t.text === 'using' ? (this.localDeclaration(false) ?? this.exprStatementNoSemicolon()) : this.exprStatementNoSemicolon();
          this.expect(')');
          const body = this.embedded();
          if (t.text === 'lock') return { kind: 'lock', value: (resource as { expr: Expr }).expr, body, start: t.start, end: body.end };
          return { kind: 'using', resource, body, start: t.start, end: body.end };
        }
        case 'const': {
          this.next();
          const decl = this.localDeclaration(true);
          if (decl) return { ...decl, isConst: true, start: t.start };
          break;
        }
      }
    }
    const local = this.localDeclaration(true);
    if (local) return local;
    const expr = this.expression();
    if (expr.kind === 'missing') {
      this.error('Statement expected.');
      return { kind: 'expr', expr, start: expr.start, end: expr.end };
    }
    this.expect(';');
    return { kind: 'expr', expr, start: expr.start, end: this.prevEnd };
  }

  private exprStatementNoSemicolon(): Stmt {
    const expr = this.expression();
    return { kind: 'expr', expr, start: expr.start, end: expr.end };
  }

  /** `T a = 1, b;` if one starts here. */
  private localDeclaration(withSemicolon: boolean): (Stmt & { kind: 'local' }) | undefined {
    const start = this.tok.start;
    const type = this.attempt(() => {
      if (this.isIdent(this.tok, 'var') && this.isIdent(this.peek())) {
        const v = this.next();
        return { kind: 'var', start: v.start, end: v.end } as TypeNode;
      }
      const ty = this.type();
      if (!this.isIdent()) throw MISMATCH;
      // `a b` is never an expression, but `x => ...` is. `a b c` is a half-typed statement
      // followed by the next one (`a` then `var c = ...`), not a declaration of `b`.
      if (this.is('=>', this.peek()) || this.isIdent(this.peek())) throw MISMATCH;
      return ty;
    });
    if (!type) return undefined;
    const declarators: Declarator[] = [];
    do {
      const id = this.isIdent() ? this.next() : undefined;
      if (!id) {
        this.error('Identifier expected.');
        break;
      }
      let init: Expr | undefined;
      if (this.eat('=')) init = this.is('{') ? this.nestedArrayInit() : this.expression();
      declarators.push({ name: id.text, nameSpan: { start: id.start, end: id.end }, init, start: id.start, end: this.prevEnd });
    } while (this.eat(','));
    if (withSemicolon) this.expect(';');
    return { kind: 'local', type, declarators, isConst: false, start, end: this.prevEnd };
  }

  /** A statement in an embedded position (an if branch, a loop body). */
  private embedded(): Stmt {
    if (this.atEnd() || this.is('}')) {
      this.error('Statement expected.');
      const at = this.prevEnd;
      return { kind: 'empty', start: at, end: at };
    }
    return this.statement();
  }

  private ifStatement(): Stmt {
    const start = this.next().start;
    this.expect('(');
    const condition = this.expression();
    this.expect(')');
    const then = this.embedded();
    let otherwise: Stmt | undefined;
    if (this.eat('else')) otherwise = this.embedded();
    return { kind: 'if', condition, then, else: otherwise, start, end: this.prevEnd };
  }

  private foreachStatement(): Stmt {
    const start = this.next().start;
    this.expect('(');
    const tStart = this.tok.start;
    const type: TypeNode = this.isIdent(this.tok, 'var') && this.isIdent(this.peek()) ? { kind: 'var', start: tStart, end: this.next().end } : this.type();
    const id = this.isIdent() ? this.next() : undefined;
    if (!id) this.error('Identifier expected.');
    const designation = { name: id?.text ?? '', start: id?.start ?? this.prevEnd, end: id?.end ?? this.prevEnd };
    this.expect('in');
    const collection = this.expression();
    this.expect(')');
    const body = this.embedded();
    return { kind: 'foreach', type, designation, collection, body, start, end: body.end };
  }

  private forStatement(): Stmt {
    const start = this.next().start;
    this.expect('(');
    const init: Stmt[] = [];
    if (!this.is(';')) {
      const decl = this.localDeclaration(false);
      if (decl) init.push(decl);
      else
        do init.push(this.exprStatementNoSemicolon());
        while (this.eat(','));
    }
    this.expect(';');
    const condition = this.is(';') ? undefined : this.expression();
    this.expect(';');
    const iterators: Expr[] = [];
    if (!this.is(')')) {
      do iterators.push(this.expression());
      while (this.eat(','));
    }
    this.expect(')');
    const body = this.embedded();
    return { kind: 'for', init, condition, iterators, body, start, end: body.end };
  }

  private switchStatement(): Stmt {
    const start = this.next().start;
    this.expect('(');
    const value = this.expression();
    this.expect(')');
    this.expect('{');
    const sections: SwitchSection[] = [];
    while (!this.is('}') && !this.atEnd()) {
      const sStart = this.tok.start;
      const labels: SwitchSection['labels'] = [];
      while (this.is('case') || this.is('default')) {
        if (this.next().text === 'default') {
          labels.push({ kind: 'default' });
        } else {
          labels.push(this.caseLabel());
        }
        this.expect(':');
      }
      if (labels.length === 0) {
        this.error("'case' or 'default' expected.");
        this.next();
        continue;
      }
      const statements = this.statementList(() => this.is('case') || this.is('default') || this.is('}'));
      sections.push({ labels, statements, start: sStart, end: this.prevEnd });
    }
    this.expect('}');
    return { kind: 'switch', value, sections, start, end: this.prevEnd };
  }

  private caseLabel(): SwitchSection['labels'][number] {
    const typed = this.attempt(() => {
      const tStart = this.tok.start;
      const type: TypeNode = this.isIdent(this.tok, 'var') ? { kind: 'var', start: tStart, end: this.next().end } : this.type();
      if (!this.isIdent() || this.isIdent(this.tok, 'when')) throw MISMATCH;
      const d = this.next();
      return { type, designation: { name: d.text, start: d.start, end: d.end } };
    });
    let label: SwitchSection['labels'][number];
    if (typed) label = { kind: 'case', ...typed };
    else label = { kind: 'case', value: this.coalesce() };
    if (this.isIdent(this.tok, 'when')) {
      this.next();
      label.when = this.expression();
    }
    return label;
  }

  private tryStatement(): Stmt {
    const start = this.next().start;
    const block = this.block();
    const catches: CatchClause[] = [];
    while (this.is('catch')) {
      const cStart = this.next().start;
      let type: TypeNode | undefined;
      let designation: Designation | undefined;
      if (this.eat('(')) {
        type = this.type();
        if (this.isIdent()) {
          const d = this.next();
          designation = { name: d.text, start: d.start, end: d.end };
        }
        this.expect(')');
      }
      let filter: Expr | undefined;
      if (this.isIdent(this.tok, 'when')) {
        this.next();
        this.expect('(');
        filter = this.expression();
        this.expect(')');
      }
      const body = this.block();
      catches.push({ type, designation, filter, block: body, start: cStart, end: body.end });
    }
    const fin = this.eat('finally') ? this.block() : undefined;
    if (catches.length === 0 && !fin) this.error("'catch' or 'finally' expected.", { start: this.prevEnd, end: this.prevEnd });
    return { kind: 'try', block, catches, finally: fin, start, end: this.prevEnd };
  }
}

export type { LiteralKind };

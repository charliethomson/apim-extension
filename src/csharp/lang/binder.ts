/**
 * Binds a parsed expression or block against the type model: resolves names, members, overloads,
 * generic type arguments and lambda parameter types, and works out the type of every expression.
 *
 * Binding is driven by one optional probe offset. As the binder passes the probe it records what
 * completion, hover and signature help need there, so one walk answers any of them. Everything
 * the model can't see (a member it doesn't know, say) becomes the unknown type, which converts to
 * anything: gaps in the model never turn into errors, they just stop inference.
 */

import { isJArray, isJObject, literalKey, NO_SHAPES, shapeOf, tokenShape, withShape, type JsonShape, type ShapeEnv } from './json';
import { PREDEFINED_TYPES } from './lexer';
import { byName, mentions, NULL, sameType, substitute, UNKNOWN, type MemberDef, type Subst, type Type, type TypeDef, type TypeModel } from './model';
import type { Parsed } from './parser';
import type { Argument, ArgumentList, Block, Expr, FromClause, LocalFunction, QueryBody, Span, Stmt, TypeNode } from './syntax';
import type { TypeRef } from './model';

export interface Local {
  name: string;
  type: Type;
  /** Declaration span; undefined for `context`. */
  decl?: Span;
  kind: 'local' | 'parameter' | 'context' | 'function' | 'range';
  /** A local function's signature. */
  fn?: MemberDef;
}

/** Declaring type for local functions, which have no real one. */
const LOCAL_FUNCTIONS: TypeDef = { key: '<local>', name: '<local>', namespace: '', kind: 'class', typeParams: [], variance: [], isStatic: true, isAbstract: false, interfaces: [], members: [], origin: 'stub' };

export type BoundSymbol =
  | { kind: 'local'; local: Local }
  | { kind: 'member'; member: MemberDef; subst: Subst; receiver?: Type }
  | { kind: 'type'; type: Type }
  | { kind: 'namespace'; name: string }
  /** A key of a JSON object with a known shape: `o["someData"]`, with its `@property` description. */
  | { kind: 'jsonKey'; name: string; type: Type; doc?: string };

/** What an expression binds to. */
export type Value =
  | { kind: 'value'; type: Type; symbol?: BoundSymbol }
  | { kind: 'type'; type: Type }
  | { kind: 'namespace'; name: string }
  | { kind: 'methods'; name: string; candidates: Candidate[]; receiver?: Type; typeArgs?: Type[]; extensionsOnly: boolean };

export interface Candidate {
  member: MemberDef;
  subst: Subst;
  /** An extension method called on a receiver, which becomes the first argument. */
  extension?: boolean;
}

export type CompletionSite =
  /** After `x.`: members of what `x` binds to. */
  | { kind: 'member'; receiver: Value; span: Span; conditional: boolean }
  /** A simple name: locals, types, namespaces and keywords. `typeOnly` after `new`, `is` and the like. */
  | { kind: 'name'; locals: Local[]; span: Span; typeOnly: boolean; expected?: Type }
  /** A member name in an object initializer. */
  | { kind: 'initializer'; type: Type; span: Span; assigned: string[] }
  /** Inside the string key of `o["…"]`, where `o` has a known shape. */
  | { kind: 'jsonKey'; shape: JsonShape & { kind: 'object' }; span: Span };

export interface HoverSite {
  span: Span;
  symbol: BoundSymbol;
  /** Type of the expression at the site, when it differs from the symbol's declared one. */
  type?: Type;
}

export interface SignatureSite {
  candidates: Candidate[];
  /** Index into `candidates` of the overload that resolution picked, if any. */
  active?: number;
  argIndex: number;
  /** Name of the argument at the cursor, for `name: value`. */
  argName?: string;
  span: Span;
}

export interface Reference {
  span: Span;
  def: TypeDef;
  /** Set for member references; undefined for a use of the type itself. */
  member?: MemberDef;
}

export interface BindDiagnostic extends Span {
  message: string;
  /**
   * `language-version`: valid C# newer than the 7.3 policy expressions accept.
   * `json-shape`: JSON built differently from the shape it's meant to have (a warning).
   */
  code?: 'language-version' | 'json-shape';
}

export interface BindResult {
  diagnostics: BindDiagnostic[];
  completion?: CompletionSite;
  hover?: HoverSite;
  signature?: SignatureSite;
  /** Types and members the code uses, for the allowlist. */
  references: Reference[];
  /** Type of the top-level expression (`@(...)`), or of the first `return` in a block. */
  resultType: Type;
  /** The innermost `new JObject` whose `new JObject` text holds the probe, with what it builds. */
  created?: { span: Span; type: Type };
}

interface ArgInfo {
  arg: Argument;
  /** Bound once up front, for everything except lambdas and `out` declarations. */
  value?: Value;
  type: Type;
  lambda?: Expr & { kind: 'lambda' };
  outDecl?: Expr & { kind: 'declaration' };
  literal?: 'int' | 'zero';
}

interface Resolution {
  candidate: Candidate;
  /** Full substitution, including the method's own type arguments. */
  subst: Subst;
  /** Parameter index for each argument (the receiver isn't an argument). */
  paramFor: number[];
  expanded: boolean;
  cost: number;
}

const COMPOUND_OPS: Record<string, string> = { '+': 'op_Addition', '-': 'op_Subtraction', '*': 'op_Multiply', '/': 'op_Division', '%': 'op_Modulus', '==': 'op_Equality', '!=': 'op_Inequality', '<': 'op_LessThan', '>': 'op_GreaterThan', '<=': 'op_LessThanOrEqual', '>=': 'op_GreaterThanOrEqual', '&': 'op_BitwiseAnd', '|': 'op_BitwiseOr', '^': 'op_ExclusiveOr' };

export class Binder {
  private readonly diagnostics: BindDiagnostic[] = [];
  private readonly references: Reference[] = [];
  private readonly scopes: Map<string, Local>[] = [];
  /** Return types seen by the innermost lambda (or the top-level block). */
  private readonly returns: Type[][] = [];
  /** Declared return type of the innermost local function, or undefined for lambdas and the top level. */
  private readonly returnTargets: (Type | undefined)[] = [];
  /** Type parameters of the local functions being bound. */
  private readonly typeParamScopes: Set<string>[] = [];
  private speculative = 0;
  private completion?: CompletionSite;
  private hover?: HoverSite;
  private signature?: SignatureSite;
  private created?: { span: Span; type: Type };
  /** The receiver type of each `x[…]` bound, so an assignment to it can add a key to x's shape. */
  private readonly indexReceivers = new WeakMap<Expr, Type>();
  /** The JSON shape a `new JObject` / `new JArray` is meant to have, from where its value goes. */
  private readonly wanted = new WeakMap<Expr, Type>();

  constructor(
    private readonly model: TypeModel,
    /** Offset completion, hover and signature help ask about. */
    private readonly probe = -1,
    /** What the policy needs the expression to produce, when it's known (a `condition` is bool). */
    private readonly expected?: Type,
    /** Shapes of the context variables, for `context.Variables["x"]`. */
    private readonly shapes: ShapeEnv = NO_SHAPES,
    /**
     * The JSON shape the expression's value should have: a `set-variable` whose variable has a
     * declared type. The JObjects and JArrays it builds are checked against it.
     */
    private readonly wantedShape?: Type,
  ) {}

  bind(parsed: Parsed): BindResult {
    const context = this.model.named('Apim.Policies.IProxyRequestContext');
    this.scopes.push(new Map([['context', { name: 'context', type: context, kind: 'context' }]]));
    let resultType: Type = UNKNOWN;
    if (parsed.kind === 'expr') {
      if (this.wantedShape) this.want(parsed.root, this.wantedShape);
      const v = this.expr(parsed.root, this.expected);
      if (this.expected) this.checkConversion(parsed.root, v, this.expected);
      resultType = this.typeOf(v);
    } else {
      this.returns.push([]);
      this.returnTargets.push(this.expected);
      this.block(parsed.root, false);
      this.returnTargets.pop();
      resultType = this.returns.pop()!.find((t) => t.k !== 'null' && t.k !== 'unknown') ?? UNKNOWN;
      // APIM requires every path through a block to end in a return.
      if (endReachable(parsed.root)) this.error({ start: parsed.root.end, end: parsed.root.end }, 'Not all code paths return a value. Every path through a policy expression block must end in a return.');
    }
    return { diagnostics: this.diagnostics, completion: this.completion, hover: this.hover, signature: this.signature, references: this.references, resultType, created: this.created };
  }

  // ---- recording ------------------------------------------------------------------------------

  private get recording(): boolean {
    return this.speculative === 0;
  }

  private error(span: Span, message: string, code?: BindDiagnostic['code']): void {
    if (!this.recording) return;
    if (this.diagnostics.some((d) => d.start === span.start && d.end === span.end)) return;
    this.diagnostics.push({ start: span.start, end: span.end, message, code });
  }

  private hits(span: Span): boolean {
    return this.probe >= span.start && this.probe <= span.end;
  }

  private recordHover(span: Span, symbol: BoundSymbol, type?: Type): void {
    if (!this.recording || !this.hits(span)) return;
    // The innermost (latest) hit wins; spans only nest.
    this.hover = { span, symbol, type };
  }

  private recordCompletion(site: CompletionSite): void {
    if (this.recording) this.completion = site;
  }

  private reference(span: Span, def: TypeDef, member?: MemberDef): void {
    if (this.recording) this.references.push({ span, def, member });
  }

  private speculate<T>(f: () => T): T {
    this.speculative++;
    try {
      return f();
    } finally {
      this.speculative--;
    }
  }

  // ---- scopes ---------------------------------------------------------------------------------

  private declare(local: Local): void {
    if (!local.name) return;
    const top = this.scopes[this.scopes.length - 1];
    if (local.decl && this.lookupLocal(local.name)?.kind === 'local') {
      this.error(local.decl, `A local variable named '${local.name}' is already defined in this scope.`);
    }
    top.set(local.name, local);
    if (local.decl) this.recordHover(local.decl, { kind: 'local', local });
  }

  private lookupLocal(name: string): Local | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const l = this.scopes[i].get(name);
      if (l) return l;
    }
    return undefined;
  }

  private visibleLocals(): Local[] {
    const out = new Map<string, Local>();
    for (const s of this.scopes) for (const [k, v] of s) out.set(k, v);
    return [...out.values()];
  }

  private withScope<T>(f: () => T): T {
    this.scopes.push(new Map());
    try {
      return f();
    } finally {
      this.scopes.pop();
    }
  }

  // ---- statements -----------------------------------------------------------------------------

  private block(b: Block, scoped = true): void {
    const run = () => {
      // Local functions can be called anywhere in their block, so declare them first.
      for (const s of b.statements) if (s.kind === 'localFunction') this.declareLocalFunction(s);
      for (const s of b.statements) this.stmt(s);
    };
    if (scoped) this.withScope(run);
    else run();
  }

  private stmt(s: Stmt): void {
    switch (s.kind) {
      case 'block':
        return this.block(s);
      case 'empty':
      case 'break':
      case 'continue':
        return;
      case 'localFunction':
        return this.localFunctionBody(s);
      case 'local': {
        const declared = s.type.kind === 'var' ? undefined : this.resolveType(s.type, false);
        for (const d of s.declarators) {
          let type = declared ?? UNKNOWN;
          if (d.init) {
            const v = d.init.kind === 'arrayInit' && declared ? this.arrayInit(d.init, declared) : this.expr(d.init, declared);
            if (declared && d.init.kind !== 'arrayInit') this.checkConversion(d.init, v, declared);
            if (!declared) {
              type = this.typeOf(v);
              if (type.k === 'null') this.error(d.nameSpan, "Cannot assign null to an implicitly-typed variable.");
              if (v.kind === 'methods') this.error(d.init, 'Cannot assign a method group to an implicitly-typed variable.');
            }
          } else if (!declared) {
            this.error(d.nameSpan, 'Implicitly-typed variables must be initialized.');
          }
          this.declare({ name: d.name, type, decl: d.nameSpan, kind: 'local' });
        }
        return;
      }
      case 'expr':
        this.expr(s.expr);
        return;
      case 'if':
        // Variables declared in an if condition stay in scope after the if (C# 7.3).
        this.condition(s.condition);
        this.withScope(() => this.stmt(s.then));
        if (s.else) {
          const otherwise = s.else;
          this.withScope(() => this.stmt(otherwise));
        }
        return;
      case 'return': {
        const target = this.returnTargets[this.returnTargets.length - 1];
        const isVoid = target?.k === 'named' && target.def.key === 'System.Void';
        // A top-level return in a block is the value the shape is wanted for.
        if (s.value && this.wantedShape && this.returns.length === 1) this.want(s.value, this.wantedShape);
        const v = s.value ? this.expr(s.value, target && !isVoid ? target : undefined) : undefined;
        const t = v ? this.typeOf(v) : this.model.named('System.Void');
        if (target && target.k !== 'unknown') {
          if (isVoid && s.value) this.error(s.value, 'This local function returns void, so return must not be followed by a value.');
          else if (!isVoid && !s.value) this.error(s, `A value convertible to '${this.model.display(target)}' is required.`);
          else if (s.value && v) this.checkConversion(s.value, v, target);
        }
        this.returns[this.returns.length - 1]?.push(t);
        return;
      }
      case 'throw':
        if (s.value) this.expr(s.value);
        return;
      case 'foreach':
        this.withScope(() => {
          const coll = this.typeOf(this.expr(s.collection));
          const element = this.elementOf(coll);
          const type = s.type.kind === 'var' ? element : this.resolveType(s.type);
          this.declare({ name: s.designation.name, type, decl: s.designation, kind: 'local' });
          this.stmt(s.body);
        });
        return;
      case 'for':
        this.withScope(() => {
          for (const i of s.init) this.stmt(i);
          if (s.condition) this.condition(s.condition);
          for (const i of s.iterators) this.expr(i);
          this.stmt(s.body);
        });
        return;
      case 'while':
        this.withScope(() => {
          this.condition(s.condition);
          this.stmt(s.body);
        });
        return;
      case 'do':
        this.withScope(() => this.stmt(s.body));
        this.withScope(() => this.condition(s.condition));
        return;
      case 'switch': {
        const t = this.typeOf(this.expr(s.value));
        for (const section of s.sections) {
          this.withScope(() => {
            for (const label of section.labels) {
              if (label.kind === 'default') continue;
              if (label.designation) {
                const type = !label.type || label.type.kind === 'var' ? t : this.resolveType(label.type);
                this.declare({ name: label.designation.name, type, decl: label.designation, kind: 'local' });
              }
              if (label.value) this.expr(label.value, t);
              if (label.when) this.expr(label.when, this.model.named('System.Boolean'));
            }
            for (const st of section.statements) this.stmt(st);
          });
        }
        return;
      }
      case 'try':
        this.block(s.block);
        for (const c of s.catches) {
          this.withScope(() => {
            const type = c.type ? this.resolveType(c.type) : this.model.named('System.Exception');
            if (c.designation) this.declare({ name: c.designation.name, type, decl: c.designation, kind: 'local' });
            if (c.filter) this.condition(c.filter);
            this.block(c.block);
          });
        }
        if (s.finally) this.block(s.finally);
        return;
      case 'using':
        this.withScope(() => {
          this.stmt(s.resource);
          this.stmt(s.body);
        });
        return;
      case 'lock':
        this.expr(s.value);
        this.stmt(s.body);
        return;
    }
  }

  /** Binds a condition, which must convert to bool. */
  private condition(e: Expr): void {
    const bool = this.model.named('System.Boolean');
    this.checkConversion(e, this.expr(e, bool), bool);
  }

  // ---- local functions ------------------------------------------------------------------------

  private declareLocalFunction(f: LocalFunction): void {
    const m = this.model;
    const typeParams = f.typeParams.map((p) => p.name);
    this.typeParamScopes.push(new Set(typeParams));
    const ret = this.resolveType(f.returnType);
    const params = f.params.map((p) => ({
      name: p.name,
      type: toRef(p.type ? this.resolveType(p.type) : UNKNOWN),
      modifier: p.isParams ? ('params' as const) : p.modifier,
      defaultText: p.defaultValue ? defaultText(p.defaultValue) : undefined,
    }));
    this.typeParamScopes.pop();
    const fn: MemberDef = { name: f.name, kind: 'method', isStatic: true, isExtension: false, typeParams, type: toRef(ret), params, declaring: LOCAL_FUNCTIONS };
    const local: Local = { name: f.name, type: m.named('System.Delegate'), decl: f.nameSpan, kind: 'function', fn };
    if (this.lookupLocal(f.name)?.kind === 'local') this.error(f.nameSpan, `A local variable named '${f.name}' is already defined in this scope.`);
    this.scopes[this.scopes.length - 1].set(f.name, local);
    this.recordHover(f.nameSpan, { kind: 'local', local });
  }

  private localFunctionBody(f: LocalFunction): void {
    const local = this.lookupLocal(f.name);
    const fn = local?.kind === 'function' ? local.fn : undefined;
    if (!fn) return;
    this.typeParamScopes.push(new Set(fn.typeParams));
    const ret = this.model.resolve(fn.type);
    // Re-resolve types so hover and completion inside the signature work.
    this.resolveType(f.returnType);
    this.withScope(() => {
      f.params.forEach((p, i) => {
        if (p.type) this.resolveType(p.type);
        if (p.defaultValue) this.expr(p.defaultValue);
        const type = this.model.resolve(fn.params[i].type);
        this.declare({ name: p.name, type, decl: { start: p.end - p.name.length, end: p.end }, kind: 'parameter' });
      });
      const isVoid = ret.k === 'named' && ret.def.key === 'System.Void';
      if (f.body.kind === 'block') {
        this.returns.push([]);
        this.returnTargets.push(ret);
        this.block(f.body, false);
        this.returnTargets.pop();
        this.returns.pop();
        if (!isVoid && ret.k !== 'unknown' && endReachable(f.body)) this.error(f.nameSpan, `Not all code paths in '${f.name}' return a value.`);
      } else {
        const v = this.expr(f.body, isVoid ? undefined : ret);
        if (!isVoid) this.checkConversion(f.body, v, ret);
      }
    });
    this.typeParamScopes.pop();
  }

  // ---- query expressions ----------------------------------------------------------------------

  /** `from x in xs ... select y` is IEnumerable<typeof y>; range variables are typed from their sources. */
  private query(e: Expr & { kind: 'query' }): Value {
    return this.withScope(() => {
      this.fromClause(e.from);
      return this.val(this.queryBody(e.body));
    });
  }

  private fromClause(c: FromClause): void {
    const source = this.typeOf(this.expr(c.source));
    const type = c.type ? this.resolveType(c.type) : this.model.elementType(source);
    this.declare({ name: c.designation.name, type, decl: c.designation, kind: 'range' });
  }

  private queryBody(b: QueryBody): Type {
    const m = this.model;
    const sequence = (t: Type) => (t.k === 'unknown' ? UNKNOWN : m.named('System.Collections.Generic.IEnumerable`1', [t]));
    for (const c of b.clauses) {
      switch (c.kind) {
        case 'from':
          this.fromClause(c);
          break;
        case 'let':
          this.declare({ name: c.designation.name, type: this.typeOf(this.expr(c.value)), decl: c.designation, kind: 'range' });
          break;
        case 'where':
          this.condition(c.condition);
          break;
        case 'join': {
          const source = this.typeOf(this.expr(c.source));
          const type = c.type ? this.resolveType(c.type) : m.elementType(source);
          this.expr(c.outerKey);
          this.withScope(() => {
            this.declare({ name: c.designation.name, type, decl: c.designation, kind: 'range' });
            this.expr(c.innerKey);
          });
          if (c.into) this.declare({ name: c.into.name, type: sequence(type), decl: c.into, kind: 'range' });
          else this.declare({ name: c.designation.name, type, decl: c.designation, kind: 'range' });
          break;
        }
        case 'orderby':
          for (const k of c.keys) this.expr(k);
          break;
      }
    }
    let element: Type = UNKNOWN;
    if (b.final?.kind === 'select') {
      element = this.typeOf(this.expr(b.final.value));
    } else if (b.final?.kind === 'group') {
      const value = this.typeOf(this.expr(b.final.value));
      const key = this.typeOf(this.expr(b.final.key));
      element = m.named('System.Linq.IGrouping`2', [key, value]);
    }
    if (b.continuation) {
      const cont = b.continuation;
      return this.withScope(() => {
        this.declare({ name: cont.designation.name, type: element, decl: cont.designation, kind: 'range' });
        return this.queryBody(cont.body);
      });
    }
    return sequence(element);
  }

  // ---- conversions ----------------------------------------------------------------------------

  /**
   * Reports that `e` (bound to `v`) has no implicit conversion to `target`. Only reported when
   * both types are fully known to the model, so a gap in the model can't produce an error.
   */
  private checkConversion(e: Expr, v: Value, target: Type): void {
    if (!this.recording || v.kind !== 'value') return;
    const m = this.model;
    const from = v.type;
    if (e.kind === 'lambda' || e.kind === 'interp' || e.kind === 'default' || e.kind === 'throw' || e.kind === 'missing') return;
    if (!m.isDefinite(from) || !m.isDefinite(target)) return;
    if (m.conversion(from, target, constantKind(e, v)) !== undefined) return;
    if (from.k === 'null') {
      this.error(e, `Cannot convert null to '${m.display(target)}' because it's a non-nullable value type.`);
      return;
    }
    const hint = m.explicitConversion(from, target) ? ' An explicit conversion exists (are you missing a cast?)' : '';
    this.error(e, `Cannot implicitly convert type '${m.display(from)}' to '${m.display(target)}'.${hint}`);
  }

  // ---- types ----------------------------------------------------------------------------------

  /**
   * Resolves a type written in the code, recording completion, hover and references. A local
   * declaration's type isn't `typeOnly`: at the start of a statement the user may be typing an
   * expression that just happens to parse as `Type name`.
   */
  resolveType(node: TypeNode, typeOnly = true): Type {
    switch (node.kind) {
      case 'var':
        return UNKNOWN;
      case 'predefined': {
        const t = this.model.named(PREDEFINED_TYPES[node.keyword]);
        if (t.k === 'named') this.recordHover(node, { kind: 'type', type: t });
        return t;
      }
      case 'array': {
        let t = this.resolveType(node.element);
        for (let i = node.ranks.length - 1; i >= 0; i--) t = { k: 'array', element: t, rank: node.ranks[i] };
        return t;
      }
      case 'nullable': {
        const element = this.resolveType(node.element);
        if (this.model.isReferenceType(element)) {
          this.error(node, 'Nullable reference types need C# 8. Policy expressions are C# 7.3.', 'language-version');
          return element;
        }
        return this.model.nullableOf(element);
      }
      case 'tuple':
        return { k: 'tuple', elements: node.elements.map((e) => ({ name: e.name, type: this.resolveType(e.type) })) };
      case 'named': {
        let current: Value | undefined;
        for (let i = 0; i < node.parts.length; i++) {
          const part = node.parts[i];
          const args = part.typeArgs?.map((a) => this.resolveType(a)) ?? [];
          if (i === 0) {
            if (this.hits(part)) this.recordCompletion({ kind: 'name', locals: typeOnly ? [] : this.visibleLocals(), span: part, typeOnly });
            if (node.parts.length === 1 && !args.length && this.typeParamScopes.some((s) => s.has(part.name))) return { k: 'param', name: part.name };
            current = this.simpleTypeOrNamespace(part.name, args, part, node.global);
          } else {
            if (this.hits(part) && current) this.recordCompletion({ kind: 'member', receiver: current, span: part, conditional: false });
            current = current && this.qualifiedTypeOrNamespace(current, part.name, args, part);
          }
          if (!current) return UNKNOWN;
        }
        if (current?.kind === 'namespace') {
          const last = node.parts[node.parts.length - 1];
          if (last.name) this.error(node, `'${current.name}' is a namespace but is used like a type.`);
          return UNKNOWN;
        }
        return current?.kind === 'type' ? current.type : UNKNOWN;
      }
    }
  }

  private simpleTypeOrNamespace(name: string, args: Type[], span: Span, global?: boolean): Value | undefined {
    if (!name) return undefined;
    const def = global ? undefined : this.model.lookupSimple(name, args.length);
    if (def) {
      const type = this.construct(def, args);
      this.reference(span, def);
      this.recordHover(span, { kind: 'type', type });
      return { kind: 'type', type };
    }
    if (!args.length && this.model.isNamespace(name)) {
      this.recordHover(span, { kind: 'namespace', name });
      return { kind: 'namespace', name };
    }
    this.error(span, `The type or namespace name '${name}' could not be found.`);
    return undefined;
  }

  private qualifiedTypeOrNamespace(container: Value, name: string, args: Type[], span: Span): Value | undefined {
    if (!name) return undefined;
    if (container.kind === 'namespace') {
      const full = `${container.name}.${name}`;
      const def = this.model.lookupQualified(container.name, name, args.length, false);
      if (def) {
        const type = this.construct(def, args);
        this.reference(span, def);
        this.recordHover(span, { kind: 'type', type });
        return { kind: 'type', type };
      }
      if (!args.length && this.model.isNamespace(full)) {
        this.recordHover(span, { kind: 'namespace', name: full });
        return { kind: 'namespace', name: full };
      }
      this.error(span, `The type or namespace name '${name}' does not exist in the namespace '${container.name}'.`);
      return undefined;
    }
    if (container.kind === 'type' && container.type.k === 'named') {
      const def = this.model.lookupQualified(container.type.def.key, name, args.length, true);
      if (def) {
        const type = this.construct(def, [...container.type.args, ...args]);
        this.reference(span, def);
        this.recordHover(span, { kind: 'type', type });
        return { kind: 'type', type };
      }
      this.error(span, `The type name '${name}' does not exist in the type '${this.model.display(container.type)}'.`);
    }
    return undefined;
  }

  private construct(def: TypeDef, args: Type[]): Type {
    const params = def.typeParams;
    return { k: 'named', def, args: params.map((_, i) => args[i] ?? UNKNOWN) };
  }

  // ---- expressions ----------------------------------------------------------------------------

  typeOf(v: Value): Type {
    return v.kind === 'value' ? v.type : UNKNOWN;
  }

  private val(type: Type, symbol?: BoundSymbol): Value {
    return { kind: 'value', type, symbol };
  }

  /** Binds an expression; `expected` is the target type, used for lambdas and `default`. */
  expr(e: Expr, expected?: Type): Value {
    const m = this.model;
    switch (e.kind) {
      case 'missing':
        return this.val(UNKNOWN);
      case 'literal':
        return this.val(this.literalType(e.literal));
      case 'interp':
        for (const h of e.holes) this.expr(h);
        return this.val(m.named('System.String'));
      case 'namedValue':
        // Outside a string, APIM pastes the named value's text in before compiling, so it can be
        // a number, a bool or code. Its type isn't known until then.
        return this.val(UNKNOWN);
      case 'name':
        return this.name(e);
      case 'predefined': {
        const type = m.named(PREDEFINED_TYPES[e.keyword]);
        this.recordHover(e, { kind: 'type', type });
        return { kind: 'type', type };
      }
      case 'member':
        return this.member(e);
      case 'call':
        return this.call(e);
      case 'index':
        return this.index(e);
      case 'new':
        return this.newExpr(e, expected);
      case 'lambda': {
        const sig = expected && m.delegateSignature(expected);
        this.lambda(e, sig?.params ?? [], sig?.ret);
        return this.val(expected && sig ? expected : UNKNOWN);
      }
      case 'unary':
        return this.unary(e);
      case 'binary':
        return this.binary(e);
      case 'assign': {
        const left = this.expr(e.left);
        const lt = this.typeOf(left);
        if (left.kind === 'value' && left.symbol?.kind === 'local' && left.symbol.local.kind === 'context') {
          this.error(e.left, "'context' is read-only.");
        } else if (left.kind === 'value' && left.symbol?.kind === 'member' && left.symbol.member.kind === 'property' && !left.symbol.member.writable && left.symbol.member.declaring.origin === 'stub') {
          this.error(e.left, `Property '${left.symbol.member.name}' is read-only.`);
        }
        const right = this.expr(e.right, e.op === '=' ? lt : undefined);
        if (e.op === '=' && left.kind === 'value') this.checkConversion(e.right, right, lt);
        // `o["k"] = v` adds k to o's shape.
        if (e.op === '=' && e.left.kind === 'index') this.addKey(this.indexReceivers.get(e.left), e.left.args.args, this.typeOf(right));
        return this.val(lt);
      }
      case 'conditional': {
        const w = this.wanted.get(e);
        if (w) {
          this.want(e.whenTrue, w);
          this.want(e.whenFalse, w);
        }
        this.condition(e.condition);
        const a = this.typeOf(this.expr(e.whenTrue, expected));
        const b = this.typeOf(this.expr(e.whenFalse, expected));
        return this.val(this.commonType(a, b, e.whenTrue, e.whenFalse));
      }
      case 'is': {
        this.expr(e.operand);
        if (e.pattern) this.expr(e.pattern);
        if (e.type) {
          const t = e.type.kind === 'var' ? this.typeOf(this.speculate(() => this.expr(e.operand))) : this.resolveType(e.type);
          if (e.designation) this.declare({ name: e.designation.name, type: e.type.kind === 'var' ? t : m.underlying(t), decl: e.designation, kind: 'local' });
        }
        return this.val(m.named('System.Boolean'));
      }
      case 'as': {
        const operand = this.typeOf(this.expr(e.operand));
        const t = this.resolveType(e.type);
        if (m.isValueType(t) && !m.isNullable(t)) this.error(e.type, `The as operator must be used with a reference type or nullable type ('${m.display(t)}' is a non-nullable value type).`);
        return this.val(withShape(t, shapeOf(operand)));
      }
      case 'cast': {
        const t = this.resolveType(e.type);
        // `(JObject)context.Variables["x"]` keeps what's known about x.
        const operand = this.typeOf(this.expr(e.operand, t));
        return this.val(withShape(t, shapeOf(operand)));
      }
      case 'paren': {
        const w = this.wanted.get(e);
        if (w) this.want(e.inner, w);
        return this.expr(e.inner, expected);
      }
      case 'tuple':
        return this.val({ k: 'tuple', elements: e.items.map((i) => ({ name: i.name, type: this.typeOf(this.expr(i.value)) })) });
      case 'typeof':
        this.resolveType(e.type);
        return this.val(m.named('System.Type'));
      case 'default':
        return this.val(e.type ? this.resolveType(e.type) : (expected ?? UNKNOWN));
      case 'nameof':
        this.expr(e.inner);
        return this.val(m.named('System.String'));
      case 'checked':
        return this.expr(e.inner, expected);
      case 'throw':
        this.expr(e.operand);
        return this.val(UNKNOWN);
      case 'declaration': {
        // Only valid as an `out` argument; arguments handle it. Elsewhere, declare it untyped.
        const t = e.type.kind === 'var' ? UNKNOWN : this.resolveType(e.type);
        this.declare({ name: e.designation.name, type: t, decl: e.designation, kind: 'local' });
        return this.val(t);
      }
      case 'arrayInit':
        for (const i of e.items) this.expr(i);
        return this.val(UNKNOWN);
      case 'query':
        return this.query(e);
    }
  }

  private literalType(kind: string): Type {
    const m = this.model;
    switch (kind) {
      case 'string':
        return m.named('System.String');
      case 'char':
        return m.named('System.Char');
      case 'int':
        return m.named('System.Int32');
      case 'uint':
        return m.named('System.UInt32');
      case 'long':
        return m.named('System.Int64');
      case 'ulong':
        return m.named('System.UInt64');
      case 'float':
        return m.named('System.Single');
      case 'double':
        return m.named('System.Double');
      case 'decimal':
        return m.named('System.Decimal');
      case 'bool':
        return m.named('System.Boolean');
      default:
        return NULL;
    }
  }

  private name(e: Expr & { kind: 'name' }): Value {
    if (this.hits(e)) this.recordCompletion({ kind: 'name', locals: this.visibleLocals(), span: e, typeOnly: false });
    if (!e.name) return this.val(UNKNOWN);
    if (e.name === 'this' || e.name === 'base') {
      this.error(e, `Keyword '${e.name}' isn't available in a policy expression.`);
      return this.val(UNKNOWN);
    }
    if (e.name.startsWith('global::')) {
      const rest = e.name.slice(8);
      return this.simpleTypeOrNamespace(rest, [], e, true) ?? this.val(UNKNOWN);
    }
    const found = this.lookupLocal(e.name);
    if (found?.kind === 'function' && found.fn) {
      this.recordHover(e, { kind: 'local', local: found });
      const typeArgs = e.typeArgs?.map((a) => this.resolveType(a));
      return { kind: 'methods', name: e.name, candidates: [{ member: found.fn, subst: new Map() }], typeArgs, extensionsOnly: false };
    }
    const local = e.typeArgs ? undefined : found;
    if (local) {
      const symbol: BoundSymbol = { kind: 'local', local };
      this.recordHover(e, symbol);
      return this.val(local.type, symbol);
    }
    const args = e.typeArgs?.map((a) => this.resolveType(a)) ?? [];
    const def = this.model.lookupSimple(e.name, args.length);
    if (def) {
      const type = this.construct(def, args);
      this.reference(e, def);
      this.recordHover(e, { kind: 'type', type });
      return { kind: 'type', type };
    }
    if (!args.length && this.model.isNamespace(e.name)) {
      this.recordHover(e, { kind: 'namespace', name: e.name });
      return { kind: 'namespace', name: e.name };
    }
    this.error(e, `The name '${e.name}' does not exist in the current context.`);
    return this.val(UNKNOWN);
  }

  /** `invoked` when it's the target of a call: then only methods and delegate-typed members count. */
  private member(e: Expr & { kind: 'member' }, invoked = false): Value {
    const target = this.expr(e.target);
    const site = { start: e.nameSpan.start, end: e.nameSpan.end };
    if (this.hits(site)) this.recordCompletion({ kind: 'member', receiver: target, span: site, conditional: e.conditional });
    if (!e.name) return this.val(UNKNOWN);
    const m = this.model;
    const typeArgs = e.typeArgs?.map((a) => this.resolveType(a));

    if (target.kind === 'namespace') {
      return this.qualifiedTypeOrNamespace(target, e.name, typeArgs ?? [], e.nameSpan) ?? this.val(UNKNOWN);
    }
    if (target.kind === 'methods') {
      this.error(e.nameSpan, `Can't access a member of the method group '${target.name}'.`);
      return this.val(UNKNOWN);
    }

    const isStatic = target.kind === 'type';
    let receiver = target.kind === 'type' ? target.type : target.type;
    if (receiver.k === 'unknown') return this.val(UNKNOWN);
    if (e.conditional && !isStatic) receiver = m.underlying(receiver);
    if (receiver.k === 'null') {
      this.error(e.nameSpan, `Can't access '${e.name}' on null.`);
      return this.val(UNKNOWN);
    }

    if (isStatic && receiver.k === 'named') {
      const nested = m.lookupQualified(receiver.def.key, e.name, typeArgs?.length ?? 0, true);
      if (nested) {
        const type = this.construct(nested, [...receiver.args, ...(typeArgs ?? [])]);
        this.reference(e.nameSpan, nested);
        this.recordHover(e.nameSpan, { kind: 'type', type });
        return { kind: 'type', type };
      }
    }

    const found = receiver.k === 'anon' || receiver.k === 'tuple' ? [] : m.members(receiver, e.name).filter((x) => x.member.kind !== 'ctor' && x.member.kind !== 'operator' && x.member.kind !== 'indexer');
    if (receiver.k === 'anon' && !isStatic) {
      const prop = receiver.props.find((p) => p.name === e.name);
      if (prop) return this.val(prop.type);
    }
    if (receiver.k === 'tuple' && !isStatic) {
      const idx = receiver.elements.findIndex((el, i) => el.name === e.name || `Item${i + 1}` === e.name);
      if (idx >= 0) return this.val(receiver.elements[idx].type);
    }
    let valueMember = found.find((x) => x.member.kind !== 'method');
    // `users.Count(f)` on a JArray: the Count property isn't invocable, so the lookup goes on to
    // methods and extension methods, and only falls back to it when there are none.
    if (valueMember && invoked && !isStatic && !m.delegateSignature(m.resolve(valueMember.member.type, valueMember.subst))) {
      const hasMethods = found.some((x) => x.member.kind === 'method') || this.extensionsFor(receiver, e.name).length > 0;
      if (hasMethods) valueMember = undefined;
    }
    if (valueMember) {
      const { member, subst } = valueMember;
      if (member.isStatic !== isStatic) {
        this.error(e.nameSpan, isStatic ? `An object reference is required to access '${m.display(receiver)}.${member.name}'.` : `Member '${m.display(receiver)}.${member.name}' is static; qualify it with the type name instead.`);
      }
      let type = m.resolve(member.type, subst);
      if (e.conditional && m.isValueType(type)) type = m.nullableOf(type);
      const symbol: BoundSymbol = { kind: 'member', member, subst, receiver };
      this.reference(e.nameSpan, member.declaring, member);
      this.recordHover(e.nameSpan, symbol, type);
      return this.val(type, symbol);
    }
    const methods: Candidate[] = found.filter((x) => x.member.kind === 'method' && x.member.isStatic === isStatic).map((x) => ({ member: x.member, subst: x.subst }));
    if (!isStatic) {
      // Extension methods are only considered when no instance method of that name applies;
      // overload resolution sorts that out, so collect them here.
      const ext = this.extensionsFor(receiver, e.name);
      if (methods.length === 0 && ext.length > 0) return { kind: 'methods', name: e.name, candidates: ext, receiver, typeArgs, extensionsOnly: true };
      if (methods.length > 0) return { kind: 'methods', name: e.name, candidates: [...methods, ...ext], receiver, typeArgs, extensionsOnly: false };
    } else if (methods.length > 0) {
      return { kind: 'methods', name: e.name, candidates: methods, typeArgs, extensionsOnly: false };
    }
    const wrongStatic = found.find((x) => x.member.kind === 'method');
    if (wrongStatic) {
      this.error(e.nameSpan, isStatic ? `An object reference is required to access '${m.display(receiver)}.${e.name}'.` : `Member '${m.display(receiver)}.${e.name}' is static; qualify it with the type name instead.`);
      return { kind: 'methods', name: e.name, candidates: found.map((x) => ({ member: x.member, subst: x.subst })), receiver: isStatic ? undefined : receiver, typeArgs, extensionsOnly: false };
    }
    if (receiver.k !== 'param') this.error(e.nameSpan, `'${m.display(receiver)}' does not contain a definition for '${e.name}'.`);
    return this.val(UNKNOWN);
  }

  /** Extension methods named `name` (or all, without a name) whose `this` parameter accepts `receiver`. */
  extensionsFor(receiver: Type, name?: string): Candidate[] {
    const out: Candidate[] = [];
    for (const member of this.model.extensions) {
      if (name !== undefined && member.name !== name) continue;
      const first = member.params[0];
      if (!first) continue;
      const tps = new Set(member.typeParams);
      const bounds = new Map<string, Type[]>();
      const raw = this.model.resolve(first.type);
      this.lowerBound(receiver, raw, tps, bounds);
      const subst = this.fix(bounds);
      const pt = substitute(raw, subst);
      if (this.model.conversion(receiver, pt) === undefined || !this.model.satisfiesConstraints(member, subst)) continue;
      out.push({ member, subst, extension: true });
    }
    return out;
  }

  private call(e: Expr & { kind: 'call' }): Value {
    const callee = e.target.kind === 'member' ? this.member(e.target, true) : this.expr(e.target);
    const m = this.model;
    if (callee.kind === 'methods') {
      const r = this.resolveCall(callee.candidates, e.args, callee.receiver, callee.typeArgs, callee.name, e.target.kind === 'member' ? e.target.nameSpan : e.target);
      if (!r) return this.val(UNKNOWN);
      let ret = m.resolve(r.candidate.member.type, r.subst);
      const target = e.target;
      ret = this.shapeCall(e, callee.name, callee.receiver, ret);
      if (target.kind === 'member') {
        const symbol: BoundSymbol = { kind: 'member', member: r.candidate.member, subst: r.subst, receiver: callee.receiver };
        this.reference(target.nameSpan, r.candidate.member.declaring, r.candidate.member);
        this.recordHover(target.nameSpan, symbol, ret);
        if (target.conditional && m.isValueType(ret) && !(ret.k === 'named' && ret.def.key === 'System.Void')) return this.val(m.nullableOf(ret));
      }
      return this.val(ret);
    }
    if (callee.kind === 'value') {
      const sig = m.delegateSignature(callee.type);
      for (const a of e.args.args) this.expr(a.value);
      if (sig) return this.val(sig.ret);
      if (callee.type.k !== 'unknown') this.error(e.target, `'${m.display(callee.type)}' isn't invocable.`);
      return this.val(UNKNOWN);
    }
    for (const a of e.args.args) this.expr(a.value);
    if (callee.kind === 'type') this.error(e.target, `'${m.display(callee.type)}' is a type, which isn't valid here. Use 'new' to create one.`);
    return this.val(UNKNOWN);
  }

  /** What a call's result holds, when shapes say: `Variables.GetValueOrDefault<JObject>("x")`, `OfType<JObject>()`. */
  private shapeCall(e: Expr & { kind: 'call' }, name: string, receiver: Type | undefined, ret: Type): Type {
    if (name === 'GetValueOrDefault' && isVariables(e.target.kind === 'member' ? e.target.target : undefined)) {
      const first = e.args.args[0]?.value;
      const key = first?.kind === 'literal' ? literalKey(first.text) : undefined;
      return key ? withShape(ret, this.shapes.get(key)) : ret;
    }
    if ((name === 'OfType' || name === 'Cast') && receiver && ret.k === 'named' && ret.args.length === 1) {
      const element = shapeOf(this.elementOf(receiver));
      if (element) return { ...ret, args: [withShape(ret.args[0], element)] };
    }
    return ret;
  }

  /** What iterating `t` gives: a shaped JArray's elements carry their shape. */
  private elementOf(t: Type): Type {
    const s = shapeOf(t);
    const element = this.model.elementType(t);
    if (s?.kind === 'array') return withShape(element, tokenShape(s.element));
    return element;
  }

  /** Records `key = value` in `receiver`'s object shape (an initializer entry or an assignment). */
  private addKey(receiver: Type | undefined, args: readonly Argument[], value: Type): void {
    const shape = receiver && shapeOf(receiver);
    const key = args.length === 1 && args[0].value.kind === 'literal' ? literalKey(args[0].value.text) : undefined;
    if (shape?.kind !== 'object' || key === undefined) return;
    shape.fields.set(key, value.k === 'null' ? (shape.fields.get(key) ?? UNKNOWN) : value);
  }

  private index(e: Expr & { kind: 'index' }): Value {
    const target = this.expr(e.target);
    const m = this.model;
    let t = this.typeOf(target);
    if (e.conditional) t = m.underlying(t);
    this.indexReceivers.set(e, t);
    // `context.Variables["x"]` is an object, carrying what's known about x.
    if (isVariables(e.target)) {
      const v = this.indexValue(e, t, m);
      const key = e.args.args[0]?.value;
      const name = key?.kind === 'literal' ? literalKey(key.text) : undefined;
      return v.kind === 'value' && name ? this.val(withShape(v.type, this.shapes.get(name)), v.symbol) : v;
    }
    const v = this.indexValue(e, t, m);
    const shape = shapeOf(t);
    const arg = e.args.args.length === 1 ? e.args.args[0].value : undefined;
    if (shape?.kind === 'object' && arg?.kind === 'literal' && arg.literal === 'string') {
      const inner = { start: arg.start + 1, end: Math.max(arg.start + 1, arg.end - 1) };
      if (this.hits(inner)) this.recordCompletion({ kind: 'jsonKey', shape, span: inner });
      const key = literalKey(arg.text);
      const field = key === undefined ? undefined : shape.fields.get(key);
      if (key !== undefined && field) {
        this.recordHover(inner, { kind: 'jsonKey', name: key, type: field, doc: shape.docs?.get(key) });
        return v.kind === 'value' ? this.val(withShape(v.type, tokenShape(field)), v.symbol) : v;
      }
      return v;
    }
    if (shape?.kind === 'array' && v.kind === 'value') return this.val(withShape(v.type, tokenShape(shape.element)), v.symbol);
    return v;
  }

  private indexValue(e: Expr & { kind: 'index' }, t: Type, m: TypeModel): Value {
    const lift = (r: Type) => (e.conditional && m.isValueType(r) ? m.nullableOf(r) : r);
    if (t.k === 'array') {
      for (const a of e.args.args) this.expr(a.value, m.named('System.Int32'));
      if (e.args.args.length !== t.rank) this.error(e.args, `Wrong number of indices inside []; expected ${t.rank}.`);
      return this.val(lift(t.element));
    }
    if (t.k === 'unknown' || t.k === 'param') {
      for (const a of e.args.args) this.expr(a.value);
      return this.val(UNKNOWN);
    }
    const indexers = m.members(t, 'this[]').map((x) => ({ member: x.member, subst: x.subst }));
    if (indexers.length === 0) {
      for (const a of e.args.args) this.expr(a.value);
      this.error(e.args, `Cannot apply indexing with [] to an expression of type '${m.display(t)}'.`);
      return this.val(UNKNOWN);
    }
    const r = this.resolveCall(indexers, e.args, undefined, undefined, 'this[]', e.args);
    if (!r) return this.val(UNKNOWN);
    const type = m.resolve(r.candidate.member.type, r.subst);
    return this.val(lift(type), { kind: 'member', member: r.candidate.member, subst: r.subst, receiver: t });
  }

  private newExpr(e: Expr & { kind: 'new' }, expected?: Type): Value {
    const m = this.model;
    if (e.anonymous) {
      return this.val({ k: 'anon', props: e.anonymous.map((p) => ({ name: p.name, type: this.typeOf(this.expr(p.value)) })) });
    }
    if (e.arrayRanks) {
      let element = e.type ? this.resolveType(e.type) : undefined;
      for (const s of e.arraySizes ?? []) this.expr(s, m.named('System.Int32'));
      // `new int[2][]` is an array of int[].
      for (let i = e.arrayRanks.length - 1; i >= 1 && element; i--) element = { k: 'array', element, rank: e.arrayRanks[i] };
      if (!element) {
        const types = (e.arrayInit ?? []).map((i) => this.typeOf(this.expr(i)));
        element = types.reduce<Type | undefined>((acc, t) => (acc === undefined ? t : this.commonType(acc, t)), undefined) ?? UNKNOWN;
        if (element.k === 'null') element = UNKNOWN;
      } else {
        for (const i of e.arrayInit ?? []) this.expr(i, element);
      }
      return this.val({ k: 'array', element, rank: e.arrayRanks[0] });
    }
    let type = e.type ? this.resolveType(e.type) : (expected ?? UNKNOWN);
    // A new JObject starts with no keys; its initializer and later assignments add them.
    if (isJObject(type)) type = withShape(type, { kind: 'object', fields: new Map() });
    // What it's meant to hold: a JArray's items are each meant to be the wanted element.
    const wanted = shapeOf(this.wanted.get(e) ?? UNKNOWN);
    if (wanted?.kind === 'array' && isJArray(type)) {
      for (const a of e.args?.args ?? []) this.want(a.value, wanted.element);
      if (e.init?.kind === 'collection') for (const member of e.init.members) this.want(member.value, wanted.element);
    }
    if (type.k !== 'named') {
      if (e.args) for (const a of e.args.args) this.expr(a.value);
      if (e.init) this.initializer(e.init, type);
      return this.val(type);
    }
    if (type.def.kind === 'interface' || type.def.isAbstract || type.def.isStatic) {
      this.error(e.type ?? e, `Cannot create an instance of the ${type.def.isStatic ? 'static class' : type.def.kind === 'interface' ? 'interface' : 'abstract type'} '${m.display(type)}'.`);
    }
    const ctors = byName(type.def).get('.ctor') ?? [];
    if (e.args && ctors.length > 0) {
      const subst = m.substOf(type);
      const r = this.resolveCall(
        ctors.map((member) => ({ member, subst })),
        e.args,
        undefined,
        undefined,
        type.def.name,
        e.type ?? e,
      );
      if (r && e.type) {
        this.reference(e.type, type.def, r.candidate.member);
        this.recordHover(e.type, { kind: 'member', member: r.candidate.member, subst: r.subst });
      }
    } else if (e.args) {
      for (const a of e.args.args) this.expr(a.value);
      if (e.args.args.length > 0 && type.def.kind !== 'struct' && type.def.kind !== 'delegate') this.error(e.type ?? e, `'${m.display(type)}' does not have a constructor that takes ${e.args.args.length} arguments.`);
    }
    // `new JArray(items)` holds what items yields; `new JArray { a, b }` what a holds.
    if (isJArray(type)) {
      const first = e.args?.args[0]?.value ?? (e.init?.kind === 'collection' ? e.init.members[0]?.value : undefined);
      if (first) {
        const t = this.speculate(() => this.typeOf(this.expr(first)));
        // One argument that's a sequence (not itself a token) gives the elements; anything else is one.
        const token = t.k === 'named' && t.def.key.startsWith('Newtonsoft.Json.Linq.') && shapeOf(t)?.kind !== 'array';
        const sequence = e.args?.args.length === 1 && !token && t.k !== 'unknown' && m.elementType(t).k !== 'unknown' && !(t.k === 'named' && t.def.key === 'System.String');
        const element = sequence ? this.elementOf(t) : t;
        if (element.k !== 'unknown') type = withShape(type, { kind: 'array', element });
      }
    }
    if (e.init) this.initializer(e.init, type, wanted?.kind === 'object' && isJObject(type) ? wanted : undefined);
    if (wanted?.kind === 'object' && isJObject(type)) this.checkObject(e, type, wanted);
    // `new JObject` under the probe: what it builds, for turning it into a @typedef. Innermost wins.
    const head = { start: e.start, end: e.type?.end ?? e.start + 3 };
    if (isJObject(type) && this.recording && this.hits(head)) this.created = { span: { start: e.start, end: e.end }, type };
    return this.val(type);
  }

  /** Marks `e` as meant to produce `t` (a shaped JSON type), for the JObject or JArray it builds. */
  private want(e: Expr, t: Type): void {
    if (shapeOf(t)) this.wanted.set(e, t);
  }

  /**
   * Compares the JObject `e` built with the shape it's meant to have: keys the shape doesn't
   * have, required keys it lacks, and values of the wrong kind. Warnings, since the gateway
   * accepts any JSON; they say the value won't be what the fragment reading it expects.
   */
  private checkObject(e: Expr & { kind: 'new' }, built: Type, wanted: JsonShape & { kind: 'object' }): void {
    const m = this.model;
    const have = shapeOf(built);
    if (have?.kind !== 'object') return;
    const keys = new Map<string, { key: Span; value: Expr }>();
    for (const member of e.init?.members ?? []) {
      const arg = member.index?.args.length === 1 ? member.index.args[0].value : undefined;
      const key = arg?.kind === 'literal' ? literalKey(arg.text) : undefined;
      if (arg && key !== undefined) keys.set(key, { key: arg, value: member.value });
    }
    const known = [...wanted.fields.keys()].map((k) => `${k}${wanted.optional?.has(k) ? '?' : ''}`).join(', ');
    for (const [key, at] of keys) {
      const want = wanted.fields.get(key);
      if (!want) {
        this.error(at.key, `'${key}' isn't a key of the shape this value should have (${known || 'no keys'}).`, 'json-shape');
        continue;
      }
      const got = have.fields.get(key);
      const problem = got && mismatch(m, got, want);
      if (problem) this.error(at.value, `'${key}' should be ${problem}.`, 'json-shape');
    }
    const missing = [...wanted.fields.keys()].filter((k) => !wanted.optional?.has(k) && !have.fields.has(k));
    if (missing.length) this.error(e.type ?? e, `Missing ${missing.length === 1 ? 'required key' : 'required keys'} ${missing.map((k) => `'${k}'`).join(', ')}.`, 'json-shape');
  }

  private initializer(init: NonNullable<(Expr & { kind: 'new' })['init']>, type: Type, wanted?: JsonShape & { kind: 'object' }): void {
    const m = this.model;
    const assigned = init.members.filter((x) => x.name).map((x) => x.name!);
    for (const member of init.members) {
      if (member.name !== undefined && member.nameSpan) {
        if (this.hits(member.nameSpan)) this.recordCompletion({ kind: 'initializer', type, span: member.nameSpan, assigned });
        const found = type.k === 'named' ? m.members(type, member.name).find((x) => x.member.kind === 'property' || x.member.kind === 'field') : undefined;
        if (found) {
          const ft = m.resolve(found.member.type, found.subst);
          this.recordHover(member.nameSpan, { kind: 'member', member: found.member, subst: found.subst, receiver: type }, ft);
          this.reference(member.nameSpan, found.member.declaring, found.member);
          if (member.value.kind === 'arrayInit') this.arrayInit(member.value, ft);
          else this.checkConversion(member.value, this.expr(member.value, ft), ft);
        } else {
          if (type.k === 'named') this.error(member.nameSpan, `'${m.display(type)}' does not contain a definition for '${member.name}'.`);
          this.expr(member.value);
        }
      } else if (member.index) {
        // [key] = value: an indexer assignment; on a JObject, it adds the key to the shape.
        const arg = member.index.args.length === 1 ? member.index.args[0].value : undefined;
        if (wanted && arg?.kind === 'literal' && arg.literal === 'string') {
          const inner = { start: arg.start + 1, end: Math.max(arg.start + 1, arg.end - 1) };
          const key = literalKey(arg.text);
          // Keys still to write, required first: what the shape wants and the code doesn't have yet.
          if (this.hits(inner)) {
            const written = new Set(init.members.flatMap((x) => (x !== member && x.index?.args[0]?.value.kind === 'literal' ? [literalKey(x.index.args[0].value.text) ?? ''] : [])));
            const fields = new Map([...wanted.fields].filter(([k]) => !written.has(k)).sort(([a], [b]) => Number(!!wanted.optional?.has(a)) - Number(!!wanted.optional?.has(b))));
            this.recordCompletion({ kind: 'jsonKey', shape: { kind: 'object', fields, optional: wanted.optional, docs: wanted.docs }, span: inner });
          }
          const field = key === undefined ? undefined : wanted.fields.get(key);
          if (key !== undefined && field) {
            this.recordHover(inner, { kind: 'jsonKey', name: key, type: field, doc: wanted.docs?.get(key) });
            this.want(member.value, field);
          }
        }
        for (const a of member.index.args) this.expr(a.value);
        const value = this.typeOf(this.expr(member.value));
        this.addKey(type, member.index.args, value);
      } else if (member.value.kind === 'arrayInit') {
        // { key, value } for Add(key, value)
        for (const i of member.value.items) this.expr(i);
      } else if (member.value.kind === 'name' && this.hits(member.value) && init.kind === 'object') {
        this.recordCompletion({ kind: 'initializer', type, span: member.value, assigned });
      } else {
        const element = m.elementType(type);
        this.expr(member.value, element.k === 'unknown' ? undefined : element);
      }
    }
  }

  private arrayInit(e: Expr, declared: Type, inArray = false): Value {
    if (e.kind !== 'arrayInit') {
      const v = this.expr(e, declared);
      if (inArray) this.checkConversion(e, v, declared);
      return v;
    }
    const element = declared.k === 'array' ? declared.element : this.model.elementType(declared);
    for (const i of e.items) this.arrayInit(i, element, declared.k === 'array');
    return this.val(declared);
  }

  private lambda(e: Expr & { kind: 'lambda' }, paramTypes: Type[], ret?: Type): Type {
    return this.withScope(() => {
      e.params.forEach((p, i) => {
        const type = p.type ? this.resolveType(p.type) : (paramTypes[i] ?? UNKNOWN);
        this.declare({ name: p.name, type, decl: { start: p.end - p.name.length, end: p.end }, kind: 'parameter' });
      });
      if (e.body.kind === 'block') {
        this.returns.push([]);
        this.returnTargets.push(undefined);
        this.block(e.body, false);
        this.returnTargets.pop();
        const types = this.returns.pop()!;
        if (ret && ret.k === 'named' && ret.def.key !== 'System.Void' && endReachable(e.body)) this.error({ start: e.arrow, end: e.arrow + 2 }, 'Not all code paths return a value in this lambda.');
        return types.find((t) => t.k !== 'null' && t.k !== 'unknown') ?? (types.length ? (types[0] ?? UNKNOWN) : this.model.named('System.Void'));
      }
      return this.typeOf(this.expr(e.body, ret && !(ret.k === 'named' && ret.def.key === 'System.Void') ? ret : undefined));
    });
  }

  private unary(e: Expr & { kind: 'unary' }): Value {
    const m = this.model;
    const t = this.typeOf(this.expr(e.operand));
    switch (e.op) {
      case '!':
        if (t.k !== 'unknown' && !sameType(m.underlying(t), m.named('System.Boolean')) && m.isDefinite(t) && !m.userOperator(t, 'op_LogicalNot')) this.error(e, `Operator '!' cannot be applied to an operand of type '${m.display(t)}'.`);
        return this.val(m.named('System.Boolean'));
      case '++':
      case '--':
        return this.val(t);
      default: {
        const key = m.numericKey(m.underlying(t));
        if (key && ['System.SByte', 'System.Byte', 'System.Int16', 'System.UInt16', 'System.Char'].includes(key)) return this.val(m.named('System.Int32'));
        if (e.op === '-' && key === 'System.UInt32') return this.val(m.named('System.Int64'));
        return this.val(t);
      }
    }
  }

  private binary(e: Expr & { kind: 'binary' }): Value {
    const m = this.model;
    const bool = m.named('System.Boolean');
    if (e.op === '&&' || e.op === '||') {
      this.condition(e.left);
      this.condition(e.right);
      return this.val(bool);
    }
    const lt = this.typeOf(this.expr(e.left));
    if (e.op === '??') {
      const rt = this.typeOf(this.expr(e.right, m.underlying(lt)));
      if (lt.k === 'unknown') return this.val(rt);
      if (m.isValueType(lt) && !m.isNullable(lt)) this.error(e.left, `Operator '??' cannot be applied to a non-nullable value of type '${m.display(lt)}'.`);
      const under = m.underlying(lt);
      if (rt.k === 'unknown' || m.conversion(rt, under) !== undefined) return this.val(m.isNullable(rt) ? lt : under);
      return this.val(m.conversion(under, rt) !== undefined ? rt : under);
    }
    const rt = this.typeOf(this.expr(e.right));
    if (['==', '!=', '<', '>', '<=', '>='].includes(e.op)) {
      this.userOperator(e.op, lt, rt);
      return this.val(bool);
    }
    if (lt.k === 'unknown' || rt.k === 'unknown') {
      if (e.op === '+' && (isString(lt) || isString(rt))) return this.val(m.named('System.String'));
      return this.val(UNKNOWN);
    }
    if (e.op === '+' && (isString(lt) || isString(rt))) return this.val(m.named('System.String'));
    if (e.op === '<<' || e.op === '>>') return this.val(this.promote(lt, m.named('System.Int32')) ?? lt);
    if ((e.op === '&' || e.op === '|' || e.op === '^') && sameType(m.underlying(lt), bool)) return this.val(lt);
    const user = this.userOperator(e.op, lt, rt);
    if (user) return this.val(user);
    // Enum arithmetic and bitwise operators.
    const le = m.underlying(lt);
    const re = m.underlying(rt);
    if (le.k === 'named' && le.def.kind === 'enum') return this.val(e.op === '-' && re.k === 'named' && re.def === le.def ? m.named('System.Int32') : lt);
    if (re.k === 'named' && re.def.kind === 'enum') return this.val(rt);
    const promoted = this.promote(le, re);
    if (promoted) return this.val(m.isNullable(lt) || m.isNullable(rt) ? m.nullableOf(promoted) : promoted);
    this.error(e, `Operator '${e.op}' cannot be applied to operands of type '${m.display(lt)}' and '${m.display(rt)}'.`);
    return this.val(UNKNOWN);
  }

  /** Binary numeric promotion (C# spec §7.3.6.2). */
  private promote(a: Type, b: Type): Type | undefined {
    const m = this.model;
    const ak = m.numericKey(a);
    const bk = m.numericKey(b);
    if (!ak || !bk) return undefined;
    const has = (k: string) => ak === k || bk === k;
    if (has('System.Decimal')) return has('System.Single') || has('System.Double') ? undefined : m.named('System.Decimal');
    if (has('System.Double')) return m.named('System.Double');
    if (has('System.Single')) return m.named('System.Single');
    if (has('System.UInt64')) return has('System.SByte') || has('System.Int16') || has('System.Int32') || has('System.Int64') ? undefined : m.named('System.UInt64');
    if (has('System.Int64')) return m.named('System.Int64');
    if (has('System.UInt32')) return has('System.SByte') || has('System.Int16') || has('System.Int32') ? m.named('System.Int64') : m.named('System.UInt32');
    return m.named('System.Int32');
  }

  /** The result type of a user-defined operator like DateTime - DateTime, if one applies. */
  private userOperator(op: string, a: Type, b: Type): Type | undefined {
    const name = COMPOUND_OPS[op];
    if (!name) return undefined;
    const m = this.model;
    const candidates: Candidate[] = [];
    for (const t of [m.underlying(a), m.underlying(b)]) {
      if (t.k !== 'named' || m.isNumeric(t) || isString(t)) continue;
      for (const x of m.members(t, name)) if (!candidates.some((c) => c.member === x.member)) candidates.push({ member: x.member, subst: x.subst });
    }
    let best: { type: Type; cost: number } | undefined;
    for (const c of candidates) {
      if (c.member.params.length !== 2) continue;
      const p0 = m.resolve(c.member.params[0].type, c.subst);
      const p1 = m.resolve(c.member.params[1].type, c.subst);
      const c0 = m.conversion(m.underlying(a), p0);
      const c1 = m.conversion(m.underlying(b), p1);
      if (c0 === undefined || c1 === undefined) continue;
      if (!best || c0 + c1 < best.cost) best = { type: m.resolve(c.member.type, c.subst), cost: c0 + c1 };
    }
    if (best && (m.isNullable(a) || m.isNullable(b))) return m.nullableOf(best.type);
    return best?.type;
  }

  private commonType(a: Type, b: Type, ea?: Span, eb?: Span): Type {
    const m = this.model;
    if (a.k === 'unknown') return b;
    if (b.k === 'unknown') return a;
    if (a.k === 'null') return m.nullableOf(b);
    if (b.k === 'null') return m.nullableOf(a);
    if (m.conversion(b, a) !== undefined) return a;
    if (m.conversion(a, b) !== undefined) return b;
    if (ea && eb) this.error({ start: ea.start, end: eb.end }, `Type of conditional expression cannot be determined because there is no implicit conversion between '${m.display(a)}' and '${m.display(b)}'.`);
    return a;
  }

  // ---- overload resolution ----------------------------------------------------------------------

  /**
   * Picks the overload of `candidates` that `args` call, infers its type arguments, binds the
   * arguments against it (so lambda bodies see their parameter types), and records signature help.
   */
  private resolveCall(candidates: Candidate[], list: ArgumentList, receiver: Type | undefined, typeArgs: Type[] | undefined, name: string, nameSpan: Span): Resolution | undefined {
    const m = this.model;
    const infos: ArgInfo[] = list.args.map((arg) => {
      if (arg.value.kind === 'lambda') return { arg, lambda: arg.value, type: UNKNOWN };
      if (arg.value.kind === 'declaration') return { arg, outDecl: arg.value, type: UNKNOWN };
      const value = this.expr(arg.value);
      const literal = constantKind(arg.value, value);
      if (value.kind === 'type') this.error(arg.value, `'${m.display(value.type)}' is a type, which isn't valid here.`);
      return { arg, value, type: this.typeOf(value), literal };
    });

    const all: Resolution[] = [];
    for (const c of candidates) {
      const r = this.tryCandidate(c, infos, receiver, typeArgs);
      if (r) all.push(r);
    }
    // Resolve the way .NET Framework would: overloads it lacks only count when nothing else
    // applies. So `s.Split(',')` is Split(params char[]), not .NET Core's Split(char, options).
    const framework = all.filter((r) => !r.candidate.member.notInFramework);
    const resolutions = framework.length ? framework : all;
    // Instance methods win over extension methods (C# spec §7.6.5.2).
    const instance = resolutions.filter((r) => !r.candidate.extension);
    const pool = instance.length ? instance : resolutions;
    pool.sort((a, b) => a.cost - b.cost);
    let chosen: Resolution | undefined = pool[0];

    if (!chosen) {
      // Nothing applies. Fall back to the first overload whose arity fits, so the call still has
      // a type and the lambdas still get parameter types; only report a wrong argument count,
      // since a failed conversion may just be a gap in the model.
      for (const c of candidates) {
        const mapping = this.mapArgs(c, infos, receiver);
        if (!mapping) continue;
        const subst = this.inferAndSubst(c, infos, mapping, receiver, typeArgs);
        chosen = { candidate: c, subst, paramFor: mapping.paramFor, expanded: mapping.expanded, cost: Infinity };
        break;
      }
      if (!chosen && candidates.length) {
        const shown = name === 'this[]' ? 'this' : name === '.ctor' ? candidates[0].member.declaring.name : name;
        const n = list.args.length;
        this.error(nameSpan, name === 'this[]' ? `No indexer takes ${n} arguments.` : `No overload for method '${shown}' takes ${n} argument${n === 1 ? '' : 's'}.`);
      } else if (chosen) {
        this.reportArgumentMismatch(candidates, infos, receiver, typeArgs);
      }
    }

    // Final binding of lambdas and out variables against the chosen overload.
    infos.forEach((info, i) => {
      const pi = chosen?.paramFor[i];
      const param = pi !== undefined ? chosen?.candidate.member.params[pi] : undefined;
      let pt = param && chosen ? m.resolve(param.type, chosen.subst) : UNKNOWN;
      if (param?.modifier === 'params' && chosen?.expanded && pt.k === 'array') pt = pt.element;
      if (info.lambda) {
        const sig = m.delegateSignature(pt);
        this.lambda(info.lambda, sig?.params ?? [], sig?.ret);
      } else if (info.outDecl) {
        const d = info.outDecl;
        const type = d.type.kind === 'var' ? pt : this.resolveType(d.type);
        this.declare({ name: d.designation.name, type, decl: d.designation, kind: 'local' });
      }
      if (info.arg.modifier && param && param.modifier !== info.arg.modifier && !(param.modifier === 'this')) {
        this.error(info.arg, `Argument ${i + 1} must not be passed with the '${info.arg.modifier}' keyword.`);
      } else if (!info.arg.modifier && param && (param.modifier === 'out' || param.modifier === 'ref')) {
        this.error(info.arg, `Argument ${i + 1} must be passed with the '${param.modifier}' keyword.`);
      }
    });

    // Signature help: inside the parentheses, after the open bracket.
    const inner = this.signature && this.signature.span.start >= list.start && this.signature.span.end <= list.end;
    if (this.recording && !inner && this.probe > list.open && (list.close === undefined || this.probe <= list.close)) {
      const argIndex = list.commas.filter((c) => c < this.probe).length;
      const shownCandidates = candidates.filter((c) => !c.extension || !instance.length || !candidates.some((x) => !x.extension));
      const display = shownCandidates.length ? shownCandidates : candidates;
      const picked = chosen;
      const active = picked ? display.findIndex((c) => c.member === picked.candidate.member) : undefined;
      const argName = list.args[argIndex]?.name;
      this.signature = {
        candidates: display.map((c) => (chosen && c.member === chosen.candidate.member ? { ...c, subst: chosen.subst } : c)),
        active: active !== undefined && active >= 0 ? active : undefined,
        argIndex,
        argName,
        span: list,
      };
    }
    return chosen;
  }

  /**
   * When no overload applies, reports the first argument that can't convert, but only if every
   * overload whose arity fits fails on an argument whose types the model knows completely. A
   * failure that might come from a gap in the model stays quiet.
   */
  private reportArgumentMismatch(candidates: Candidate[], infos: ArgInfo[], receiver: Type | undefined, typeArgs: Type[] | undefined): void {
    const m = this.model;
    let first: { index: number; from: Type; to: Type } | undefined;
    let fitting = 0;
    for (const c of candidates) {
      const mapping = this.mapArgs(c, infos, receiver);
      if (!mapping) continue;
      fitting++;
      const subst = this.inferAndSubst(c, infos, mapping, receiver, typeArgs);
      let failure: { index: number; from: Type; to: Type } | undefined;
      for (let i = 0; i < infos.length && !failure; i++) {
        const info = infos[i];
        if (info.lambda || info.outDecl || info.value?.kind !== 'value') continue;
        const pi = mapping.paramFor[i];
        const param = c.member.params[pi];
        let pt = m.resolve(param.type, subst);
        if (param.modifier === 'params' && mapping.expanded && pi === c.member.params.length - 1 && pt.k === 'array') pt = pt.element;
        if (!m.isDefinite(info.type) || !m.isDefinite(pt)) continue;
        if (m.conversion(info.type, pt, info.literal) === undefined) failure = { index: i, from: info.type, to: pt };
      }
      if (!failure) return;
      first ??= failure;
    }
    if (!first || fitting === 0) return;
    const arg = infos[first.index].arg;
    const what = first.from.k === 'null' ? 'null' : `'${m.display(first.from)}'`;
    this.error(arg, `Argument ${first.index + 1}: cannot convert from ${what} to '${m.display(first.to)}'.`);
  }

  /** Maps arguments to parameters, or undefined when the arity can't fit. */
  private mapArgs(c: Candidate, infos: ArgInfo[], receiver: Type | undefined): { paramFor: number[]; expanded: boolean } | undefined {
    const params = c.member.params;
    const offset = c.extension && receiver ? 1 : 0;
    const paramFor: number[] = [];
    const used = new Set<number>();
    let expanded = false;
    const last = params.length - 1;
    for (let i = 0; i < infos.length; i++) {
      const a = infos[i].arg;
      if (a.name) {
        const idx = params.findIndex((p, k) => k >= offset && p.name === a.name);
        if (idx < 0 || used.has(idx)) return undefined;
        paramFor.push(idx);
        used.add(idx);
        continue;
      }
      let idx = i + offset;
      if (idx >= params.length || (idx === last && params[last].modifier === 'params' && expanded)) {
        if (params[last]?.modifier === 'params') {
          idx = last;
          expanded = true;
        } else return undefined;
      }
      if (idx === last && params[last].modifier === 'params' && infos.length - offset !== params.length - offset) {
        // More (or fewer) arguments than parameters: only the expanded form fits.
        expanded = true;
      } else if (idx === last && params[last].modifier === 'params' && infos[i].type.k !== 'array' && infos[i].type.k !== 'unknown' && infos[i].type.k !== 'null') {
        expanded = true;
      }
      paramFor.push(idx);
      used.add(idx);
    }
    for (let k = offset; k < params.length; k++) {
      if (used.has(k)) continue;
      if (params[k].defaultText !== undefined || params[k].modifier === 'params') continue;
      return undefined;
    }
    if (params[last]?.modifier === 'params' && !used.has(last)) expanded = true;
    return { paramFor, expanded };
  }

  private tryCandidate(c: Candidate, infos: ArgInfo[], receiver: Type | undefined, typeArgs: Type[] | undefined): Resolution | undefined {
    const m = this.model;
    if (typeArgs && c.member.typeParams.length !== typeArgs.length) return undefined;
    const mapping = this.mapArgs(c, infos, receiver);
    if (!mapping) return undefined;
    const subst = this.inferAndSubst(c, infos, mapping, receiver, typeArgs);
    if (!m.satisfiesConstraints(c.member, subst)) return undefined;
    let cost = mapping.expanded ? 0.5 : 0;
    if (c.extension && receiver) {
      const pt = m.resolve(c.member.params[0].type, subst);
      const conv = m.conversion(receiver, pt);
      if (conv === undefined) return undefined;
      cost += conv;
    }
    for (let i = 0; i < infos.length; i++) {
      const info = infos[i];
      const param = c.member.params[mapping.paramFor[i]];
      let pt = m.resolve(param.type, subst);
      if (param.modifier === 'params' && mapping.expanded && mapping.paramFor[i] === c.member.params.length - 1 && pt.k === 'array') pt = pt.element;
      if (info.outDecl) {
        if (param.modifier !== 'out') return undefined;
        continue;
      }
      if (info.lambda) {
        const sig = m.delegateSignature(pt);
        if (!sig) {
          if (pt.k === 'unknown' || pt.k === 'param') continue;
          return undefined;
        }
        if (sig.params.length !== info.lambda.params.length) return undefined;
        const bodyType = this.speculate(() => this.lambda(info.lambda!, sig.params, sig.ret));
        if (!(sig.ret.k === 'named' && sig.ret.def.key === 'System.Void')) {
          if (bodyType.k === 'named' && bodyType.def.key === 'System.Void') return undefined;
          const conv = m.conversion(bodyType, sig.ret);
          if (conv === undefined) return undefined;
          cost += conv / 10;
        }
        continue;
      }
      const conv = m.conversion(info.type, pt, info.literal);
      if (conv === undefined) return undefined;
      cost += conv;
    }
    // Prefer non-generic and fewer optional parameters on ties.
    cost += c.member.typeParams.length * 0.01 + (c.member.params.length - infos.length) * 0.001;
    return { candidate: c, subst, paramFor: mapping.paramFor, expanded: mapping.expanded, cost };
  }

  /** Infers the method's type arguments (C# spec §7.5.2, simplified) and returns the full substitution. */
  private inferAndSubst(c: Candidate, infos: ArgInfo[], mapping: { paramFor: number[]; expanded: boolean }, receiver: Type | undefined, typeArgs: Type[] | undefined): Subst {
    const m = this.model;
    const member = c.member;
    const full = new Map(c.subst);
    if (member.typeParams.length === 0) return full;
    if (typeArgs) {
      member.typeParams.forEach((p, i) => full.set(p, typeArgs[i] ?? UNKNOWN));
      return full;
    }
    // Method type parameters may already be partly known (an extension on a known receiver).
    for (const p of member.typeParams) full.delete(p);
    const tps = new Set(member.typeParams);
    const bounds = new Map<string, Type[]>();
    const paramType = (pi: number) => {
      let t = m.resolve(member.params[pi].type, full);
      if (member.params[pi].modifier === 'params' && mapping.expanded && pi === member.params.length - 1 && t.k === 'array') t = t.element;
      return t;
    };
    if (c.extension && receiver) this.lowerBound(receiver, paramType(0), tps, bounds);
    infos.forEach((info, i) => {
      if (!info.lambda && !info.outDecl && info.type.k !== 'null') this.lowerBound(info.type, paramType(mapping.paramFor[i]), tps, bounds);
    });
    let fixed = this.fix(bounds);
    // Lambdas: once their parameter types are fixed, their bodies give bounds for the rest.
    for (let round = 0; round < 3; round++) {
      let progress = false;
      infos.forEach((info, i) => {
        if (!info.lambda) return;
        const pt = substitute(paramType(mapping.paramFor[i]), fixed);
        const sig = m.delegateSignature(pt);
        if (!sig || sig.params.length !== info.lambda.params.length) return;
        const unfixed = new Set([...tps].filter((t) => !fixed.has(t)));
        if (sig.params.some((p) => mentions(p, unfixed)) || !mentions(sig.ret, unfixed)) return;
        const body = this.speculate(() => this.lambda(info.lambda!, sig.params, undefined));
        if (body.k === 'unknown' || body.k === 'null') return;
        this.lowerBound(body, sig.ret, unfixed, bounds);
        progress = true;
      });
      fixed = this.fix(bounds);
      if (!progress) break;
    }
    for (const p of member.typeParams) full.set(p, fixed.get(p) ?? UNKNOWN);
    return full;
  }

  /** Records lower bounds on type parameters `tps` from `from` flowing into `to`. */
  private lowerBound(from: Type, to: Type, tps: ReadonlySet<string>, bounds: Map<string, Type[]>): void {
    const m = this.model;
    if (from.k === 'unknown' || from.k === 'null') return;
    if (to.k === 'param') {
      if (!tps.has(to.name)) return;
      const list = bounds.get(to.name) ?? [];
      if (!list.some((b) => sameType(b, from))) list.push(from);
      bounds.set(to.name, list);
      return;
    }
    if (to.k === 'array') {
      if (from.k === 'array') this.lowerBound(from.element, to.element, tps, bounds);
      return;
    }
    if (to.k !== 'named' || to.args.length === 0) return;
    if (m.isNullable(to) && !m.isNullable(from)) {
      this.lowerBound(from, to.args[0], tps, bounds);
      return;
    }
    const match = from.k === 'named' && from.def === to.def ? from : m.findSupertype(from, to.def.key);
    if (match && match.k === 'named') to.args.forEach((a, i) => this.lowerBound(match.args[i] ?? UNKNOWN, a, tps, bounds));
  }

  private fix(bounds: Map<string, Type[]>): Map<string, Type> {
    const m = this.model;
    const out = new Map<string, Type>();
    for (const [name, list] of bounds) {
      const best = list.find((b) => list.every((o) => m.conversion(o, b) !== undefined)) ?? list[0];
      if (best) out.set(name, best);
    }
    return out;
  }
}

function isString(t: Type): boolean {
  return t.k === 'named' && t.def.key === 'System.String';
}

/** A default value as shown in a signature. The tree only keeps literals' text. */
function defaultText(e: Expr): string {
  return e.kind === 'literal' ? e.text : '…';
}

/** A signature type as a reference, for local functions. Types the model can't name become unknown. */
function toRef(t: Type): TypeRef {
  switch (t.k) {
    case 'named':
      return { kind: 'named', key: t.def.key, args: t.args.map(toRef) };
    case 'array':
      return { kind: 'array', element: toRef(t.element), rank: t.rank };
    case 'param':
      return { kind: 'param', name: t.name };
    default:
      return { kind: 'named', key: '<unknown>', args: [] };
  }
}

/**
 * `int` for an integer constant expression (which also converts to smaller integral types),
 * `zero` for a literal 0 (which converts to any enum), otherwise undefined.
 */
function constantKind(e: Expr, v: Value): 'int' | 'zero' | undefined {
  if (v.kind !== 'value' || v.type.k !== 'named' || v.type.def.key !== 'System.Int32') return undefined;
  if (e.kind === 'literal' && e.literal === 'int') return /^0+$/.test(e.text) ? 'zero' : 'int';
  return isConstant(e) ? 'int' : undefined;
}

function isConstant(e: Expr): boolean {
  switch (e.kind) {
    case 'literal':
      return e.literal !== 'null';
    case 'paren':
    case 'checked':
      return isConstant(e.inner);
    case 'unary':
      return !e.postfix && ['-', '+', '~'].includes(e.op) && isConstant(e.operand);
    case 'binary':
      return ['+', '-', '*', '/', '%', '<<', '>>', '&', '|', '^'].includes(e.op) && isConstant(e.left) && isConstant(e.right);
    case 'cast':
      return isConstant(e.operand);
    case 'member':
      // `int.MaxValue` and other constants; members of a type, not of a value.
      return false;
    default:
      return false;
  }
}

// ---- reachability ------------------------------------------------------------------------------

/**
 * Whether the end of `s` can be reached (C# spec §8.1). Only `true` itself counts as a constant
 * condition. When unsure this answers false, so a missing return is never reported wrongly.
 */
export function endReachable(s: Stmt): boolean {
  switch (s.kind) {
    case 'block': {
      for (const st of s.statements) if (!endReachable(st)) return false;
      return true;
    }
    case 'return':
    case 'throw':
    case 'break':
    case 'continue':
      return false;
    case 'if':
      if (!s.else) return !isTrue(s.condition) || endReachable(s.then);
      return endReachable(s.then) || endReachable(s.else);
    case 'while':
      return !isTrue(s.condition) || breaks(s.body);
    case 'for':
      return (s.condition !== undefined && !isTrue(s.condition)) || breaks(s.body);
    case 'do':
      return breaks(s.body) || (!isTrue(s.condition) && (endReachable(s.body) || continues(s.body)));
    case 'switch': {
      const hasDefault = s.sections.some((sec) => sec.labels.some((l) => l.kind === 'default'));
      return !hasDefault || s.sections.some((sec) => sec.statements.some(breaks));
    }
    case 'try':
      if (s.finally && !endReachable(s.finally)) return false;
      return endReachable(s.block) || s.catches.some((c) => endReachable(c.block));
    case 'using':
    case 'lock':
      return endReachable(s.body);
    default:
      return true;
  }
}

function isTrue(e: Expr): boolean {
  return (e.kind === 'literal' && e.literal === 'bool' && e.text === 'true') || (e.kind === 'paren' && isTrue(e.inner));
}

/** Whether `s` has a `break` that leaves the enclosing loop or switch (not a nested one). */
function breaks(s: Stmt): boolean {
  return jumps(s, 'break');
}

function continues(s: Stmt): boolean {
  return jumps(s, 'continue');
}

function jumps(s: Stmt, kind: 'break' | 'continue'): boolean {
  switch (s.kind) {
    case 'break':
    case 'continue':
      return s.kind === kind;
    case 'block':
      return s.statements.some((x) => jumps(x, kind));
    case 'if':
      return jumps(s.then, kind) || (!!s.else && jumps(s.else, kind));
    case 'try':
      return jumps(s.block, kind) || s.catches.some((c) => jumps(c.block, kind)) || (!!s.finally && jumps(s.finally, kind));
    case 'using':
    case 'lock':
      return jumps(s.body, kind);
    case 'switch':
      // A break inside a switch leaves the switch; a continue still targets the loop.
      return kind === 'continue' && s.sections.some((sec) => sec.statements.some((x) => jumps(x, kind)));
    default:
      // Nested loops own their own break and continue.
      return false;
  }
}

export function bind(model: TypeModel, parsed: Parsed, probe = -1, expected?: Type, shapes?: ShapeEnv, wantedShape?: Type): BindResult {
  return new Binder(model, probe, expected, shapes, wantedShape).bind(parsed);
}

/**
 * How a value of type `got` fails to be `want`, as "an int" or "an object"; undefined when it
 * fits or can't be told. Only clear cases count: a scalar where an object or array is wanted (or
 * the reverse), or a scalar that doesn't convert to the wanted one.
 */
function mismatch(m: TypeModel, got: Type, want: Type): string | undefined {
  if (got.k === 'unknown' || got.k === 'null' || want.k === 'unknown') return undefined;
  const ws = shapeOf(want);
  const gs = shapeOf(got);
  const isToken = (t: Type) => t.k === 'named' && (t.def.key.startsWith('Newtonsoft.Json.Linq.') || t.def.key === 'System.Object');
  if (ws && ws.kind !== 'value') {
    const kind = ws.kind === 'object' ? 'an object' : 'an array';
    if (gs && gs.kind !== 'value' && gs.kind !== ws.kind) return kind;
    if (!gs && !isToken(got)) return `${kind}, not ${m.display(got)}`;
    return undefined;
  }
  if (gs && gs.kind !== 'value') return `${m.display(want)}, not ${gs.kind === 'object' ? 'an object' : 'an array'}`;
  if (isToken(got) || isToken(want)) return undefined;
  return m.conversion(got, want) === undefined ? `${m.display(want)}, not ${m.display(got)}` : undefined;
}

/** `context.Variables` (or `(context).Variables`), whose entries carry the variables' shapes. */
function isVariables(e: Expr | undefined): boolean {
  while (e?.kind === 'paren') e = e.inner;
  if (e?.kind !== 'member' || e.name !== 'Variables') return false;
  let t: Expr = e.target;
  while (t.kind === 'paren') t = t.inner;
  return t.kind === 'name' && t.name === 'context';
}

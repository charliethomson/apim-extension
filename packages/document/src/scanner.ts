/**
 * Tolerant parser for APIM policy documents in either the rawxml or the escaped xml format.
 *
 * It is an XML scanner that hands control to the C# lexer whenever an attribute value, a
 * text node or a CDATA section starts with `@(` or `@{`. The lexer owns the input until the
 * balanced close, so `"`, `<` and `&&` inside expressions never confuse the XML structure.
 * The lexer runs over an entity-decoded copy of the document, so `&quot;)&quot;` in the
 * escaped format is a string containing `)` just as `")"` is in rawxml.
 *
 * The parser never throws. Problems become diagnostics and it recovers as locally as it can.
 */

import { SourceMap, SourceMapBuilder, type OffsetRange } from '@charliethomson/apim-core';
import type {
  Attribute,
  CData,
  Document,
  Element,
  Expression,
  NamedValue,
  Node,
  ParseDiagnostic,
  ParseErrorCode,
  Text,
} from './ast';
import { scanBalanced } from '@charliethomson/apim-csharp-lexer';
import { decodeEntities, type Decoded } from './entities';

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const NAMED_VALUE = /\{\{([A-Za-z0-9._-]+)\}\}/g;

export function parse(source: string): Document {
  return new Parser(source).run();
}

/** Finds `{{name}}` tokens in `text`, which starts at document offset `base`. */
export function findNamedValues(text: string, base: number): NamedValue[] {
  const out: NamedValue[] = [];
  for (const m of text.matchAll(NAMED_VALUE)) {
    out.push({ name: m[1], range: { start: base + m.index, end: base + m.index + m[0].length } });
  }
  return out;
}

class Parser {
  private pos = 0;
  private readonly diagnostics: ParseDiagnostic[] = [];
  private readonly expressions: Expression[] = [];
  private readonly stack: Element[] = [];
  private readonly top: Node[] = [];
  private decodedCache?: Decoded;

  constructor(private readonly src: string) {}

  /** The whole document with entities decoded, computed on first use. */
  private get decoded(): Decoded {
    return (this.decodedCache ??= decodeEntities(this.src));
  }

  run(): Document {
    const src = this.src;
    while (this.pos < src.length) {
      if (src.startsWith('<!--', this.pos)) this.comment();
      else if (src.startsWith('<![CDATA[', this.pos)) this.cdata();
      else if (src.startsWith('<?', this.pos)) this.declaration('?>');
      else if (src.startsWith('<!', this.pos)) this.declaration('>');
      else if (src.startsWith('</', this.pos)) this.endTag();
      else if (src[this.pos] === '<' && this.isNameStart(this.pos + 1)) this.startTag();
      else this.text();
    }
    while (this.stack.length > 0) {
      const el = this.stack.pop()!;
      this.report(el.nameRange, `Missing end tag for <${el.name}>.`, 'missing-end-tag');
      el.range.end = src.length;
    }
    const roots = this.top.filter((n): n is Element => n.type === 'element');
    for (const extra of roots.slice(1)) {
      this.report(extra.nameRange, 'A document can only have one root element.', 'multiple-roots');
    }
    return {
      source: src,
      children: this.top,
      root: roots[0],
      diagnostics: this.diagnostics,
      expressions: this.expressions.sort((a, b) => a.range.start - b.range.start),
    };
  }

  // ---- structure ------------------------------------------------------------------------

  private get children(): Node[] {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1].children : this.top;
  }

  private report(range: OffsetRange, message: string, code: ParseErrorCode): void {
    this.diagnostics.push({ range, message, code });
  }

  private isNameStart(i: number): boolean {
    const c = this.src[i];
    return c !== undefined && /[A-Za-z_:]/.test(c);
  }

  private readName(): OffsetRange | undefined {
    NAME.lastIndex = this.pos;
    const m = NAME.exec(this.src);
    if (!m) return undefined;
    const r = { start: this.pos, end: this.pos + m[0].length };
    this.pos = r.end;
    return r;
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  // ---- markup -----------------------------------------------------------------------------

  private comment(): void {
    const start = this.pos;
    const close = this.src.indexOf('-->', start + 4);
    if (close === -1) {
      this.pos = this.src.length;
      this.report({ start, end: start + 4 }, 'Unterminated comment.', 'unterminated-comment');
    } else {
      this.pos = close + 3;
    }
    this.children.push({ type: 'comment', range: { start, end: this.pos } });
  }

  private declaration(terminator: string): void {
    const start = this.pos;
    const close = this.src.indexOf(terminator, start + 2);
    if (close === -1) {
      this.pos = this.src.length;
      this.report({ start, end: start + 2 }, `Unterminated declaration, expected '${terminator}'.`, 'unterminated-declaration');
    } else {
      this.pos = close + terminator.length;
    }
    this.children.push({ type: 'declaration', range: { start, end: this.pos } });
  }

  private cdata(): void {
    const start = this.pos;
    const contentStart = start + 9;
    let contentEnd = this.src.indexOf(']]>', contentStart);
    if (contentEnd === -1) {
      contentEnd = this.src.length;
      this.pos = contentEnd;
      this.report({ start, end: contentStart }, 'Unterminated CDATA section.', 'unterminated-cdata');
    } else {
      this.pos = contentEnd + 3;
    }
    const node: CData = {
      type: 'cdata',
      range: { start, end: this.pos },
      contentRange: { start: contentStart, end: contentEnd },
      namedValues: [],
    };
    const at = firstNonWs(this.src, contentStart, contentEnd);
    const expr = this.isExpressionStart(at) ? this.expressionInCData(at, contentEnd) : undefined;
    if (expr && expr !== 'failed') {
      node.expression = expr;
      node.namedValues = expr.namedValues;
      this.trailingText(expr.range.end, contentEnd);
    } else {
      node.namedValues = findNamedValues(this.src.slice(contentStart, contentEnd), contentStart);
    }
    this.children.push(node);
  }

  private endTag(): void {
    const start = this.pos;
    this.pos += 2;
    const nameRange = this.readName();
    this.skipWs();
    if (this.src[this.pos] === '>') {
      this.pos++;
    } else {
      this.report({ start, end: this.pos }, "Unterminated end tag, expected '>'.", 'unterminated-tag');
    }
    const range = { start, end: this.pos };
    const name = nameRange ? this.src.slice(nameRange.start, nameRange.end) : '';
    const at = findLastIndex(this.stack, (e) => e.name === name);
    if (at === -1) {
      this.report(range, name ? `Unexpected end tag </${name}>.` : 'Unexpected end tag.', 'unexpected-end-tag');
      return;
    }
    // Close anything left open inside the matching element.
    while (this.stack.length > at + 1) {
      const el = this.stack.pop()!;
      this.report(el.nameRange, `Missing end tag for <${el.name}>.`, 'missing-end-tag');
      el.range.end = start;
    }
    const el = this.stack.pop()!;
    el.endTag = range;
    el.range.end = range.end;
  }

  private startTag(): void {
    const start = this.pos;
    this.pos++;
    const nameRange = this.readName()!;
    const el: Element = {
      type: 'element',
      name: this.src.slice(nameRange.start, nameRange.end),
      nameRange,
      range: { start, end: start },
      startTag: { start, end: start },
      selfClosing: false,
      attributes: [],
      children: [],
    };
    this.children.push(el);

    let closed = false;
    while (this.pos < this.src.length) {
      this.skipWs();
      const c = this.src[this.pos];
      if (c === '>') {
        this.pos++;
        closed = true;
        break;
      }
      if (c === '/' && this.src[this.pos + 1] === '>') {
        this.pos += 2;
        el.selfClosing = true;
        closed = true;
        break;
      }
      if (c === '<' || c === undefined) break;
      if (this.isNameStart(this.pos)) {
        const attr = this.attribute();
        if (el.attributes.some((a) => a.name === attr.name)) {
          this.report(attr.nameRange, `Duplicate attribute '${attr.name}'.`, 'duplicate-attribute');
        }
        el.attributes.push(attr);
        continue;
      }
      this.report({ start: this.pos, end: this.pos + 1 }, `Unexpected character '${c}' in tag.`, 'unexpected-character');
      this.pos++;
    }
    if (!closed) {
      this.report(nameRange, `Unterminated start tag <${el.name}>.`, 'unterminated-tag');
    }
    el.startTag.end = this.pos;
    el.range.end = this.pos;
    if (closed && !el.selfClosing) this.stack.push(el);
  }

  private attribute(): Attribute {
    const nameRange = this.readName()!;
    const attr: Attribute = {
      name: this.src.slice(nameRange.start, nameRange.end),
      nameRange,
      range: { ...nameRange },
      namedValues: [],
    };
    const afterName = this.pos;
    this.skipWs();
    if (this.src[this.pos] !== '=') {
      this.pos = afterName;
      this.report(nameRange, `Attribute '${attr.name}' has no value.`, 'attribute-without-value');
      return attr;
    }
    this.pos++;
    this.skipWs();
    const quote = this.src[this.pos];
    if (quote !== '"' && quote !== "'") {
      // Unquoted value: take up to whitespace or the end of the tag.
      const start = this.pos;
      while (this.pos < this.src.length && !/[\s>]/.test(this.src[this.pos]) && !this.src.startsWith('/>', this.pos)) {
        this.pos++;
      }
      this.report({ start: nameRange.start, end: this.pos }, `Value of '${attr.name}' must be quoted.`, 'unquoted-attribute');
      this.setValue(attr, start, this.pos);
      attr.range.end = this.pos;
      return attr;
    }

    const valueStart = this.pos + 1;
    const at = firstNonWs(this.src, valueStart, this.src.length);
    if (this.isExpressionStart(at)) {
      const expr = this.expressionInDecoded(at);
      if (expr !== 'failed') {
        const afterExpr = firstNonWs(this.src, expr.range.end, this.src.length);
        if (this.src[afterExpr] === quote) {
          this.pos = afterExpr + 1;
          this.setValue(attr, valueStart, afterExpr, expr);
          attr.range.end = this.pos;
          return attr;
        }
        this.report(
          { start: expr.range.end, end: Math.min(expr.range.end + 1, this.src.length) },
          `Expected ${quote} to close attribute '${attr.name}' after the expression.`,
          'expected-quote-after-expression',
        );
        // Keep the expression and skip ahead to the most plausible closing quote.
        const found = this.findAttributeEnd(expr.range.end, quote);
        const valueEnd = found === -1 ? this.recoverUnterminatedAttribute(expr.range.end) : found;
        this.setValue(attr, valueStart, valueEnd, expr);
        this.pos = found === -1 ? valueEnd : valueEnd + 1;
        attr.range.end = this.pos;
        return attr;
      }
    }

    // Plain value, or an expression that couldn't be scanned.
    const valueEnd = this.isExpressionStart(at) ? this.findAttributeEnd(valueStart, quote) : this.plainValueEnd(valueStart, quote);
    if (valueEnd === -1) {
      const stop = this.recoverUnterminatedAttribute(valueStart);
      if (!this.isExpressionStart(at)) {
        this.report({ start: nameRange.start, end: stop }, `Unterminated value for attribute '${attr.name}'.`, 'unterminated-attribute');
      }
      this.setValue(attr, valueStart, stop);
      this.pos = stop;
    } else {
      this.setValue(attr, valueStart, valueEnd);
      this.pos = valueEnd + 1;
    }
    attr.range.end = this.pos;
    return attr;
  }

  private setValue(attr: Attribute, start: number, end: number, expression?: Expression): void {
    attr.value = this.src.slice(start, end);
    attr.valueRange = { start, end };
    attr.expression = expression;
    attr.namedValues = expression ? expression.namedValues : findNamedValues(attr.value, start);
  }

  /**
   * After an expression failed to scan, guesses where the attribute ends: the first quote
   * followed by whitespace and then `>`, `/>` or another `name=`. Only looks as far as the
   * next line that starts with a tag, so one broken attribute can't swallow the document.
   * Returns -1 if there's no plausible quote.
   */
  private findAttributeEnd(from: number, quote: string): number {
    const limitMatch = /\n\s*</g;
    limitMatch.lastIndex = from;
    const limit = limitMatch.exec(this.src)?.index ?? this.src.length;
    const re = new RegExp(`${quote}(?=\\s*(?:/?>|[A-Za-z_:][-A-Za-z0-9_:.]*\\s*=))`, 'g');
    re.lastIndex = from;
    const m = re.exec(this.src);
    return m && m.index < limit ? m.index : -1;
  }

  /**
   * The closing quote of a plain value, or -1 when the value runs into a new line that starts
   * with a tag (an unclosed value being typed), so it doesn't swallow the markup that follows.
   */
  private plainValueEnd(from: number, quote: string): number {
    const close = this.src.indexOf(quote, from);
    if (close === -1) return -1;
    const boundary = /\n\s*</g;
    boundary.lastIndex = from;
    const b = boundary.exec(this.src);
    return b && b.index < close ? -1 : close;
  }

  /** Ends an unterminated attribute value at the end of its line, or before `/>` or `>`. */
  private recoverUnterminatedAttribute(from: number): number {
    let i = from;
    while (i < this.src.length && this.src[i] !== '\n' && this.src[i] !== '>' && !this.src.startsWith('/>', i)) i++;
    return i;
  }

  private text(): void {
    const start = this.pos;
    const at = firstNonWs(this.src, start, this.src.length);
    if (this.isExpressionStart(at)) {
      const expr = this.expressionInDecoded(at);
      if (expr !== 'failed') {
        const end = this.nextTagStart(expr.range.end);
        this.trailingText(expr.range.end, end);
        this.pos = end;
        this.children.push(this.textNode(start, end, expr));
        return;
      }
    }
    const end = this.nextTagStart(start);
    this.pos = end === start ? start + 1 : end; // always make progress
    this.children.push(this.textNode(start, this.pos));
  }

  /** Next `<` that starts markup; reports a stray `<` in text and skips over it. */
  private nextTagStart(from: number): number {
    let i = from;
    for (;;) {
      i = this.src.indexOf('<', i);
      if (i === -1) return this.src.length;
      const n = this.src[i + 1];
      if (n === '/' || n === '!' || n === '?' || this.isNameStart(i + 1)) return i;
      this.report({ start: i, end: i + 1 }, "Unescaped '<' in text; write '&lt;'.", 'unescaped-lt');
      i++;
    }
  }

  private textNode(start: number, end: number, expression?: Expression): Text {
    const value = this.src.slice(start, end);
    return {
      type: 'text',
      range: { start, end },
      value,
      expression,
      namedValues: expression ? expression.namedValues : findNamedValues(value, start),
    };
  }

  private trailingText(from: number, to: number): void {
    const at = firstNonWs(this.src, from, to);
    if (at < to) {
      let end = to;
      while (end > at && /\s/.test(this.src[end - 1])) end--;
      this.report({ start: at, end }, 'Unexpected text after the expression.', 'text-after-expression');
    }
  }

  // ---- expressions ------------------------------------------------------------------------

  private isExpressionStart(i: number): boolean {
    return this.src[i] === '@' && (this.src[i + 1] === '(' || this.src[i + 1] === '{');
  }

  /** Scans an expression starting at document offset `at` over the entity-decoded text. */
  private expressionInDecoded(at: number): Expression | 'failed' {
    const { text, map } = this.decoded;
    const d = map.toGenerated(at);
    if (d === undefined) return 'failed';
    const result = scanBalanced(text, d + 1);
    if (result.close === -1) {
      const err = result.error!;
      const r = map.rangeToSource({ start: err.start, end: err.end }) ?? { start: at, end: at + 2 };
      this.report(r, err.message, 'unterminated-expression');
      return 'failed';
    }
    const closeSrc = map.toSource(result.close)!;
    return this.makeExpression(at, closeSrc, text.slice(d + 2, result.close), map.slice(d + 2, result.close));
  }

  /** Scans an expression inside CDATA, where entities are not decoded. */
  private expressionInCData(at: number, end: number): Expression | 'failed' {
    const result = scanBalanced(this.src, at + 1, end);
    if (result.close === -1) {
      const err = result.error!;
      this.report({ start: err.start, end: err.end }, err.message, 'unterminated-expression');
      return 'failed';
    }
    const map = new SourceMapBuilder().copy(at + 2, result.close - (at + 2)).build();
    return this.makeExpression(at, result.close, this.src.slice(at + 2, result.close), map);
  }

  private makeExpression(at: number, close: number, code: string, map: SourceMap): Expression {
    const namedValues: NamedValue[] = [];
    for (const nv of findNamedValues(code, 0)) {
      const r = map.rangeToSource(nv.range);
      if (r) namedValues.push({ name: nv.name, range: r });
    }
    const expr: Expression = {
      kind: this.src[at + 1] === '(' ? 'expr' : 'block',
      range: { start: at, end: close + 1 },
      codeRange: { start: at + 2, end: close },
      code,
      map,
      namedValues,
    };
    this.expressions.push(expr);
    return expr;
  }
}

function firstNonWs(s: string, from: number, to: number): number {
  let i = from;
  while (i < to && /\s/.test(s[i])) i++;
  return i;
}

function findLastIndex<T>(arr: readonly T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

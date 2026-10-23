/**
 * Formatting for policies. It changes indentation and the line breaks between elements, nothing
 * else: no characters of expressions, attribute values, text, comments or CDATA change.
 *
 * - Elements are re-indented, one per line, with at most one blank line between them.
 * - The C# in a multi-line expression is re-indented from its bracket nesting: one level per open
 *   bracket, one more for a line that continues the one before (`.Where(…)`, `&& …`), and a
 *   closing bracket back at its opener's level. Lines inside a multi-line string or comment keep
 *   their whitespace, since it's part of them.
 * - A fragment header is brought into its standard shape (policy/headerShape.ts): aligned
 *   columns, one tag per line. Like everything else, only its whitespace changes; a header the
 *   shape can't hold is left as written.
 * - A start tag's attributes on later lines, and a comment's later lines, move with the first
 *   line. Whitespace that is part of a value (inside an attribute value, text, CDATA) never
 *   changes.
 *
 * Every edit belongs to the node whose layout produced it (`group`), so formatting part of a
 * document applies a node's edits together or not at all. A document with structural parse
 * errors isn't formatted: where its elements end is a guess.
 */

import type { Document, Element, Expression, Node } from '../parser/ast';
import { lex, type Token } from '../parser/csharpLexer';
import { fragmentDoc } from './fragmentDoc';
import { readHeaderComment, renderHeader } from './headerShape';

export interface FormatOptions {
  tabSize: number;
  insertSpaces: boolean;
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
  /** Start offset of the node the edit lays out; partial formatting keeps groups whole. */
  group: number;
}

/** Errors that make the element structure uncertain. */
const STRUCTURAL = new Set(['unterminated-comment', 'unterminated-cdata', 'unterminated-tag', 'unterminated-attribute', 'unterminated-expression', 'unexpected-end-tag', 'missing-end-tag']);

export function formatPolicy(doc: Document, options: FormatOptions): TextEdit[] {
  if (doc.diagnostics.some((d) => STRUCTURAL.has(d.code))) return [];
  // Top-level text other than whitespace means it isn't ours to lay out.
  if (doc.children.some((n) => n.type === 'text' && n.value.trim())) return [];
  const src = doc.source;
  const edits: TextEdit[] = [];
  const unit = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
  const indent = (depth: number) => unit.repeat(Math.max(depth, 0));
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const columnOf = (offset: number) => width(src.slice(lineStarts[lineOf(offset)], offset), options.tabSize);
  /** The line's leading whitespace, or undefined for a blank line. */
  const leading = (line: number) => {
    const ls = lineStarts[line];
    const ws = /^[ \t]*/.exec(src.slice(ls, lineStarts[line + 1] ?? src.length))![0];
    const next = src[ls + ws.length];
    return next === undefined || next === '\n' || next === '\r' ? undefined : ws;
  };
  const header = fragmentDoc(doc)?.range;
  /** Lines an expression has decided the indentation of, which its element's shift leaves alone. */
  const owned = new Set<number>();

  const setIndent = (line: number, text: string, group: number) => {
    const ws = leading(line);
    if (ws !== undefined && ws !== text) edits.push({ start: lineStarts[line], end: lineStarts[line] + ws.length, text, group });
  };

  /** Replace whitespace `[start, end)` between nodes with a line break (or two) and `depth`'s indent. */
  const gap = (start: number, end: number, depth: number, keepBlank: boolean, group: number, atStart = false) => {
    const old = src.slice(start, end);
    const blank = keepBlank && (old.match(/\n/g)?.length ?? 0) >= 2;
    const text = atStart ? '' : `${blank ? '\n\n' : '\n'}${indent(depth)}`;
    if (old !== text) edits.push({ start, end, text, group });
  };

  /**
   * Moves the lines after the first of `[start, end)` by `delta` columns, the way the first line
   * moved; `movable` says whether a line (by its first character's offset) may move.
   */
  const shift = (start: number, end: number, delta: number, group: number, movable: (at: number) => boolean = () => true) => {
    if (delta === 0) return;
    for (let line = lineOf(start) + 1; line <= lineOf(end); line++) {
      const ws = leading(line);
      if (ws === undefined || owned.has(line) || !movable(lineStarts[line] + ws.length)) continue;
      // Add or take indentation at the start, keeping whatever aligns the rest of the line.
      let text: string;
      if (delta > 0) text = (options.insertSpaces ? ' '.repeat(delta) : '\t'.repeat(Math.floor(delta / options.tabSize)) + ' '.repeat(delta % options.tabSize)) + ws;
      else {
        let cut = 0;
        while (cut < ws.length && width(ws.slice(0, cut), options.tabSize) < -delta) cut++;
        text = ws.slice(cut);
      }
      setIndent(line, text, group);
    }
  };

  /** Re-indents a multi-line expression's C#, with its brackets at `depth` and its body inside. */
  const expression = (e: Expression, depth: number, group: number) => {
    const first = lineOf(e.range.start);
    const last = lineOf(e.range.end - 1);
    if (first === last) return;
    const levels = codeLevels(e.code, depth);
    const codeFirst = lineOf(e.codeRange.start);
    for (let line = first + 1; line <= last; line++) {
      owned.add(line);
      const ws = leading(line);
      if (ws === undefined) continue;
      // The closing bracket on its own line goes back to the expression's level.
      if (lineStarts[line] + ws.length >= e.codeRange.end) {
        setIndent(line, indent(depth), group);
        continue;
      }
      const level = levels[line - codeFirst];
      if (level !== undefined) setIndent(line, indent(level), group);
    }
  };

  /** Lays out `nodes` (an element's or the document's children) at `depth`. */
  const layout = (nodes: readonly Node[], depth: number, open: number, close: number | undefined, group: number) => {
    const items = nodes.filter((n) => n.type !== 'text');
    if (!items.length) {
      // Only whitespace inside: put the closing tag on its own line.
      if (close !== undefined && /\n/.test(src.slice(open, close))) gap(open, close, depth - 1, false, group);
      return;
    }
    let prevEnd = open;
    items.forEach((n, i) => {
      gap(prevEnd, n.range.start, depth, i > 0, n.range.start, depth === 0 && i === 0 && prevEnd === 0);
      // Where it was against where it goes: lines that only follow it move by as much.
      place(n, depth, width(indent(depth), options.tabSize) - columnOf(n.range.start));
      prevEnd = n.range.end;
    });
    if (close !== undefined) gap(prevEnd, close, depth - 1, false, group);
    else if (depth === 0 && src.slice(prevEnd) !== '\n') edits.push({ start: prevEnd, end: src.length, text: '\n', group });
  };

  const place = (n: Node, depth: number, delta: number) => {
    const group = n.range.start;
    if (n.type === 'comment' && header && n.range.start === header.start) {
      const original = src.slice(n.range.start, n.range.end);
      const model = readHeaderComment(original);
      const shaped = model && renderHeader(model, indent(depth), unit);
      // Only whitespace may change; anything else means the shape can't hold this header.
      if (shaped !== undefined && shaped.replace(/\s+/g, '') === original.replace(/\s+/g, '')) {
        if (shaped !== original) edits.push({ start: n.range.start, end: n.range.end, text: shaped, group });
        return;
      }
    }
    if (n.type !== 'element') {
      shift(n.range.start, n.range.end, delta, group);
      return;
    }
    for (const a of n.attributes) if (a.expression) expression(a.expression, depth, group);
    // Attributes on later lines move; a line that starts inside a value is part of the value.
    const inValue = (at: number) => n.attributes.some((a) => a.valueRange && at > a.valueRange.start && at < a.valueRange.end);
    shift(n.startTag.start, n.startTag.end, delta, group, (at) => !inValue(at));
    if (n.selfClosing || !n.endTag) return;
    if (isMixed(n)) {
      // Text is kept as written; only an expression that is the whole content is laid out.
      const only = soleExpression(n);
      if (only) expression(only, depth, group);
      return;
    }
    layout(n.children, depth + 1, n.startTag.end, n.endTag.start, group);
  };

  layout(doc.children, 0, 0, undefined, src.length);
  return edits.sort((a, b) => a.start - b.start);
}

/** Text (or CDATA) other than whitespace among the children: the content is kept as written. */
function isMixed(el: Element): boolean {
  return el.children.some((c) => c.type === 'cdata' || (c.type === 'text' && c.value.trim() !== ''));
}

/** The expression that is all of an element's content (`<set-body>@{ … }</set-body>`), if one is. */
function soleExpression(el: Element): Expression | undefined {
  const content = el.children.filter((c) => !(c.type === 'text' && !c.value.trim()) && c.type !== 'comment');
  if (content.length !== 1) return undefined;
  const c = content[0];
  if (c.type === 'text' && c.expression && c.value.trim().length === c.expression.range.end - c.expression.range.start) return c.expression;
  if (c.type === 'cdata' && c.expression) return c.expression;
  return undefined;
}

const OPENERS = '([{';
const CLOSERS = ')]}';
/** A line starting with one of these continues the one before. */
const CONTINUES = new Set(['.', '?', ':', '+', '-', '*', '/', '%', '&', '|', '^', '=', '<', '>']);
/** A line after one ending in one of these starts something new. */
const ENDS = new Set([';', '{', '}', ',', '(', '[']);

/**
 * The indentation level of each line of `code` (an expression whose own brackets are at `base`),
 * undefined where the line should keep its whitespace: the first line, blank lines, and lines
 * that start inside a multi-line string or comment.
 *
 * A line is one level inside the innermost bracket still open. A line that continues the one
 * before (it starts with `.` or an operator, or the one before didn't end a statement or open a
 * bracket) goes one level further than where the statement started, and a run of them stays
 * there. In a `switch`, `case` labels are one level in and their statements two.
 */
export function codeLevels(code: string, base: number): (number | undefined)[] {
  const tokens = [...lex(code)];
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  const out = new Array<number | undefined>(starts.length).fill(undefined);
  // For each bracket still open: its line's level, and whether a case label is open inside it.
  // The expression's own bracket is the bottom.
  // `statement` is the enclosing statement's start level, restored when the bracket closes.
  const stack: { level: number; inCase: boolean; statement?: number }[] = [{ level: base, inCase: false }];
  const text = (t: Token) => code.slice(t.start, t.end);
  let ti = 0;
  let previous: Token | undefined;
  /** The level of the line that started the current statement, while a continuation runs. */
  let statement: number | undefined;
  let afterLabel = false;
  for (let k = 0; k < starts.length; k++) {
    const end = starts[k + 1] ?? code.length;
    const frame = stack[stack.length - 1];
    const spanning = ti > 0 && tokens[ti - 1].end > starts[k];
    const first = tokens[ti] && tokens[ti].start < end ? tokens[ti] : undefined;
    const inner = frame.level + (frame.inCase ? 2 : 1);
    let level = k === 0 ? base : inner;
    let label = false;
    if (k > 0 && !spanning && first) {
      const t = text(first);
      const continues = t !== '{' && !afterLabel && ((first.kind === 'punct' && CONTINUES.has(t)) || (!!previous && !(previous.kind === 'punct' && ENDS.has(text(previous)))));
      const closer = first.kind === 'punct' && CLOSERS.includes(t);
      if (closer) level = frame.level;
      else if (first.kind === 'keyword' && (t === 'case' || t === 'default') && !continues) {
        level = frame.level + 1;
        frame.inCase = true;
        label = true;
      } else if (continues) level = Math.max(inner, (statement ?? inner) + 1);
      // A closing line belongs to the statement its bracket is in, which the pop below restores.
      if (!closer) statement = continues ? (statement ?? level - 1) : level;
      out[k] = level;
    } else if (k === 0) statement = base;
    if (first) afterLabel = false;
    for (; ti < tokens.length && tokens[ti].start < end; ti++) {
      const t = tokens[ti];
      if (t.kind === 'punct') {
        const c = text(t);
        if (OPENERS.includes(c)) stack.push({ level, inCase: false, statement });
        else if (CLOSERS.includes(c) && stack.length > 1) statement = stack.pop()!.statement;
      }
      if (t.kind !== 'comment') previous = t;
    }
    if (label && previous && text(previous) === ':') afterLabel = true;
  }
  return out;
}

/** Display width of `text`, with tabs to the next multiple of `tabSize`. */
function width(text: string, tabSize: number): number {
  let w = 0;
  for (const ch of text) w = ch === '\t' ? w + tabSize - (w % tabSize) : w + 1;
  return w;
}

/** Applies edits (sorted, non-overlapping) to `text`. */
export function applyEdits(text: string, edits: readonly { start: number; end: number; text: string }[]): string {
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}

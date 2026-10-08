/**
 * A small C# 7 lexer: just enough to find where an embedded expression ends and to feed
 * the syntactic lints. It understands every construct that can hide a bracket or a quote:
 * regular, verbatim and interpolated strings (with nested holes), char literals and
 * comments. Everything else is identifiers, numbers and single-character punctuation.
 */

import type { OffsetRange } from '../sourceMap';

export type TokenKind = 'identifier' | 'keyword' | 'string' | 'char' | 'number' | 'comment' | 'punct';

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** Set when the token is unterminated (string, char, comment, interpolation hole). */
  error?: string;
  /** Code ranges of the holes in an interpolated string. */
  holes?: OffsetRange[];
}

export const KEYWORDS: ReadonlySet<string> = new Set(
  (
    'abstract as base bool break byte case catch char checked class const continue decimal default ' +
    'delegate do double else enum event explicit extern false finally fixed float for foreach goto if ' +
    'implicit in int interface internal is lock long namespace new null object operator out override ' +
    'params private protected public readonly ref return sbyte sealed short sizeof stackalloc static ' +
    'string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual ' +
    'void volatile while var'
  ).split(' '),
);

const IDENT = /@?[\p{L}_][\p{L}\p{Nd}\p{Mn}\p{Pc}]*/uy;
const NUMBER = /0[xX][0-9a-fA-F_]+[uUlL]*|0[bB][01_]+[uUlL]*|(?:[0-9][0-9_]*)?(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9_]+)?[fFdDmMuUlL]*/y;

/** Lexes `text[start, end)`, skipping whitespace. */
export function* lex(text: string, start = 0, end = text.length): Generator<Token> {
  let i = start;
  while (i < end) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) {
      i++;
      continue;
    }
    const tok = lexOne(text, i, end);
    yield tok;
    i = tok.end;
  }
}

/** Lexes the single token starting at `i` (which must not be whitespace). */
export function lexOne(text: string, i: number, end: number): Token {
  const c = text[i];
  const n = text[i + 1];

  if (c === '"') return scanString(text, i, i + 1, end);
  if (c === "'") return scanChar(text, i, end);
  if (c === '@' && n === '"') return scanVerbatim(text, i, i + 2, end);
  if (c === '$' && n === '"') return scanInterpolated(text, i, i + 2, end, false);
  if ((c === '$' && n === '@' && text[i + 2] === '"') || (c === '@' && n === '$' && text[i + 2] === '"')) {
    return scanInterpolated(text, i, i + 3, end, true);
  }
  if (c === '/' && n === '/') {
    let j = i + 2;
    while (j < end && text[j] !== '\n' && text[j] !== '\r') j++;
    return { kind: 'comment', start: i, end: j };
  }
  if (c === '/' && n === '*') {
    const close = text.indexOf('*/', i + 2);
    if (close === -1 || close + 2 > end) return { kind: 'comment', start: i, end, error: 'Unterminated comment.' };
    return { kind: 'comment', start: i, end: close + 2 };
  }
  if (isDigit(c) || (c === '.' && isDigit(n))) {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    const len = m && m[0].length > 0 ? m[0].length : 1;
    return { kind: 'number', start: i, end: Math.min(end, i + len) };
  }
  IDENT.lastIndex = i;
  const m = IDENT.exec(text);
  if (m && m[0].length > 0) {
    const stop = Math.min(end, i + m[0].length);
    const word = text.slice(i, stop);
    return { kind: KEYWORDS.has(word) ? 'keyword' : 'identifier', start: i, end: stop };
  }
  return { kind: 'punct', start: i, end: i + 1 };
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function scanString(text: string, start: number, i: number, end: number): Token {
  while (i < end) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === '"') return { kind: 'string', start, end: i + 1 };
    else if (c === '\n' || c === '\r') break;
    else i++;
  }
  return { kind: 'string', start, end: Math.min(i, end), error: 'Unterminated string literal.' };
}

function scanVerbatim(text: string, start: number, i: number, end: number): Token {
  while (i < end) {
    if (text[i] === '"') {
      if (text[i + 1] === '"') i += 2;
      else return { kind: 'string', start, end: i + 1 };
    } else i++;
  }
  return { kind: 'string', start, end, error: 'Unterminated verbatim string literal.' };
}

function scanChar(text: string, start: number, end: number): Token {
  let i = start + 1;
  while (i < end) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === "'") return { kind: 'char', start, end: i + 1 };
    else if (c === '\n' || c === '\r') break;
    else i++;
  }
  return { kind: 'char', start, end: Math.min(i, end), error: 'Unterminated character literal.' };
}

function scanInterpolated(text: string, start: number, i: number, end: number, verbatim: boolean): Token {
  const holes: OffsetRange[] = [];
  while (i < end) {
    const c = text[i];
    if (c === '{') {
      if (text[i + 1] === '{') {
        i += 2;
        continue;
      }
      const hole = scanHole(text, i + 1, end);
      if (hole.error !== undefined) {
        return { kind: 'string', start, end: hole.close, error: hole.error, holes };
      }
      holes.push({ start: i + 1, end: hole.codeEnd });
      i = hole.close + 1;
    } else if (c === '}') {
      i += text[i + 1] === '}' ? 2 : 1;
    } else if (c === '"') {
      if (verbatim && text[i + 1] === '"') i += 2;
      else return { kind: 'string', start, end: i + 1, holes };
    } else if (!verbatim && c === '\\') {
      i += 2;
    } else if (!verbatim && (c === '\n' || c === '\r')) {
      break;
    } else {
      i++;
    }
  }
  return { kind: 'string', start, end: Math.min(i, end), error: 'Unterminated interpolated string.', holes };
}

/**
 * Scans an interpolation hole starting after its `{`. Returns the index of the closing `}`
 * and where the expression part ends (before any `:format`).
 */
function scanHole(text: string, i: number, end: number): { close: number; codeEnd: number; error?: string } {
  const stack: string[] = [];
  while (i < end) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) {
      i++;
      continue;
    }
    const tok = lexOne(text, i, end);
    if (tok.error) return { close: tok.end, codeEnd: tok.end, error: tok.error };
    if (tok.kind === 'punct') {
      const p = text[i];
      if (p === '(' || p === '[' || p === '{') stack.push(p);
      else if (p === ')' || p === ']') stack.pop();
      else if (p === '}') {
        if (stack.length === 0) return { close: i, codeEnd: i };
        stack.pop();
      } else if (p === ':' && stack.length === 0) {
        // Format specifier: literal text up to the closing brace.
        const close = text.indexOf('}', i + 1);
        if (close === -1 || close >= end) break;
        return { close, codeEnd: i };
      }
    }
    i = tok.end;
  }
  return { close: end, codeEnd: end, error: 'Unterminated interpolation hole.' };
}

const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

export interface BalanceResult {
  /** Index of the bracket that closes `text[open]`, or -1 if none was found. */
  close: number;
  error?: { message: string; start: number; end: number };
}

/**
 * Finds the bracket closing the `(` or `{` at `text[open]`, skipping C# strings, chars and
 * comments. Mismatched closers are recovered by popping to the nearest matching opener.
 * Stops at the first lexical error (an unterminated string, say): carrying on past one
 * tends to swallow the rest of the document. For the same reason it stops at `</` outside
 * strings and comments, which is never valid C# but is how an XML end tag starts.
 */
export function scanBalanced(text: string, open: number, end = text.length): BalanceResult {
  const stack = [text[open]];
  if (!CLOSER[stack[0]]) throw new Error(`not an opening bracket: ${stack[0]}`);
  for (const tok of lex(text, open + 1, end)) {
    if (tok.error) return { close: -1, error: { message: tok.error, start: tok.start, end: tok.end } };
    if (tok.kind !== 'punct') continue;
    const p = text[tok.start];
    if (p === '<' && text[tok.start + 1] === '/') {
      return { close: -1, error: { message: `Unterminated expression: reached an end tag before '${CLOSER[text[open]]}'.`, start: open, end: open + 1 } };
    }
    if (CLOSER[p]) {
      stack.push(p);
    } else if (OPENER[p]) {
      const want = OPENER[p];
      const at = stack.lastIndexOf(want);
      if (at === -1) continue; // stray closer, ignore
      stack.length = at;
      if (stack.length === 0) return { close: tok.start };
    }
  }
  const closer = CLOSER[text[open]];
  return {
    close: -1,
    error: { message: `Unterminated expression: missing '${closer}'.`, start: open, end: open + 1 },
  };
}

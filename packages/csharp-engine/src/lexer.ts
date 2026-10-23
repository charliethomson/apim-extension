/**
 * The full C# 7.3 lexer for the built-in engine. It builds on the structural lexer in
 * @apim-policy/csharp-lexer (which owns strings, chars, comments, numbers and identifiers) and adds
 * what parsing needs: multi-character operators, contextual keywords, literal kinds, the code
 * inside interpolation holes, and `{{named values}}`.
 *
 * `>>` and `>>=` are never produced: the parser joins adjacent `>` tokens itself, so `List<List<int>>`
 * closes two type argument lists.
 */

import { KEYWORDS as STRUCTURAL_KEYWORDS, lexOne } from '@apim-policy/csharp-lexer';

export type TokenKind = 'ident' | 'keyword' | 'number' | 'string' | 'char' | 'interp' | 'punct' | 'namedValue' | 'eof';

export type NumberKind = 'int' | 'uint' | 'long' | 'ulong' | 'float' | 'double' | 'decimal';

export interface InterpHole {
  /** Code range inside the braces, before any `,alignment` or `:format`. */
  start: number;
  end: number;
  tokens: Token[];
}

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** Source text, or the identifier's name without a leading `@`. */
  text: string;
  /** For `number` tokens. */
  numberKind?: NumberKind;
  /** For `interp` tokens. */
  holes?: InterpHole[];
  /** Set when the token is malformed (unterminated string, say). */
  error?: string;
  /** Set when the token is newer syntax than C# 7.3: what it is and the version it needs. */
  newer?: { feature: string; version: string };
}

export interface Trivia {
  kind: 'comment' | 'docComment';
  start: number;
  end: number;
}

export interface LexResult {
  /** Significant tokens, ending with an `eof` token at the end of the range. */
  tokens: Token[];
  trivia: Trivia[];
  /** Unterminated comments; malformed literals carry their own `error`. */
  errors: { start: number; end: number; message: string }[];
}

/** Reserved keywords. `var` and the other contextual keywords lex as identifiers. */
export const RESERVED: ReadonlySet<string> = new Set([...STRUCTURAL_KEYWORDS].filter((k) => k !== 'var'));

/** Keywords that name a type: `int.Parse`, `(string)x`, `new byte[4]`. */
export const PREDEFINED_TYPES: Readonly<Record<string, string>> = {
  bool: 'System.Boolean',
  byte: 'System.Byte',
  sbyte: 'System.SByte',
  char: 'System.Char',
  decimal: 'System.Decimal',
  double: 'System.Double',
  float: 'System.Single',
  int: 'System.Int32',
  uint: 'System.UInt32',
  long: 'System.Int64',
  ulong: 'System.UInt64',
  short: 'System.Int16',
  ushort: 'System.UInt16',
  string: 'System.String',
  object: 'System.Object',
  void: 'System.Void',
};

/** Longest first, so `<<=` wins over `<<` and `<`. */
const OPERATORS = ['<<=', '??=', '=>', '??', '?.', '::', '..', '++', '--', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '->'];

const NAMED_VALUE = /\{\{([A-Za-z0-9._-]+)\}\}/y;

/** Lexes `text[start, end)`. */
export function lexAll(text: string, start = 0, end = text.length): LexResult {
  const tokens: Token[] = [];
  const trivia: Trivia[] = [];
  const errors: LexResult['errors'] = [];
  let i = start;
  while (i < end) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff) {
      i++;
      continue;
    }
    if (text[i] === '{' && text[i + 1] === '{') {
      NAMED_VALUE.lastIndex = i;
      const m = NAMED_VALUE.exec(text);
      if (m && i + m[0].length <= end) {
        tokens.push({ kind: 'namedValue', start: i, end: i + m[0].length, text: m[1] });
        i += m[0].length;
        continue;
      }
    }
    const raw = lexOne(text, i, end);
    i = raw.end;
    const slice = text.slice(raw.start, raw.end);
    switch (raw.kind) {
      case 'comment':
        trivia.push({ kind: slice.startsWith('///') ? 'docComment' : 'comment', start: raw.start, end: raw.end });
        if (raw.error) errors.push({ start: raw.start, end: raw.end, message: raw.error });
        break;
      case 'string':
        if (slice === '""' && text[raw.end] === '"') {
          // A raw string literal (C# 11): three or more quotes, closed by the same number.
          let n = 2;
          while (raw.end + n - 2 < end && text[raw.end + n - 2] === '"') n++;
          const close = text.indexOf('"'.repeat(n), raw.start + n);
          const stop = close < 0 || close + n > end ? end : close + n;
          tokens.push({ kind: 'string', start: raw.start, end: stop, text: text.slice(raw.start, stop), error: close < 0 ? 'Unterminated raw string literal.' : undefined, newer: { feature: 'Raw string literals', version: '11' } });
          i = stop;
          break;
        }
        if (raw.holes || slice[0] === '$' || slice[1] === '$') {
          tokens.push({
            kind: 'interp',
            start: raw.start,
            end: raw.end,
            text: slice,
            error: raw.error,
            newer: slice.startsWith('@$') ? { feature: "Interpolated verbatim strings written '@$'", version: '8' } : undefined,
            holes: (raw.holes ?? []).map((h) => {
              const codeEnd = alignmentStart(text, h.start, h.end);
              return { start: h.start, end: codeEnd, tokens: lexAll(text, h.start, codeEnd).tokens };
            }),
          });
        } else {
          tokens.push({ kind: 'string', start: raw.start, end: raw.end, text: slice, error: raw.error });
        }
        break;
      case 'char':
        tokens.push({ kind: 'char', start: raw.start, end: raw.end, text: slice, error: raw.error });
        break;
      case 'number':
        tokens.push({ kind: 'number', start: raw.start, end: raw.end, text: slice, numberKind: numberKind(slice) });
        break;
      case 'identifier':
      case 'keyword': {
        const name = slice.startsWith('@') ? slice.slice(1) : slice;
        tokens.push({ kind: !slice.startsWith('@') && RESERVED.has(slice) ? 'keyword' : 'ident', start: raw.start, end: raw.end, text: name });
        break;
      }
      case 'punct': {
        const op = OPERATORS.find((o) => text.startsWith(o, raw.start) && raw.start + o.length <= end) ?? slice;
        tokens.push({ kind: 'punct', start: raw.start, end: raw.start + op.length, text: op });
        i = raw.start + op.length;
        break;
      }
    }
  }
  tokens.push({ kind: 'eof', start: end, end, text: '' });
  return { tokens, trivia, errors };
}

/**
 * The structural lexer ends a hole's code at a top-level `:`; this also stops at a top-level
 * `,alignment`, which only matters to the engine.
 */
function alignmentStart(text: string, start: number, end: number): number {
  let depth = 0;
  for (const t of lexAll(text, start, end).tokens) {
    if (t.kind !== 'punct') continue;
    if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
    else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;
    else if (t.text === ',' && depth === 0) return t.start;
  }
  return end;
}

export function numberKind(text: string): NumberKind {
  const t = text.toLowerCase().replace(/_/g, '');
  if (t.startsWith('0x') || t.startsWith('0b')) return integerSuffix(t.slice(2).replace(/^[0-9a-f]*/, ''));
  if (t.endsWith('m')) return 'decimal';
  if (t.endsWith('f')) return 'float';
  if (t.endsWith('d') || t.includes('.') || t.includes('e')) return 'double';
  return integerSuffix(t.replace(/^[0-9]*/, ''));
}

function integerSuffix(suffix: string): NumberKind {
  if (suffix.includes('u') && suffix.includes('l')) return 'ulong';
  if (suffix.includes('u')) return 'uint';
  if (suffix.includes('l')) return 'long';
  return 'int';
}

/** Where `offset` falls: in a string or char literal, a comment, or code. */
export function offsetContext(text: string, offset: number): 'string' | 'comment' | 'code' {
  const { tokens, trivia } = lexAll(text);
  // An unterminated comment or string runs to the end, so the cursor at the very end is inside it.
  const inside = (s: number, e: number, open: boolean) => offset > s && (offset < e || (open && offset === e));
  for (const c of trivia) {
    const lineComment = text.startsWith('//', c.start);
    if (inside(c.start, c.end, lineComment || !text.startsWith('*/', c.end - 2))) return 'comment';
  }
  const visit = (toks: Token[]): 'string' | 'code' | undefined => {
    for (const t of toks) {
      if (t.kind === 'string' || t.kind === 'char') {
        if (inside(t.start, t.end, !!t.error)) return 'string';
      } else if (t.kind === 'interp' && inside(t.start, t.end, !!t.error)) {
        for (const h of t.holes ?? []) if (offset >= h.start && offset <= h.end) return visit(h.tokens) ?? 'code';
        return 'string';
      }
    }
    return undefined;
  };
  return visit(tokens) ?? 'code';
}

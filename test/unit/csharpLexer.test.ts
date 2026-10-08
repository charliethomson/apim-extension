import { describe, expect, it } from 'vitest';
import { lex, scanBalanced } from '../../src/parser/csharpLexer';

/** Closing index for an expression written as `@(...)` or `@{...}` at the start of `s`. */
function close(s: string): number {
  return scanBalanced(s, 1).close;
}

function closesAtEnd(s: string): void {
  expect(close(s), s).toBe(s.length - 1);
}

describe('scanBalanced', () => {
  it('balances nested parens and braces', () => {
    closesAtEnd('@(a(b(c), d[(e)]))');
    closesAtEnd('@{ if (x) { return y(); } return z; }');
  });

  it('stops at the matching close and not later', () => {
    expect(close('@(a)b)')).toBe(3);
  });

  it('skips brackets and quotes in regular strings with escapes', () => {
    closesAtEnd('@(f(")", "\\")(", "}"))');
  });

  it('skips verbatim strings with doubled quotes and backslashes', () => {
    closesAtEnd('@(@"C:\\temp\\" + @"say ""hi"")")');
  });

  it('skips char literals', () => {
    closesAtEnd("@(s.Split(')') + '(' + '\\'' + '\"')");
  });

  it('skips comments', () => {
    closesAtEnd('@{ // ) }\n /* ) } " */ return 1; }');
  });

  it('handles interpolated strings with nested holes, strings and format specifiers', () => {
    closesAtEnd('@($"{a}: {(b > 5 ? "x)" : "y}")} {c:yyyy-MM-dd} {{ }}")');
    closesAtEnd('@($@"{{lit}} {a} ""q"" }}")');
    closesAtEnd('@(@$"{new[] { 1 }.Length}")');
    closesAtEnd('@($"{$"{"inner)"}"}")');
  });

  it('handles generics and lambdas', () => {
    closesAtEnd('@(new Dictionary<string, List<int>>() { { "k", new List<int> { 1 } } }.Count)');
    closesAtEnd('@(xs.Where(x => x < 10 && x > 0).Select(x => { return x; }))');
  });

  it('treats < and & as plain operators', () => {
    closesAtEnd('@(a < b && c > d)');
  });

  it('recovers from a stray closer by ignoring it', () => {
    closesAtEnd('@(a ] b)');
  });

  it('recovers from a mismatched closer by popping to its opener', () => {
    expect(close('@{ f( } x')).toBe(6);
  });

  it('reports an unterminated expression', () => {
    const r = scanBalanced('@(a(b)', 1);
    expect(r.close).toBe(-1);
    expect(r.error?.message).toMatch(/missing '\)'/);
  });

  it('stops at an unterminated string instead of scanning on', () => {
    const r = scanBalanced('@("abc\n) more ) text', 1);
    expect(r.close).toBe(-1);
    expect(r.error?.message).toMatch(/string/);
    expect(r.error?.start).toBe(2);
  });

  it('reports unterminated chars, comments, verbatim and interpolated strings', () => {
    expect(scanBalanced("@('a\n)", 1).error?.message).toMatch(/character/);
    expect(scanBalanced('@(/* )', 1).error?.message).toMatch(/comment/);
    expect(scanBalanced('@(@" )', 1).error?.message).toMatch(/verbatim/);
    expect(scanBalanced('@($"{a )', 1).error?.message).toMatch(/hole|string/);
    expect(scanBalanced('@($"a\n)', 1).error?.message).toMatch(/interpolated/);
  });

  it('respects the end bound', () => {
    expect(scanBalanced('@(a) b)', 1, 3).close).toBe(-1);
  });

  it('rejects a non-bracket start', () => {
    expect(() => scanBalanced('@x', 1)).toThrow();
  });
});

describe('lex', () => {
  const kinds = (s: string) => [...lex(s)].map((t) => `${t.kind}:${s.slice(t.start, t.end)}`);

  it('classifies tokens', () => {
    expect(kinds('var x = @class + 1.5f + 0x1F + .5 + 1e3; // c')).toEqual([
      'keyword:var',
      'identifier:x',
      'punct:=',
      'identifier:@class',
      'punct:+',
      'number:1.5f',
      'punct:+',
      'number:0x1F',
      'punct:+',
      'number:.5',
      'punct:+',
      'number:1e3',
      'punct:;',
      'comment:// c',
    ]);
  });

  it('records interpolation holes', () => {
    const s = '$"a {b.C} {d:N2}"';
    const [tok] = [...lex(s)];
    expect(tok.kind).toBe('string');
    expect(tok.holes?.map((h) => s.slice(h.start, h.end))).toEqual(['b.C', 'd']);
  });

  it('lexes unicode identifiers', () => {
    expect(kinds('café')).toEqual(['identifier:café']);
  });
});

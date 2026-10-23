import { describe, expect, it } from 'vitest';
import { Lines } from '../src/lines';

describe('lines by offset', () => {
  const lines = new Lines('a\r\n  b\n\tc\rd');

  it('ends a line at \\r\\n, \\n or \\r, as editors do', () => {
    expect(lines.count).toBe(4);
    expect([0, 1, 2, 3].map((n) => lines.line(n))).toEqual(['a', '  b', '\tc', 'd']);
    expect([lines.lineOf(0), lines.lineOf(2), lines.lineOf(3), lines.lineOf(6), lines.lineOf(11)]).toEqual([0, 0, 1, 1, 3]);
  });

  it("gives each line's start, and the end of the text past the last", () => {
    expect([0, 1, 2, 3, 4].map((n) => lines.start(n))).toEqual([0, 3, 7, 10, 11]);
  });

  it("knows a line's indentation from any offset on it", () => {
    expect([lines.indentAt(5), lines.indentAt(8), lines.indentAt(0)]).toEqual(['  ', '\t', '']);
  });

  it('picks the word touching an offset, either end included', () => {
    const words = new Lines('{User[]} x');
    expect([1, 3, 5].map((o) => words.wordAt(o))).toEqual([
      { start: 1, end: 5, text: 'User' },
      { start: 1, end: 5, text: 'User' },
      { start: 1, end: 5, text: 'User' },
    ]);
    expect(words.wordAt(7)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { SourceMap, SourceMapBuilder } from '../../src/sourceMap';

describe('SourceMap', () => {
  // gen: "ab" + "X" (opaque for 6 source chars) + "cd", src offset 10
  const map = new SourceMapBuilder().copy(10, 2).opaque(12, 6, 1).copy(18, 2).build();

  it('maps copy segments character for character', () => {
    expect(map.toSource(0)).toBe(10);
    expect(map.toSource(1)).toBe(11);
    expect(map.toSource(3)).toBe(18);
    expect(map.toSource(4)).toBe(19);
    expect(map.toGenerated(19)).toBe(4);
  });

  it('maps into an opaque segment by bias', () => {
    expect(map.toSource(2, 'start')).toBe(12);
    expect(map.toSource(3, 'end')).toBe(18);
    expect(map.toGenerated(14, 'start')).toBe(2);
    expect(map.toGenerated(14, 'end')).toBe(3);
  });

  it('addresses one past the end', () => {
    expect(map.toSource(5)).toBe(20);
    expect(map.toGenerated(20)).toBe(5);
  });

  it('returns undefined outside the map', () => {
    expect(map.toSource(6)).toBeUndefined();
    expect(map.toGenerated(9)).toBeUndefined();
    expect(new SourceMap([]).toSource(0)).toBeUndefined();
  });

  it('maps ranges, widening across opaque segments', () => {
    expect(map.rangeToSource({ start: 1, end: 3 })).toEqual({ start: 11, end: 18 });
    expect(map.rangeToSource({ start: 2, end: 2 })).toEqual({ start: 12, end: 12 });
    expect(map.rangeToGenerated({ start: 13, end: 15 })).toEqual({ start: 2, end: 3 });
    expect(map.rangeToSource({ start: 4, end: 9 })).toBeUndefined();
  });

  it('merges adjacent copies', () => {
    const m = new SourceMapBuilder().copy(0, 3).copy(3, 4).build();
    expect(m.segments).toHaveLength(1);
  });

  it('leaves skipped generated text unmapped', () => {
    const m = new SourceMapBuilder().skip(5).copy(100, 3).build();
    expect(m.toSource(2)).toBeUndefined();
    expect(m.toSource(6)).toBe(101);
    expect(m.toGenerated(101)).toBe(6);
  });

  it('slices and rebases', () => {
    const s = map.slice(1, 4);
    expect(s.toSource(0)).toBe(11);
    expect(s.toSource(1)).toBe(12);
    expect(s.toSource(2)).toBe(18);
  });

  it('shifts', () => {
    expect(map.shiftGenerated(100).toSource(100)).toBe(10);
  });

  it('composes A→B with B→C', () => {
    // B is the decoded text above (gen of `map`), A wraps it in 3 chars of scaffolding.
    const outer = new SourceMapBuilder().skip(3).copy(0, 5).build();
    const ac = SourceMap.compose(outer, map);
    expect(ac.toSource(1)).toBeUndefined();
    expect(ac.toSource(3)).toBe(10);
    expect(ac.toSource(5, 'start')).toBe(12);
    expect(ac.toSource(6, 'end')).toBe(18);
    expect(ac.toSource(7)).toBe(19);
    expect(ac.toGenerated(19)).toBe(7);
  });

  it('composes an opaque outer segment onto its whole inner range', () => {
    const outer = new SourceMapBuilder().copy(0, 2).opaque(2, 3, 10).build();
    const ac = SourceMap.compose(outer, map);
    expect(ac.rangeToSource({ start: 2, end: 12 })).toEqual({ start: 12, end: 20 });
  });
});

/**
 * Offset maps between a generated text and the source it came from.
 *
 * A map is a list of segments, sorted and non-overlapping in both generated and source
 * space. A `copy` segment maps character for character. An `opaque` segment stands for a
 * replacement whose lengths differ (an entity like `&quot;` decoded to `"`); offsets inside it
 * map to its start or end. Generated text not covered by any segment has no source position.
 */

export interface Segment {
  gen: number;
  genLen: number;
  src: number;
  srcLen: number;
  kind: 'copy' | 'opaque';
}

export interface OffsetRange {
  start: number;
  end: number;
}

/** Which side of an opaque segment (or a segment boundary) an offset should land on. */
export type Bias = 'start' | 'end';

export class SourceMap {
  constructor(readonly segments: readonly Segment[]) {}

  /** Maps a generated offset to a source offset, or undefined if it's in unmapped text. */
  toSource(gen: number, bias: Bias = 'start'): number | undefined {
    const seg = find(this.segments, gen, 'gen', 'genLen', bias);
    if (!seg) return undefined;
    return translate(gen, seg.gen, seg.genLen, seg.src, seg.srcLen, seg.kind, bias);
  }

  /** Maps a source offset to a generated offset, or undefined if the source isn't covered. */
  toGenerated(src: number, bias: Bias = 'start'): number | undefined {
    const seg = find(this.segments, src, 'src', 'srcLen', bias);
    if (!seg) return undefined;
    return translate(src, seg.src, seg.srcLen, seg.gen, seg.genLen, seg.kind, bias);
  }

  /** Maps a generated range to source. Both ends must be mapped. */
  rangeToSource(range: OffsetRange): OffsetRange | undefined {
    const start = this.toSource(range.start, 'start');
    const end = range.end === range.start ? start : this.toSource(range.end, 'end');
    if (start === undefined || end === undefined) return undefined;
    return { start, end: Math.max(start, end) };
  }

  /** Maps a source range to generated. Both ends must be mapped. */
  rangeToGenerated(range: OffsetRange): OffsetRange | undefined {
    const start = this.toGenerated(range.start, 'start');
    const end = range.end === range.start ? start : this.toGenerated(range.end, 'end');
    if (start === undefined || end === undefined) return undefined;
    return { start, end: Math.max(start, end) };
  }

  /**
   * The part of this map covering generated offsets `[start, end)`, rebased so `start` is 0.
   * Copy segments are clipped; an opaque segment is kept whole if it overlaps at all.
   */
  slice(start: number, end: number): SourceMap {
    const out: Segment[] = [];
    for (const s of this.segments) {
      const sEnd = s.gen + s.genLen;
      if (sEnd <= start && !(s.genLen === 0 && s.gen === start)) continue;
      if (s.gen >= end) break;
      if (s.kind === 'opaque') {
        out.push({ ...s, gen: s.gen - start });
        continue;
      }
      const a = Math.max(s.gen, start);
      const b = Math.min(sEnd, end);
      out.push({ gen: a - start, genLen: b - a, src: s.src + (a - s.gen), srcLen: b - a, kind: 'copy' });
    }
    return new SourceMap(out);
  }

}

/**
 * Builds a map while the generated text is appended left to right. Each call advances the
 * generated cursor; `src` arguments must be non-decreasing.
 */
export class SourceMapBuilder {
  private readonly segments: Segment[] = [];
  private cursor = 0;

  get length(): number {
    return this.cursor;
  }

  /** Generated text that mirrors `len` source characters starting at `src`. */
  copy(src: number, len: number): this {
    if (len <= 0) return this;
    const last = this.segments[this.segments.length - 1];
    if (last && last.kind === 'copy' && last.gen + last.genLen === this.cursor && last.src + last.srcLen === src) {
      last.genLen += len;
      last.srcLen += len;
    } else {
      this.segments.push({ gen: this.cursor, genLen: len, src, srcLen: len, kind: 'copy' });
    }
    this.cursor += len;
    return this;
  }

  /** `genLen` generated characters standing in for `srcLen` source characters at `src`. */
  opaque(src: number, srcLen: number, genLen: number): this {
    if (genLen <= 0 && srcLen <= 0) return this;
    this.segments.push({ gen: this.cursor, genLen, src, srcLen, kind: 'opaque' });
    this.cursor += genLen;
    return this;
  }

  /** Generated text with no source. */
  skip(genLen: number): this {
    this.cursor += genLen;
    return this;
  }

  build(): SourceMap {
    return new SourceMap(this.segments.map((s) => ({ ...s })));
  }
}

function find(
  segments: readonly Segment[],
  offset: number,
  startKey: 'gen' | 'src',
  lenKey: 'genLen' | 'srcLen',
  bias: Bias,
): Segment | undefined {
  // Binary search for the last segment whose start <= offset.
  let lo = 0;
  let hi = segments.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid][startKey] <= offset) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return undefined;
  const seg = segments[idx];
  const end = seg[startKey] + seg[lenKey];
  if (offset < end) {
    // At a shared boundary with an 'end' bias, prefer the previous segment's end.
    if (bias === 'end' && offset === seg[startKey] && idx > 0) {
      const prev = segments[idx - 1];
      if (prev[startKey] + prev[lenKey] === offset) return prev;
    }
    return seg;
  }
  if (offset === end) return seg; // one past the end of a segment is still addressable
  return undefined;
}

function translate(
  offset: number,
  fromStart: number,
  fromLen: number,
  toStart: number,
  toLen: number,
  kind: Segment['kind'],
  bias: Bias,
): number {
  const delta = offset - fromStart;
  if (kind === 'copy') return toStart + delta;
  if (delta === 0) return toStart;
  if (delta === fromLen) return toStart + toLen;
  return bias === 'start' ? toStart : toStart + toLen;
}

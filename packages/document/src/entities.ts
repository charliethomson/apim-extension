import { SourceMap, SourceMapBuilder } from '@apim-policy/core';

const NAMED: Record<string, string> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };

const ENTITY = /&(?:(quot|apos|lt|gt|amp)|#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6}));/y;

export interface Decoded {
  /** The decoded text. */
  text: string;
  /** Maps offsets in `text` (generated) to offsets in the input (source), shifted by `base`. */
  map: SourceMap;
}

/**
 * Decodes the five predefined XML entities and numeric character references. Unknown or
 * malformed `&` sequences are left as-is, which is what rawxml policies need: `&&` in an
 * expression is plain C#.
 *
 * @param base offset of `input` inside the document, so the map points at document offsets.
 */
export function decodeEntities(input: string, base = 0): Decoded {
  const b = new SourceMapBuilder();
  let out = '';
  let runStart = 0;
  let i = input.indexOf('&');
  while (i !== -1) {
    ENTITY.lastIndex = i;
    const m = ENTITY.exec(input);
    if (m) {
      const decoded = m[1] ? NAMED[m[1]] : codePoint(m[2] ? parseInt(m[2], 10) : parseInt(m[3], 16));
      if (decoded !== undefined) {
        out += input.slice(runStart, i);
        b.copy(base + runStart, i - runStart);
        out += decoded;
        b.opaque(base + i, m[0].length, decoded.length);
        runStart = i + m[0].length;
        i = input.indexOf('&', runStart);
        continue;
      }
    }
    i = input.indexOf('&', i + 1);
  }
  out += input.slice(runStart);
  b.copy(base + runStart, input.length - runStart);
  return { text: out, map: b.build() };
}

function codePoint(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return undefined;
  return String.fromCodePoint(n);
}

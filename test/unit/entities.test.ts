import { describe, expect, it } from 'vitest';
import { decodeEntities } from '../../src/parser/entities';

describe('decodeEntities', () => {
  it('decodes the predefined entities and numeric references', () => {
    expect(decodeEntities('&quot;&apos;&lt;&gt;&amp;&#65;&#x42;&#x1F600;').text).toBe(`"'<>&AB😀`);
  });

  it('leaves raw ampersands and unknown entities alone', () => {
    expect(decodeEntities('a && b &nbsp; &#; &#xZZ; &#0; &#xD800;').text).toBe('a && b &nbsp; &#; &#xZZ; &#0; &#xD800;');
  });

  it('maps decoded offsets back to the source', () => {
    const src = 'x == &quot;POST&quot; &amp;&amp; y';
    const { text, map } = decodeEntities(src, 100);
    expect(text).toBe('x == "POST" && y');
    const p = text.indexOf('POST');
    expect(map.toSource(p)).toBe(100 + src.indexOf('POST'));
    const q = text.indexOf('"');
    expect(map.rangeToSource({ start: q, end: q + 1 })).toEqual({ start: 105, end: 111 });
    expect(map.toSource(text.length)).toBe(100 + src.length);
  });

  it('every non-entity character maps to the same character', () => {
    const src = 'a&lt;b&gt;c &x &amp;d';
    const { text, map } = decodeEntities(src);
    for (let i = 0; i < text.length; i++) {
      const s = map.toSource(i)!;
      if (src[s] !== '&') expect(src[s]).toBe(text[i]);
    }
  });
});

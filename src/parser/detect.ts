/**
 * The name of the root element, skipping a BOM, whitespace, the XML declaration, processing
 * instructions, comments and a DOCTYPE. Hand-written rather than a regex: the obvious pattern
 * backtracks exponentially on files that start with many comments, and this runs on every XML
 * file the editor opens. Only looks at the first `limit` characters.
 */
export function rootElementName(text: string, limit = 4096): string | undefined {
  const end = Math.min(text.length, limit);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < end && /\s/.test(text[i])) i++;
    if (i >= end || text[i] !== '<') return undefined;
    if (text.startsWith('<?', i)) {
      const close = text.indexOf('?>', i + 2);
      if (close < 0 || close >= end) return undefined;
      i = close + 2;
    } else if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      if (close < 0 || close >= end) return undefined;
      i = close + 3;
    } else if (text.startsWith('<!', i)) {
      const close = text.indexOf('>', i + 2);
      if (close < 0 || close >= end) return undefined;
      i = close + 1;
    } else {
      const m = /^<([A-Za-z_:][-A-Za-z0-9_:.]*)(?=[\s/>]|$)/.exec(text.slice(i, Math.min(end, i + 256)));
      return m?.[1];
    }
  }
}

/** True when the text's root element is <policies> or <fragment>. Only reads the first 4 KB. */
export function looksLikePolicy(text: string): boolean {
  const root = rootElementName(text);
  return root === 'policies' || root === 'fragment';
}

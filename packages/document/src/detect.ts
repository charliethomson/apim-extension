/**
 * The name of the root element, skipping a BOM, whitespace, the XML declaration, processing
 * instructions, comments and a DOCTYPE. Hand-written rather than a regex: the obvious pattern
 * backtracks exponentially on files that start with many comments, and this runs on every XML
 * file the editor opens. Only looks at the first `limit` characters.
 */
export function rootElementName(text: string, limit = PROLOG_LIMIT): string | undefined {
  return scanRoot(text, limit).name;
}

/**
 * How far into a file the root element is looked for. Comments before it count, and a fragment
 * header can run to several KB, so this is generous; it only ever walks comments and whitespace.
 */
export const PROLOG_LIMIT = 64 * 1024;

/**
 * The root element's name, or `more` when the text ran out before deciding: it was all
 * whitespace, declarations and comments so far (a long fragment header, say), so more text may
 * still reach the root.
 */
export function scanRoot(text: string, limit = PROLOG_LIMIT): { name?: string; more: boolean } {
  const end = Math.min(text.length, limit);
  const short = text.length < limit;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < end && /\s/.test(text[i])) i++;
    if (i >= end) return { more: short };
    if (text[i] !== '<') return { more: false };
    if (text.startsWith('<?', i)) {
      const close = text.indexOf('?>', i + 2);
      if (close < 0 || close >= end) return { more: short };
      i = close + 2;
    } else if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      if (close < 0 || close >= end) return { more: short };
      i = close + 3;
    } else if (text.startsWith('<!', i)) {
      const close = text.indexOf('>', i + 2);
      if (close < 0 || close >= end) return { more: short };
      i = close + 1;
    } else {
      const m = /^<([A-Za-z_:][-A-Za-z0-9_:.]*)(?=[\s/>]|$)/.exec(text.slice(i, Math.min(end, i + 256)));
      return { name: m?.[1], more: !m && short };
    }
  }
}

/** True when the text's root element is <policies> or <fragment>, past any comments before it. */
export function looksLikePolicy(text: string): boolean {
  const root = rootElementName(text);
  return root === 'policies' || root === 'fragment';
}

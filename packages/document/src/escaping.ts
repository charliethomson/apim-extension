/**
 * The two ways a policy writes its expressions: `rawxml` with plain quotes (APIOps, and what the
 * editor shows) or `xml` with them entity-escaped (the portal's form).
 */

import type { Document } from './ast';

/** True when the document writes expressions entity-escaped (the 'xml' format). */
export function isEscapedFormat(doc: Document): boolean {
  return doc.expressions.some((e) => e.code !== doc.source.slice(e.codeRange.start, e.codeRange.end) && /&(quot|lt|gt|amp|apos);/.test(doc.source.slice(e.codeRange.start, e.codeRange.end)));
}

/** Escapes text for insertion into an expression, matching the document's format. */
export function escapeForDocument(text: string, escaped: boolean, inCData: boolean): string {
  if (!escaped || inCData) return text;
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

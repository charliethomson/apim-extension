/**
 * The pure parts of pushing a policy to an instance: which format to send it in, whether it
 * differs from what's live, and where the gateway's validation errors point.
 */

import { type Document, isEscapedFormat } from '@charliethomson/apim-document';

/**
 * `xml` for a policy written with `&quot;` in its expressions (the portal's escaped form),
 * `rawxml` for one with plain quotes (APIOps, and what the editor shows). Sending one as the
 * other would change what the expressions say.
 */
export function pushFormat(doc: Document): 'rawxml' | 'xml' {
  return isEscapedFormat(doc) ? 'xml' : 'rawxml';
}

/** Whether two policy texts are the same apart from line endings and trailing space. */
export function samePolicy(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const norm = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  return norm(a) === norm(b);
}

export interface GatewayError {
  /** 1-based, as the gateway reports them. */
  line: number;
  column: number;
  message: string;
}

/**
 * The positions in APIM's validation errors: "Error in element 'set-variable' on line 479,
 * column 6: …". Messages without one come back with line 0, for the whole document.
 */
export function gatewayErrors(messages: readonly string[]): GatewayError[] {
  return messages.map((message) => {
    const m = /\bline (\d+), column (\d+)/i.exec(message);
    return m ? { line: Number(m[1]), column: Number(m[2]), message } : { line: 0, column: 0, message };
  });
}

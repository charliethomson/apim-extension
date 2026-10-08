const POLICY_ROOT = /^﻿?\s*(?:<\?[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:policies|fragment)[\s/>]/;

/** True when the text's root element is <policies> or <fragment>. Only reads the first 4 KB. */
export function looksLikePolicy(text: string): boolean {
  return POLICY_ROOT.test(text.slice(0, 4096));
}

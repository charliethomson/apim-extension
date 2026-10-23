import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '@apim-policy/document';
import { catalog, validate } from '@apim-policy/catalog';

const snippets = JSON.parse(readFileSync(join(__dirname, '..', 'snippets', 'apim-policy.code-snippets'), 'utf8')) as Record<
  string,
  { prefix: string[]; body: string[]; description: string }
>;

/** Expands a snippet body with its default placeholder text, as accepting every default would. */
function expand(body: string[]): string {
  let text = body.join('\n');
  const defaults = new Map<string, string>();
  // ${1|a,b|} → a ; ${1:default} → default (recursively, inner placeholders first)
  for (let i = 0; i < 10; i++) {
    text = text
      .replace(/\$\{(\d+)\|([^|]*?)(?:,[^|]*)?\|\}/g, (_: string, n: string, first: string) => (defaults.set(n, first), first))
      .replace(/\$\{(\d+):((?:[^{}\\]|\\.)*)\}/g, (_: string, n: string, d: string) => {
        const v = d.replace(/\\(.)/g, '$1');
        defaults.set(n, v);
        return v;
      });
  }
  text = text.replace(/\$\{(\d+)\}/g, (_: string, n: string) => defaults.get(n) ?? '').replace(/\$\d+/g, '');
  return text;
}

describe('snippets', () => {
  for (const [name, s] of Object.entries(snippets)) {
    it(`${name} expands to a valid policy`, () => {
      const body = expand(s.body);
      const wrapped = body.startsWith('<policies') || body.startsWith('<fragment') ? body : `<policies><inbound>${body}</inbound></policies>`;
      // forward-request only belongs in backend
      const doc = parse(name === 'Forward with retry' ? wrapped.replace(/inbound>/g, 'backend>') : wrapped);
      expect(doc.diagnostics).toEqual([]);
      expect(validate(doc, catalog).map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    });
  }

  it('has unique prefixes', () => {
    const all = Object.values(snippets).flatMap((s) => s.prefix);
    expect(new Set(all).size).toBe(all.length);
  });
});

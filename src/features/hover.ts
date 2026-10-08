import * as vscode from 'vscode';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import { nodeAt } from '../parser/query';
import { resolveDef } from '../policy/defs';
import type { Catalog } from '../policy/schema';

/** Hover for policy element and attribute names (from the catalog) and named values. */
export function registerPolicyHover(cache: DocumentCache, catalog: Catalog): vscode.Disposable {
  return vscode.languages.registerHoverProvider(LANGUAGE_ID, {
    provideHover(document, position) {
      const offset = document.offsetAt(position);
      const hit = nodeAt(cache.get(document), offset);
      if (hit.namedValue) {
        const md = new vscode.MarkdownString(
          `**Named value** \`${hit.namedValue.name}\`\n\nAPI Management replaces this with the named value's text before the policy runs.`,
        );
        return new vscode.Hover(md, toRange(document, hit.namedValue.range));
      }
      if (hit.expression || !hit.element) return undefined;
      const def = resolveDef(hit.path, catalog);
      if (!def) return undefined;
      if (hit.onElementName) {
        const docs = 'docs' in def && typeof def.docs === 'string' && def.docs ? `\n\n[Reference](${def.docs})` : '';
        return new vscode.Hover(new vscode.MarkdownString(`**<${def.name}>**\n\n${def.description}${docs}`));
      }
      if (hit.attribute && hit.onAttributeName) {
        const a = def.attributes?.find((x) => x.name === hit.attribute!.name);
        if (!a) return undefined;
        const facts = [
          a.required ? 'required' : 'optional',
          a.expressions ? 'accepts expressions' : undefined,
          a.enum ? `one of ${a.enum.map((v) => `\`${v}\``).join(', ')}` : undefined,
        ].filter(Boolean);
        return new vscode.Hover(new vscode.MarkdownString(`**${a.name}** (${facts.join(', ')})\n\n${a.description}`));
      }
      return undefined;
    },
  });
}

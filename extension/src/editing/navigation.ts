import * as vscode from 'vscode';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import { nodeAt } from '@apim-policy/document';
import type { PolicyIndex } from '../workspace/policyIndex';

/** Go-to-definition and links from include-fragment's fragment-id to the fragment file. */
export function registerFragmentNavigation(cache: DocumentCache, index: PolicyIndex): vscode.Disposable {
  const fragmentIdAt = (document: vscode.TextDocument, offset: number) => {
    const hit = nodeAt(cache.get(document), offset);
    if (hit.element?.name !== 'include-fragment' || hit.attribute?.name !== 'fragment-id' || !hit.onAttributeValue) return undefined;
    return hit.attribute;
  };

  return vscode.Disposable.from(
    vscode.languages.registerDefinitionProvider(LANGUAGE_ID, {
      async provideDefinition(document, position) {
        const attr = fragmentIdAt(document, document.offsetAt(position));
        if (!attr?.value || !attr.valueRange) return undefined;
        const origin = toRange(document, attr.valueRange);
        const uris = await index.fragmentFiles(attr.value.trim(), document.uri);
        return uris.map<vscode.LocationLink>((targetUri) => ({
          originSelectionRange: origin,
          targetUri,
          targetRange: new vscode.Range(0, 0, 0, 0),
        }));
      },
    }),
    vscode.languages.registerDocumentLinkProvider(LANGUAGE_ID, {
      async provideDocumentLinks(document) {
        const doc = cache.get(document);
        const links: vscode.DocumentLink[] = [];
        const visit = async (nodes: typeof doc.children) => {
          for (const n of nodes) {
            if (n.type !== 'element') continue;
            const attr = n.name === 'include-fragment' ? n.attributes.find((a) => a.name === 'fragment-id') : undefined;
            if (attr?.value && attr.valueRange) {
              const [target] = await index.fragmentFiles(attr.value.trim(), document.uri);
              if (target) {
                const link = new vscode.DocumentLink(toRange(document, attr.valueRange), target);
                link.tooltip = `Open fragment ${attr.value.trim()}`;
                links.push(link);
              }
            }
            await visit(n.children);
          }
        };
        await visit(doc.children);
        return links;
      },
    }),
  );
}

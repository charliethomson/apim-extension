import * as vscode from 'vscode';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import { fragmentIdsFor } from '../parser/fragmentIds';
import { nodeAt } from '../parser/query';

const FRAGMENT_ROOT = /^﻿?\s*(?:<\?[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<fragment[\s/>]/;

/** Workspace XML files whose root is <fragment>, keyed by the fragment ids they provide. */
export class FragmentIndex implements vscode.Disposable {
  private readonly byId = new Map<string, Set<string>>();
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*.xml');
  private ready: Promise<void>;

  constructor() {
    this.ready = this.scan();
    this.watcher.onDidCreate((u) => void this.update(u));
    this.watcher.onDidChange((u) => void this.update(u));
    this.watcher.onDidDelete((u) => this.remove(u));
  }

  async lookup(id: string): Promise<vscode.Uri[]> {
    await this.ready;
    return [...(this.byId.get(id) ?? [])].map((s) => vscode.Uri.parse(s));
  }

  private async scan(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.xml', '**/{node_modules,.git,bin,obj}/**', 10000);
    await Promise.all(files.map((u) => this.update(u)));
  }

  private async update(uri: vscode.Uri): Promise<void> {
    this.remove(uri);
    let head: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      head = new TextDecoder().decode(bytes.subarray(0, 4096));
    } catch {
      return;
    }
    if (!FRAGMENT_ROOT.test(head)) return;
    for (const id of fragmentIdsFor(uri.path)) {
      let set = this.byId.get(id);
      if (!set) this.byId.set(id, (set = new Set()));
      set.add(uri.toString());
    }
  }

  private remove(uri: vscode.Uri): void {
    const key = uri.toString();
    for (const set of this.byId.values()) set.delete(key);
  }

  dispose(): void {
    this.watcher.dispose();
  }
}

/** Go-to-definition and links from include-fragment's fragment-id to the fragment file. */
export function registerFragmentNavigation(cache: DocumentCache, index: FragmentIndex): vscode.Disposable {
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
        const uris = await index.lookup(attr.value.trim());
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
              const [target] = await index.lookup(attr.value.trim());
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

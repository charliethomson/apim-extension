import * as vscode from 'vscode';
import type { Api, Backend, NamedValue, Product } from '@apim-policy/azure';
import { LANGUAGE_ID } from '../documents';
import { scopeLabel, type Scope } from '@apim-policy/core';
import type { InstanceConnection } from './connection';

type Node =
  | { kind: 'group'; group: 'products' | 'apis' | 'fragments' | 'namedValues' | 'backends' }
  | { kind: 'scope'; scope: Scope; label: string; description?: string; children?: 'operations' }
  | { kind: 'namedValue'; nv: NamedValue }
  | { kind: 'backend'; backend: Backend }
  | { kind: 'empty'; label: string };

const GROUPS: { group: Extract<Node, { kind: 'group' }>['group']; label: string; icon: string }[] = [
  { group: 'products', label: 'Products', icon: 'package' },
  { group: 'apis', label: 'APIs', icon: 'symbol-interface' },
  { group: 'fragments', label: 'Policy fragments', icon: 'symbol-snippet' },
  { group: 'namedValues', label: 'Named values', icon: 'symbol-constant' },
  { group: 'backends', label: 'Backends', icon: 'server' },
];

/**
 * The explorer for the connected instance: its policies at every scope, fragments, named values
 * and backends. Policies open as the same read-only documents the editor features use. Nothing
 * loads until a node is expanded, and everything comes from the connection's cache.
 */
class InstanceTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  /** Set once the view first asks for children: only then is the extension started for it. */
  subscription?: vscode.Disposable;

  constructor(private readonly connection: () => Promise<InstanceConnection>) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const c = await this.connection();
    this.subscription ??= vscode.Disposable.from(
      c.onDidChange(() => this.refresh()),
      c.onDidChangeState(() => this.refresh()),
    );
    const i = c.current;
    if (!i) return [];
    if (!node) {
      // Probe first: signed out or failing, the view shows its welcome text instead.
      await c.read(i.namedValues(), []);
      if (c.stateKind !== 'ok') return [];
      return [{ kind: 'scope', scope: { kind: 'global' }, label: 'Global policy' }, ...GROUPS.map((g) => ({ kind: 'group' as const, group: g.group }))];
    }
    if (node.kind === 'group') {
      const out = await this.group(c, node.group);
      return out.length ? out : [{ kind: 'empty', label: 'None' }];
    }
    if (node.kind === 'scope' && node.children === 'operations' && node.scope.kind === 'api') {
      const api = node.scope.api;
      const ops = await c.read(i.operations(api), []);
      return ops
        .slice()
        .sort((a, b) => a.urlTemplate.localeCompare(b.urlTemplate) || a.method.localeCompare(b.method))
        .map((o) => ({ kind: 'scope', scope: { kind: 'operation', api, operation: o.id }, label: o.displayName, description: `${o.method} ${o.urlTemplate}` }));
    }
    return [];
  }

  private async group(c: InstanceConnection, group: Extract<Node, { kind: 'group' }>['group']): Promise<Node[]> {
    const i = c.current!;
    const byName = <T>(f: (x: T) => string) => (a: T, b: T) => f(a).localeCompare(f(b));
    switch (group) {
      case 'products':
        return (await c.read(i.products(), [])).sort(byName((p: Product) => p.displayName)).map((p) => ({ kind: 'scope', scope: { kind: 'product', product: p.id }, label: p.displayName, description: p.id === p.displayName ? undefined : p.id }));
      case 'apis':
        return (await c.read(i.apis(), [])).sort(byName((a: Api) => a.displayName)).map((a) => ({ kind: 'scope', scope: { kind: 'api', api: a.id }, label: a.displayName, description: `/${a.path}`, children: 'operations' }));
      case 'fragments':
        return (await c.read(i.fragments(), [])).sort(byName((f) => f.id)).map((f) => ({ kind: 'scope', scope: { kind: 'fragment', fragment: f.id }, label: f.id, description: f.description }));
      case 'namedValues':
        return (await c.read(i.namedValues(), [])).sort(byName((nv: NamedValue) => nv.displayName)).map((nv) => ({ kind: 'namedValue', nv }));
      case 'backends':
        return (await c.read(i.backends(), [])).sort(byName((b: Backend) => b.id)).map((backend) => ({ kind: 'backend', backend }));
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'group': {
        const g = GROUPS.find((x) => x.group === node.group)!;
        const item = new vscode.TreeItem(g.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(g.icon);
        return item;
      }
      case 'scope': {
        const item = new vscode.TreeItem(node.label, node.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(SCOPE_ICONS[node.scope.kind]);
        item.tooltip = node.scope.kind === 'fragment' ? `Fragment ${node.scope.fragment}` : `Open the ${scopeLabel(node.scope)} policy`;
        item.contextValue = node.scope.kind === 'fragment' ? 'fragment' : `scope-${node.scope.kind}`;
        item.command = { title: 'Open', command: 'apimPolicy.openScope', arguments: [node.scope] };
        return item;
      }
      case 'namedValue': {
        const nv = node.nv;
        const item = new vscode.TreeItem(nv.displayName);
        item.description = nv.keyVault ? 'Key Vault' : nv.secret ? 'secret' : nv.value;
        item.iconPath = new vscode.ThemeIcon(nv.keyVault ? 'key' : nv.secret ? 'lock' : 'symbol-constant');
        item.tooltip = new vscode.MarkdownString(`\`{{${nv.displayName}}}\` (${nv.id})${nv.keyVault ? `\n\nKey Vault: ${nv.keyVault}` : nv.secret ? '\n\nSecret: its value isn\'t read.' : ''}`);
        item.contextValue = 'namedValue';
        return item;
      }
      case 'backend': {
        const item = new vscode.TreeItem(node.backend.id);
        item.description = node.backend.url;
        item.tooltip = [node.backend.url, node.backend.description].filter(Boolean).join('\n\n') || undefined;
        item.iconPath = new vscode.ThemeIcon('server');
        return item;
      }
      case 'empty':
        return new vscode.TreeItem(node.label);
    }
  }
}

const SCOPE_ICONS: Record<Scope['kind'], string> = {
  global: 'globe',
  workspace: 'folder-library',
  product: 'package',
  api: 'symbol-interface',
  operation: 'symbol-method',
  fragment: 'symbol-snippet',
};

/**
 * Registers the explorer and its commands. It's registered at activation, so it needs the
 * connection lazily: expanding it starts the rest of the extension.
 */
export function registerInstanceTree(connection: () => Promise<InstanceConnection>): vscode.Disposable {
  const tree = new InstanceTree(connection);
  const view = vscode.window.createTreeView('apimPolicy.instance', { treeDataProvider: tree, showCollapseAll: true });
  return vscode.Disposable.from(
    view,
    { dispose: () => void tree.subscription?.dispose() },
    vscode.commands.registerCommand('apimPolicy.openScope', async (scope: Scope) => {
      const c = await connection();
      const doc = await vscode.workspace.openTextDocument(c.policyUri(scope));
      if (doc.languageId !== LANGUAGE_ID) await vscode.languages.setTextDocumentLanguage(doc, LANGUAGE_ID);
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('apimPolicy.copyNamedValue', async (node?: Node) => {
      if (node?.kind !== 'namedValue') return;
      await vscode.env.clipboard.writeText(`{{${node.nv.displayName}}}`);
      void vscode.window.setStatusBarMessage(`Copied {{${node.nv.displayName}}}`, 2000);
    }),
    vscode.commands.registerCommand('apimPolicy.useAsScope', async (node?: Node) => {
      if (node?.kind !== 'scope' || node.scope.kind === 'fragment') return;
      const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find((e) => e.document.languageId === LANGUAGE_ID);
      if (!editor || editor.document.languageId !== LANGUAGE_ID || editor.document.uri.scheme === 'apim-instance') {
        void vscode.window.showInformationMessage('Open the local policy file first, then use this on the scope it belongs to.');
        return;
      }
      const c = await connection();
      await c.setScope(editor.document.uri, node.scope);
      void vscode.window.setStatusBarMessage(`${vscode.workspace.asRelativePath(editor.document.uri)} is the ${scopeLabel(node.scope)} policy`, 3000);
    }),
  );
}

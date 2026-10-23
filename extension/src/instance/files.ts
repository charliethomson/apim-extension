import * as vscode from 'vscode';
import { scopeFromInstancePath, scopeLabel, type Scope } from '@apim-policy/core';
import { INSTANCE_SCHEME, type InstanceConnection } from './connection';
import type { PushSupport } from './push';

/**
 * The editable copy of an instance document. Saving keeps a draft in memory; only **Push to
 * Instance** (a diff against a fresh pull, then an explicit confirmation) changes the instance.
 */
export const EDIT_SCHEME = 'apim-edit';

interface Opened {
  text: string;
  mtime: number;
}

/**
 * The instance's policies and fragments as files, at the paths `instancePath` gives:
 * `apim-instance:` read-only (what hover, go-to-definition and the explorer open), and
 * `apim-edit:` editable drafts. Nothing touches the disk, and nothing here writes to the
 * instance.
 */
class InstanceFileSystem implements vscode.FileSystemProvider {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  private readonly opened = new Map<string, Opened>();
  /** Saved edits to `apim-edit:` documents, by URI. Lost on reload, like any unpushed change. */
  private readonly drafts = new Map<string, string>();

  constructor(private readonly ready: () => Promise<{ connection: InstanceConnection }>) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (!scopeFromInstancePath(uri.path)) {
      // The folders above a policy, so breadcrumbs resolve.
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    let o = this.opened.get(uri.toString());
    if (!o) {
      await this.readFile(uri);
      o = this.opened.get(uri.toString())!;
    }
    return { type: vscode.FileType.File, ctime: 0, mtime: o.mtime, size: Buffer.byteLength(o.text), permissions: uri.scheme === EDIT_SCHEME ? undefined : vscode.FilePermission.Readonly };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const draft = uri.scheme === EDIT_SCHEME ? this.drafts.get(uri.toString()) : undefined;
    const text = draft ?? (await this.readCached(uri, uri.scheme === EDIT_SCHEME));
    this.opened.set(uri.toString(), { text, mtime: this.opened.get(uri.toString())?.mtime ?? Date.now() });
    return new TextEncoder().encode(text);
  }

  /**
   * What the instance has, from the connection's cache. The read-only copy says when there's
   * nothing; the editable one starts a missing policy as the default one.
   */
  private async readCached(uri: vscode.Uri, editable: boolean): Promise<string> {
    const i = (await this.ready()).connection.current;
    const scope = scopeFromInstancePath(uri.path);
    if (editable && !i) throw vscode.FileSystemError.Unavailable('No APIM instance is connected.');
    if (!i) return '<!-- No APIM instance is connected (apimPolicy.instance). -->\n';
    if (!scope) return '<!-- Not a policy on the instance. -->\n';
    try {
      // The editable copy starts from what's live now; the read-only one can use the cache.
      const xml = editable
        ? (scope.kind === 'fragment' ? await i.liveFragment(scope.fragment) : await i.livePolicy(scope)).xml
        : scope.kind === 'fragment'
          ? (await i.fragments()).find((x) => x.id === scope.fragment)?.xml
          : await i.policy(scope);
      if (xml !== undefined) return xml;
      return editable ? starter(scope) : `<!-- ${i.name} has no ${scope.kind === 'fragment' ? `fragment '${scope.fragment}'` : `policy at ${scopeLabel(scope)}`}. -->\n`;
    } catch (e) {
      if (editable) throw vscode.FileSystemError.Unavailable(`Couldn't read ${scopeLabel(scope)} from ${i.name}: ${(e as Error).message}`);
      return `<!-- Couldn't read ${scopeLabel(scope)} from ${i.name}: ${(e as Error).message} -->\n`;
    }
  }

  /** Saving an editable copy keeps it as a draft; the instance is only changed by a push. */
  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    if (uri.scheme !== EDIT_SCHEME) throw vscode.FileSystemError.NoPermissions('This is the read-only copy. Use Open as Editable to change it.');
    const text = new TextDecoder().decode(content);
    this.drafts.set(uri.toString(), text);
    this.opened.set(uri.toString(), { text, mtime: Date.now() });
  }

  /** Drops a draft and reads the instance again: the editor reloads when it has no unsaved edits. */
  reload(uri: vscode.Uri): void {
    this.drafts.delete(uri.toString());
    this.opened.delete(uri.toString());
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  /** After a push: the read-only copy of the same policy reads again. */
  pushed(uri: vscode.Uri): void {
    const twin = uri.with({ scheme: INSTANCE_SCHEME });
    this.opened.delete(twin.toString());
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri: twin }]);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('The instance view has no folders to create.');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Deleting from the instance isn’t supported.');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Renaming on the instance isn’t supported.');
  }

  /** Forget what was read, so reopening reads again (after Refresh Instance). */
  forget(): void {
    for (const key of this.opened.keys()) if (key.startsWith(`${INSTANCE_SCHEME}:`)) this.opened.delete(key);
  }
}

/** What a scope with no policy starts as: what APIM treats it as, `<base />` in every section. */
function starter(scope: Scope): string {
  if (scope.kind === 'fragment') return '<fragment>\n</fragment>\n';
  const section = (name: string) => `    <${name}>\n        <base />\n    </${name}>\n`;
  return `<policies>\n${['inbound', 'backend', 'outbound', 'on-error'].map(section).join('')}</policies>\n`;
}

export interface InstanceFiles {
  disposable: vscode.Disposable;
  openEditable: (arg?: unknown) => Promise<void>;
  reload: (arg?: unknown) => void;
  /** Tells the file system a document's text is now live, so read-only copies refresh. */
  pushed: (uri: vscode.Uri) => void;
}

export function registerInstanceFileSystem(ready: () => Promise<{ connection: InstanceConnection; support: PushSupport }>): InstanceFiles {
  let forgetting: vscode.Disposable | undefined;
  // What was read goes stale when the instance is refreshed; subscribe once something reads.
  const fs = new InstanceFileSystem(async () => {
    const r = await ready();
    forgetting ??= r.connection.onDidChange(() => fs.forget());
    return r;
  });

  /** Opens the editable copy of a scope (from the explorer) or of a read-only document. */
  const openEditable = async (arg?: unknown) => {
    const { connection, support } = await ready();
    let scope: Scope | undefined;
    if (arg instanceof vscode.Uri) scope = scopeFromInstancePath(arg.path);
    else if (arg && typeof arg === 'object' && 'scope' in arg) scope = (arg as { scope: Scope }).scope;
    else {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri?.scheme === INSTANCE_SCHEME) scope = scopeFromInstancePath(uri.path);
    }
    scope ??= (await connection.pickScope('Open a policy from the instance to edit')) ?? undefined;
    if (!scope) return;
    if (!(await support.ensureAllowed())) return;
    const uri = connection.policyUri(scope).with({ scheme: EDIT_SCHEME });
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== 'apim-policy') await vscode.languages.setTextDocumentLanguage(doc, 'apim-policy');
    await vscode.window.showTextDocument(doc, { preview: false });
  };

  const reload = (arg?: unknown) => {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === EDIT_SCHEME) fs.reload(uri);
  };

  return {
    openEditable,
    reload,
    pushed: (uri) => fs.pushed(uri),
    disposable: vscode.Disposable.from(
      vscode.workspace.registerFileSystemProvider(INSTANCE_SCHEME, fs, {
        isCaseSensitive: true,
        isReadonly: new vscode.MarkdownString('A read-only copy from the instance. Use **Open as Editable** (the pencil button) to change it.'),
      }),
      vscode.workspace.registerFileSystemProvider(EDIT_SCHEME, fs, { isCaseSensitive: true }),
      { dispose: () => void forgetting?.dispose() },
    ),
  };
}

/**
 * Keeps a shadow C# document per policy document and talks to the C# extension about it.
 *
 * Two modes, picked at startup:
 * - `file`: a .NET 10 file-based app on disk in global storage (`#:package Newtonsoft.Json`
 *   plus a top-level statement). Full semantics, including type errors. Needs the .NET 10 SDK.
 * - `virtual`: an in-memory `apim-cs:` document. Completion and hover work, but the server
 *   treats it as a loose file: no Newtonsoft and no type errors.
 *
 * The shadow is opened but never shown. Updates go through WorkspaceEdit on the open document
 * (the server doesn't watch the storage folder), followed by a save so the document isn't left
 * dirty, unless a save participant such as format-on-save changes it. Diagnostics for hidden documents aren't pushed, so they're pulled through the C#
 * extension's experimental.sendServerRequest export.
 */

import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { Document } from '../parser/ast';
import type { Catalog } from '../policy/schema';
import { LineIndex, type LspDiagnostic } from './mapping';
import { generateShadow, type Shadow } from './shadow';

export const CSHARP_EXTENSION_ID = 'ms-dotnettools.csharp';
const VIRTUAL_SCHEME = 'apim-cs';

export type BackendMode = 'file' | 'virtual';

export interface SyncedShadow {
  /** The policy document version this shadow was generated from. */
  version: number;
  shadow: Shadow;
  index: LineIndex;
  /** The open C# document holding the shadow. */
  csDoc: vscode.TextDocument;
  /** Offset in the shadow text where the appended stubs begin. */
  footerStart: number;
}

interface State {
  policyVersion: number;
  synced?: SyncedShadow;
  pending?: Promise<SyncedShadow | undefined>;
  file?: vscode.Uri;
  /** Set when a save participant (format on save, trim whitespace) changed the shadow. */
  noSave?: boolean;
}

interface CSharpApi {
  experimental?: {
    sendServerRequest?: (type: { method: string }, params: unknown, token: vscode.CancellationToken) => Promise<unknown>;
  };
}

export class ShadowBackend implements vscode.Disposable {
  private readonly states = new Map<string, State>();
  private readonly virtualText = new Map<string, string>();
  private readonly virtualChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    readonly mode: BackendMode,
    private readonly api: CSharpApi,
    private readonly storage: vscode.Uri,
    private readonly stubs: string,
    private readonly catalog: Catalog,
    /** Parses a policy document at its current version (the shared cache). */
    private readonly parseFor: (document: vscode.TextDocument) => Document,
  ) {
    if (mode === 'virtual') {
      const provider: vscode.TextDocumentContentProvider = {
        onDidChange: this.virtualChanged.event,
        provideTextDocumentContent: (uri) => this.virtualText.get(uri.toString()) ?? '',
      };
      this.disposables.push(vscode.workspace.registerTextDocumentContentProvider(VIRTUAL_SCHEME, provider));
    }
    this.disposables.push(this.virtualChanged);
  }

  /**
   * Activates the C# extension and picks a mode. Returns undefined when the C# extension isn't
   * installed or doesn't expose what we need.
   */
  static async create(
    context: vscode.ExtensionContext,
    catalog: Catalog,
    preferred: 'auto' | BackendMode,
    parseFor: (document: vscode.TextDocument) => Document,
  ): Promise<ShadowBackend | undefined> {
    const ext = vscode.extensions.getExtension<CSharpApi>(CSHARP_EXTENSION_ID);
    if (!ext) return undefined;
    const api = await ext.activate();
    const stubsUri = vscode.Uri.joinPath(context.extensionUri, 'stubs', 'ApimContext.cs');
    const stubs = new TextDecoder().decode(await vscode.workspace.fs.readFile(stubsUri));
    const mode = preferred === 'auto' ? ((await dotnetSdkMajor()) >= 10 ? 'file' : 'virtual') : preferred;
    // globalStorageUri can use the vscode-userdata: scheme, which the C# server treats as a loose
    // file with no semantics. The shadow has to be a plain file: URI to load as a project.
    // Global storage is shared by every window, so each window gets its own folder.
    const root = vscode.Uri.file(vscode.Uri.joinPath(context.globalStorageUri, 'shadow').fsPath);
    const storage = vscode.Uri.joinPath(root, vscode.env.sessionId.replace(/[^\w-]/g, '_'));
    if (mode === 'file') {
      await removeStaleSessions(root);
      await vscode.workspace.fs.createDirectory(storage);
    }
    return new ShadowBackend(mode, api ?? {}, storage, stubs, catalog, parseFor);
  }

  get canPullDiagnostics(): boolean {
    return typeof this.api.experimental?.sendServerRequest === 'function';
  }

  /** The stubs file shipped with the extension, for definitions that land in the stubs. */
  stubsUri(context: vscode.ExtensionContext): vscode.Uri {
    return vscode.Uri.joinPath(context.extensionUri, 'stubs', 'ApimContext.cs');
  }

  /**
   * Brings the shadow for `document` up to date and returns it. Check `version` on the result:
   * when the document changes while an update is queued, the result can already be behind.
   */
  sync(document: vscode.TextDocument): Promise<SyncedShadow | undefined> {
    if (document.isClosed) return Promise.resolve(undefined);
    const key = document.uri.toString();
    let state = this.states.get(key);
    if (!state) this.states.set(key, (state = { policyVersion: -1 }));
    if (state.synced && state.policyVersion === document.version && !state.synced.csDoc.isClosed) return Promise.resolve(state.synced);
    const s = state;
    const run = async (): Promise<SyncedShadow | undefined> => {
      // Read the version and the parse together, when the update actually runs: an update
      // queued behind another must not record an older parse under a newer version.
      if (document.isClosed || this.states.get(key) !== s) return undefined;
      if (s.synced && s.policyVersion === document.version && !s.synced.csDoc.isClosed) return s.synced;
      const version = document.version;
      const shadow = generateShadow(this.parseFor(document), this.catalog, this.shadowOptions(document));
      const footerStart = shadow.text.length - this.stubs.length;
      const csDoc = await this.write(s, document, shadow.text);
      if (!csDoc || this.states.get(key) !== s) return undefined;
      s.policyVersion = version;
      s.synced = { version, shadow, index: new LineIndex(shadow.text), csDoc, footerStart };
      return s.synced;
    };
    // Serialise updates per document.
    const next = (s.pending ?? Promise.resolve(undefined)).then(run, run);
    s.pending = next;
    return next;
  }

  /** Pulls the server's diagnostics for a synced shadow, in shadow coordinates. */
  async diagnostics(synced: SyncedShadow, token: vscode.CancellationToken): Promise<LspDiagnostic[] | undefined> {
    const send = this.api.experimental?.sendServerRequest;
    if (!send) return undefined;
    const res = (await send({ method: 'textDocument/diagnostic' }, { textDocument: { uri: synced.csDoc.uri.toString() } }, token)) as
      | { kind?: string; items?: LspDiagnostic[] }
      | undefined;
    return res?.kind === 'full' ? (res.items ?? []) : undefined;
  }

  forget(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const state = this.states.get(key);
    this.states.delete(key);
    // Delete after any in-flight update has finished writing.
    const file = state?.file;
    if (file) {
      void (state.pending ?? Promise.resolve())
        .then(undefined, () => undefined)
        .then(() => vscode.workspace.fs.delete(vscode.Uri.joinPath(file, '..'), { recursive: true, useTrash: false }))
        .then(undefined, () => undefined);
    }
    if (this.mode === 'virtual') this.virtualText.delete(this.virtualUri(document).toString());
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    // Don't leave this window's expression code behind in global storage.
    if (this.mode === 'file') {
      try {
        rmSync(this.storage.fsPath, { recursive: true, force: true });
      } catch {
        // Best effort; stale folders are swept on the next start.
      }
    }
  }

  private shadowOptions(document: vscode.TextDocument) {
    const sourceName = vscode.workspace.asRelativePath(document.uri);
    if (this.mode === 'file') {
      return {
        header: '#:package Newtonsoft.Json@13.0.3\n#:property Nullable=disable',
        prelude: 'return;',
        footer: this.stubs,
        sourceName,
      };
    }
    return { footer: this.stubs, sourceName };
  }

  private virtualUri(document: vscode.TextDocument): vscode.Uri {
    return vscode.Uri.from({ scheme: VIRTUAL_SCHEME, path: `/${hash(document.uri.toString())}/policy.cs` });
  }

  private async write(state: State, document: vscode.TextDocument, text: string): Promise<vscode.TextDocument | undefined> {
    if (this.mode === 'virtual') {
      const uri = this.virtualUri(document);
      const changed = this.virtualText.get(uri.toString()) !== text;
      this.virtualText.set(uri.toString(), text);
      let csDoc = await vscode.workspace.openTextDocument(uri);
      if (csDoc.languageId !== 'csharp') csDoc = await vscode.languages.setTextDocumentLanguage(csDoc, 'csharp');
      if (changed && csDoc.getText() !== text) {
        this.virtualChanged.fire(uri);
        return waitForText(uri, text);
      }
      return csDoc;
    }

    // One folder per policy so each file-based app restores on its own.
    state.file ??= vscode.Uri.joinPath(this.storage, hash(document.uri.toString()), 'policy.cs');
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === state.file!.toString());
    if (!open) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(state.file, '..'));
      await vscode.workspace.fs.writeFile(state.file, new TextEncoder().encode(text));
      return vscode.workspace.openTextDocument(state.file);
    }
    if (open.getText() === text) return open;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(open.uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
    if (!state.noSave) {
      await open.save();
      if (open.getText() !== text) {
        // A save participant rewrote it. Put our text back and stop saving this one; it stays
        // dirty, which hot exit handles quietly.
        state.noSave = true;
        const undo = new vscode.WorkspaceEdit();
        undo.replace(open.uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), text);
        await vscode.workspace.applyEdit(undo);
      }
    }
    return open;
  }
}

/** The major version of the newest installed .NET SDK, or 0. */
export function dotnetSdkMajor(): Promise<number> {
  return new Promise((resolve) => {
    execFile('dotnet', ['--list-sdks'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(0);
      const majors = stdout
        .split('\n')
        .map((l) => parseInt(l, 10))
        .filter((n) => Number.isFinite(n));
      resolve(majors.length ? Math.max(...majors) : 0);
    });
  });
}

/** Removes other windows' shadow folders that haven't been touched for a week. */
async function removeStaleSessions(root: vscode.Uri): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [name, type] of entries) {
    const uri = vscode.Uri.joinPath(root, name);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (type !== vscode.FileType.Directory || stat.mtime < cutoff) await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
    } catch {
      // In use or already gone.
    }
  }
}

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/** Waits for a virtual document to show `text`; undefined if it doesn't within 2 seconds. */
async function waitForText(uri: vscode.Uri, text: string): Promise<vscode.TextDocument | undefined> {
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.getText() === text) return doc;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(undefined);
    }, 2000);
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === uri.toString() && e.document.getText() === text) {
        clearTimeout(timer);
        sub.dispose();
        resolve(e.document);
      }
    });
  });
}

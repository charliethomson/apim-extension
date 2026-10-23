import { open } from 'node:fs/promises';
import * as vscode from 'vscode';
import { LANGUAGE_ID, type DocumentCache } from '../documents';
import { looksLikePolicy, PROLOG_LIMIT, scanRoot } from '../parser/detect';
import { fragmentIdsFor } from '../parser/fragmentIds';
import type { Document } from '../parser/ast';
import { parse } from '../parser/scanner';
import type { Suggestion } from '../policy/completion';
import type { OuterSet } from '../policy/scopes';
import { scopeFromInstancePath, scopeLabel } from '../scope';
import { knownVariables, summarize, type KnownVariable, type PolicySummary, type RelatedFile } from '../policy/variables';
import type { NamedValue } from '../apim/instance';
import type { InstanceConnection, RemoteFragment } from './instance';

interface Entry {
  uri: vscode.Uri;
  fragmentIds: string[];
  summary: PolicySummary;
  /** A fragment's parse, for what needs more than the summary (JSON shapes). Other files keep only the summary. */
  doc?: Document;
}

/**
 * Every policy file in the workspace with what it declares: fragment ids, includes, variables and
 * named values. Open documents are indexed from their live text. With an instance connected, its
 * fragments, named values and backends join in (a workspace file wins over the instance's copy),
 * and so do the variables its broader scopes set.
 */
export class PolicyIndex implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly apiOpsNamedValues = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private scanned?: Promise<void>;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when any indexed file's summary changes (debounced). */
  readonly onDidChange = this.changed.event;
  private changeTimer?: NodeJS.Timeout;
  private remote?: InstanceConnection;

  constructor(private readonly cache: DocumentCache) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.xml');
    this.disposables.push(
      watcher,
      watcher.onDidCreate((u) => this.scanned && !ignored(u) && void this.updateFromDisk(u)),
      watcher.onDidChange((u) => {
        if (!this.scanned || ignored(u) || vscode.workspace.textDocuments.some((d) => d.uri.toString() === u.toString())) return;
        void this.updateFromDisk(u);
      }),
      watcher.onDidDelete((u) => this.delete(u.toString())),
      vscode.workspace.onDidChangeTextDocument((e) => this.updateFromDocument(e.document)),
      vscode.workspace.onDidOpenTextDocument((d) => this.updateFromDocument(d)),
      vscode.workspace.onDidCloseTextDocument((d) => d.uri.scheme === 'apim-edit' && this.delete(d.uri.toString())),
    );
  }

  /**
   * The workspace scan starts the first time a policy needs it, not on activation: the
   * extension activates for every XML file, including .csproj and web.config.
   */
  private get ready(): Promise<void> {
    return (this.scanned ??= this.scan());
  }

  /** Adds an instance's fragments, named values and outer scopes to what the index answers. */
  attach(remote: InstanceConnection): void {
    this.remote = remote;
    this.disposables.push(remote.onDidChange(() => this.notify()));
  }

  private async remoteFragments(): Promise<RemoteFragment[]> {
    return this.remote ? this.remote.fragments() : [];
  }

  /** The workspace files that include any of `fragmentIds`. */
  async callers(fragmentIds: readonly string[]): Promise<{ uri: vscode.Uri; summary: PolicySummary }[]> {
    await this.ready;
    return [...this.entries.values()].filter((e) => e.uri.scheme === 'file' && e.summary.includes.some((id) => fragmentIds.includes(id))).map((e) => ({ uri: e.uri, summary: e.summary }));
  }

  /** The fragments in workspace files, with their parses. */
  async localFragments(): Promise<{ uri: vscode.Uri; ids: string[]; doc: Document }[]> {
    await this.ready;
    return [...this.entries.values()].flatMap((e) => (e.uri.scheme === 'file' && e.fragmentIds.length && e.doc ? [{ uri: e.uri, ids: e.fragmentIds, doc: e.doc }] : []));
  }

  /**
   * Where fragment `id` is. From a workspace file (or with no `from`): the workspace's files, else
   * the instance's copy. From a document on the instance: the instance's copy (an open editable one
   * when there is one), else the workspace's, so an instance policy leads to the instance fragment
   * it includes.
   */
  async fragmentFiles(id: string, from?: vscode.Uri): Promise<vscode.Uri[]> {
    return (await this.candidates(id, from)).map((c) => c.uri);
  }

  /** Fragment `id` with its summary and parse, chosen as `fragmentFiles` orders them. */
  async fragment(id: string, from?: vscode.Uri): Promise<{ uri: vscode.Uri; summary: PolicySummary; doc?: Document } | undefined> {
    return (await this.candidates(id, from))[0];
  }

  private async candidates(id: string, from?: vscode.Uri): Promise<{ uri: vscode.Uri; summary: PolicySummary; doc?: Document }[]> {
    await this.ready;
    const entries = [...this.entries.values()].filter((e) => e.fragmentIds.includes(id));
    const files = entries.filter((e) => e.uri.scheme === 'file');
    const edits = entries.filter((e) => e.uri.scheme !== 'file');
    const remote = async () => (await this.remoteFragments()).filter((f) => f.id === id);
    if (from && isInstanceUri(from)) {
      // An open editable copy stands in for the instance's version of the same fragment.
      const instance = edits.length ? edits : await remote();
      return instance.length ? instance : files;
    }
    if (files.length) return files;
    return edits.length ? edits : remote();
  }

  /** `remoteWithin`: give up on the instance's list after that many ms (completion can't wait). */
  async fragmentIds(options: { remoteWithin?: number } = {}): Promise<string[]> {
    await this.ready;
    const pending = this.remoteFragments();
    const list = options.remoteWithin === undefined ? await pending : await within(pending, [], options.remoteWithin);
    const remote = list.map((f) => f.id);
    return [...new Set([...[...this.entries.values()].flatMap((e) => e.fragmentIds), ...remote])].sort();
  }

  /** Named values: the instance's with their values, then names only the workspace mentions. */
  async namedValues(): Promise<Suggestion[]> {
    await this.ready;
    const remote = this.remote ? await this.remote.namedValues() : [];
    const out: Suggestion[] = remote.map((nv) => ({ name: nv.displayName, detail: namedValueDetail(nv), documentation: namedValueDocs(nv) }));
    const seen = new Set(out.map((s) => s.name.toLowerCase()));
    const local = new Set(this.apiOpsNamedValues);
    for (const e of this.entries.values()) e.summary.namedValues.forEach((n) => local.add(n));
    for (const n of local) if (!seen.has(n.toLowerCase())) out.push({ name: n });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** What the instance says about the named value `{{name}}`. */
  async namedValue(name: string): Promise<NamedValue | undefined> {
    if (!this.remote) return undefined;
    const lower = name.toLowerCase();
    return (await this.remote.namedValues()).find((nv) => nv.displayName.toLowerCase() === lower);
  }

  async backends(): Promise<Suggestion[]> {
    if (!this.remote) return [];
    return (await this.remote.backends()).map((b) => ({ name: b.id, detail: b.url, documentation: b.description }));
  }

  /** What the broader scopes set, placed in `document`; nothing without an instance and a scope. */
  async outerVariables(document: vscode.TextDocument): Promise<OuterSet[]> {
    if (!this.remote) return [];
    await this.ready;
    // What includes in the outer policies set: the workspace's copy of a fragment, else the instance's.
    const summaries = new Map<string, PolicySummary>();
    for (const f of await this.remote.fragments()) summaries.set(f.id, f.summary);
    for (const e of this.entries.values()) for (const id of e.fragmentIds) summaries.set(id, e.summary);
    const includeSets = (id: string) => {
      const s = summaries.get(id);
      return s && (s.header ? s.header.outputs.map((v) => v.name) : s.variables.map((v) => v.name));
    };
    return this.remote.outerVariables(document, this.cache.get(document), includeSets);
  }

  /** Whether `dir` holds an APIOps extract: apis/ or policyFragments/ under it. */
  isExtractRoot(dir: string): boolean {
    const prefix = vscode.Uri.file(dir).toString();
    for (const key of this.entries.keys()) if (key.startsWith(`${prefix}/apis/`) || key.startsWith(`${prefix}/policyFragments/`)) return true;
    return false;
  }

  /** Variables visible in `document`, including through fragments and their callers. */
  async variables(document: vscode.TextDocument): Promise<(KnownVariable & { uri: vscode.Uri })[]> {
    await this.ready;
    const self = this.entryFor(document);
    const others: RelatedFile[] = [];
    for (const e of this.entries.values()) {
      if (e.uri.toString() === document.uri.toString()) continue;
      others.push({ key: e.uri.toString(), label: vscode.workspace.asRelativePath(e.uri), fragmentIds: e.fragmentIds, summary: e.summary });
    }
    // Fragments only the instance has; a workspace copy of the same id wins. Completion asks for
    // these too, so the instance gets 300 ms.
    const localIds = new Set(others.flatMap((o) => o.fragmentIds));
    for (const f of await within(this.remoteFragments(), [], 300)) {
      if (!localIds.has(f.id)) others.push({ key: f.uri.toString(), label: `fragment ${f.id} (instance)`, fragmentIds: [f.id], summary: f.summary });
    }
    const known = knownVariables(self.summary, self.fragmentIds, others).map((v) => ({
      ...v,
      uri: v.originKey ? vscode.Uri.parse(v.originKey) : document.uri,
    }));
    const names = new Set(known.map((v) => v.name));
    const remote = this.remote;
    if (!remote) return known;
    // Completion asks for these, so the instance gets 300 ms; the read carries on for next time.
    for (const o of await within(this.outerVariables(document), [], 300)) {
      if (names.has(o.name)) continue;
      names.add(o.name);
      known.push({ name: o.name, range: { start: 0, end: 0 }, element: 'set-variable', origin: `set by ${scopeLabel(o.scope)}`, uri: remote.policyUri(o.scope) });
    }
    return known;
  }

  private entryFor(document: vscode.TextDocument): Entry {
    const doc = this.cache.get(document);
    const summary = summarize(doc);
    // An editable copy from the instance is that fragment, by the id in its path.
    const instance = document.uri.scheme === 'apim-edit' ? scopeFromInstancePath(document.uri.path) : undefined;
    const ids = summary.root !== 'fragment' ? [] : instance ? (instance.kind === 'fragment' ? [instance.fragment] : []) : fragmentIdsFor(document.uri.path);
    return { uri: document.uri, fragmentIds: ids, summary, doc };
  }

  /**
   * Files from their live text. An open editable copy of an instance fragment (`apim-edit:`) is
   * indexed too, so it stands in for the instance's version while you work on it: its callers see
   * the edits before they're pushed. Closing it goes back to the instance's version.
   */
  private updateFromDocument(document: vscode.TextDocument): void {
    if (document.languageId !== LANGUAGE_ID || (document.uri.scheme !== 'file' && document.uri.scheme !== 'apim-edit')) return;
    this.set(document.uri.toString(), this.entryFor(document));
  }

  private async scan(): Promise<void> {
    const [files, nvs] = await Promise.all([
      vscode.workspace.findFiles('**/*.xml', '**/{node_modules,.git,bin,obj}/**', 10000),
      vscode.workspace.findFiles('**/namedValues/*/namedValueInformation.json', '**/node_modules/**', 5000),
    ]);
    for (const u of nvs) {
      const parts = u.path.split('/');
      this.apiOpsNamedValues.add(parts[parts.length - 2]);
    }
    const queue = files.filter((u) => !ignored(u));
    const worker = async () => {
      for (let u = queue.pop(); u; u = queue.pop()) await this.updateFromDisk(u);
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    vscode.workspace.textDocuments.forEach((d) => this.updateFromDocument(d));
  }

  private async updateFromDisk(uri: vscode.Uri): Promise<void> {
    let text: string | undefined;
    try {
      text = await readPolicy(uri);
    } catch {
      return;
    }
    if (text === undefined) {
      this.delete(uri.toString());
      return;
    }
    const doc = parse(text);
    const summary = summarize(doc);
    const fragment = summary.root === 'fragment';
    this.set(uri.toString(), { uri, fragmentIds: fragment ? fragmentIdsFor(uri.path) : [], summary, doc: fragment ? doc : undefined });
  }

  private set(key: string, entry: Entry): void {
    this.entries.set(key, entry);
    this.notify();
  }

  private delete(key: string): void {
    if (this.entries.delete(key)) this.notify();
  }

  /** One event per burst: a workspace scan or a typing run updates many entries. */
  private notify(): void {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.changed.fire(), 300);
  }

  dispose(): void {
    clearTimeout(this.changeTimer);
    this.changed.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/**
 * `p`, or `fallback` when it takes longer than `ms`; `p` carries on either way. Completion uses it
 * so the instance's first read over the network doesn't hold it up.
 */
export function within<T>(p: Promise<T>, fallback: T, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]).finally(() => clearTimeout(timer));
}

function namedValueDetail(nv: NamedValue): string {
  return nv.keyVault ? 'Key Vault secret' : nv.secret ? 'secret' : (nv.value ?? '');
}

function namedValueDocs(nv: NamedValue): string {
  if (nv.keyVault) return `Named value \`${nv.displayName}\` (${nv.id}), a Key Vault reference: ${nv.keyVault}`;
  if (nv.secret) return `Named value \`${nv.displayName}\` (${nv.id}), secret. Its value isn't read.`;
  return `Named value \`${nv.displayName}\` (${nv.id}): ${nv.value ?? ''}`;
}

/** APIM caps a fragment at 512 KB; a file far bigger than that isn't a policy. */
const MAX_POLICY_BYTES = 2 * 1024 * 1024;

function ignored(uri: vscode.Uri): boolean {
  return /\/(node_modules|\.git|bin|obj)\//.test(uri.path);
}

/** How much of a file decides whether it's a policy. */
const HEAD_BYTES = 4096;

/**
 * A policy file's text, or undefined when the file isn't a policy (judged from its first 4 KB)
 * or is too big to be one. On local disk the file is opened once, and only a policy is read past
 * its head: with on-access scanning every open costs a scan, and most XML isn't a policy.
 */
async function readPolicy(uri: vscode.Uri): Promise<string | undefined> {
  if (uri.scheme === 'file') {
    const handle = await open(uri.fsPath, 'r');
    try {
      const { size } = await handle.stat();
      if (size > MAX_POLICY_BYTES) return undefined;
      const buf = Buffer.alloc(size);
      let read = (await handle.read(buf, 0, Math.min(HEAD_BYTES, size), 0)).bytesRead;
      // A long leading comment (a fragment header) can fill the head: read on until the root shows.
      while (read < size && read < PROLOG_LIMIT && scanRoot(new TextDecoder().decode(buf.subarray(0, read))).more) {
        const { bytesRead } = await handle.read(buf, read, Math.min(HEAD_BYTES, size - read), read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      if (!looksLikePolicy(new TextDecoder().decode(buf.subarray(0, read)))) return undefined;
      while (read < size) {
        const { bytesRead } = await handle.read(buf, read, size - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return new TextDecoder().decode(buf.subarray(0, read));
    } finally {
      await handle.close();
    }
  }
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > MAX_POLICY_BYTES) return undefined;
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  return looksLikePolicy(text) ? text : undefined;
}

/** A document read from or edited on the connected instance, not a workspace file. */
function isInstanceUri(uri: vscode.Uri): boolean {
  return uri.scheme.startsWith('apim-');
}

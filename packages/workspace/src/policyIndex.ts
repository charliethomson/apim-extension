import { fragmentIdsFor, scopeFromInstancePath, scopeLabel } from '@apim-policy/core';
import { type Document, parse } from '@apim-policy/document';
import type { Suggestion } from '@apim-policy/catalog';
import { type KnownVariable, knownVariables, type OuterSet, type PolicySummary, type RelatedFile, summarize } from '@apim-policy/analysis';
import type { NamedValue } from '@apim-policy/azure';
import { type Disposable, EDIT_SCHEME, type InstanceSource, type RemoteFragment, type WorkspaceHost } from './host';

interface Entry<U> {
  uri: U;
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
 *
 * The host reports file and document events (`fileCreated`, `documentChanged`, …); the index
 * decides what they mean.
 */
export class PolicyIndex<U> implements Disposable {
  private readonly entries = new Map<string, Entry<U>>();
  private readonly apiOpsNamedValues = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly disposables: Disposable[] = [];
  private scanned?: Promise<void>;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private remote?: InstanceSource<U>;

  constructor(private readonly host: WorkspaceHost<U>) {}

  /** Calls `listener` when any indexed file's summary changes (debounced). */
  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * The workspace scan starts the first time a policy needs it, not on activation: the
   * extension activates for every XML file, including .csproj and web.config.
   */
  private get ready(): Promise<void> {
    return (this.scanned ??= this.scan());
  }

  /** Adds an instance's fragments, named values and outer scopes to what the index answers. */
  attach(remote: InstanceSource<U>): void {
    this.remote = remote;
    this.disposables.push(remote.onDidChange(() => this.notify()));
  }

  // ---- events from the host ---------------------------------------------------------------------

  fileCreated(uri: U): void {
    if (this.scanned && !this.ignored(uri)) void this.updateFromDisk(uri);
  }

  /** An open document's file changing on disk is the editor's business; its text comes from there. */
  fileChanged(uri: U): void {
    if (!this.scanned || this.ignored(uri) || this.host.isOpen(uri)) return;
    void this.updateFromDisk(uri);
  }

  fileDeleted(uri: U): void {
    this.delete(this.host.key(uri));
  }

  /**
   * A policy's live text, opened or edited. An open editable copy of an instance fragment
   * (`apim-edit:`) is indexed too, so it stands in for the instance's version while you work on
   * it: its callers see the edits before they're pushed. Other schemes aren't indexed.
   */
  documentChanged(uri: U, doc: Document): void {
    const scheme = this.host.scheme(uri);
    if (scheme !== 'file' && scheme !== EDIT_SCHEME) return;
    this.set(this.host.key(uri), this.entryFor(uri, doc));
  }

  /** Closing an editable copy goes back to the instance's version. */
  documentClosed(uri: U): void {
    if (this.host.scheme(uri) === EDIT_SCHEME) this.delete(this.host.key(uri));
  }

  // ---- queries ----------------------------------------------------------------------------------

  private async remoteFragments(): Promise<RemoteFragment<U>[]> {
    return this.remote ? this.remote.fragments() : [];
  }

  /** The workspace files that include any of `fragmentIds`. */
  async callers(fragmentIds: readonly string[]): Promise<{ uri: U; summary: PolicySummary }[]> {
    await this.ready;
    return [...this.entries.values()].filter((e) => this.isFile(e.uri) && e.summary.includes.some((id) => fragmentIds.includes(id))).map((e) => ({ uri: e.uri, summary: e.summary }));
  }

  /**
   * What the files that include the fragment at `uri` read: the variables that should be its
   * @outs. An instance copy is that fragment by the id in its path; a file, by its file name.
   */
  async readByCallers(uri: U): Promise<Set<string>> {
    const path = this.host.path(uri);
    const scope = this.isFile(uri) ? undefined : scopeFromInstancePath(path);
    const ids = scope?.kind === 'fragment' ? [scope.fragment] : fragmentIdsFor(path);
    const callers = await this.callers(ids);
    return new Set(callers.flatMap((c) => c.summary.reads.map((r) => r.name)));
  }

  /** The fragments in workspace files, with their parses. */
  async localFragments(): Promise<{ uri: U; ids: string[]; doc: Document }[]> {
    await this.ready;
    return [...this.entries.values()].flatMap((e) => (this.isFile(e.uri) && e.fragmentIds.length && e.doc ? [{ uri: e.uri, ids: e.fragmentIds, doc: e.doc }] : []));
  }

  /**
   * Where fragment `id` is. From a workspace file (or with no `from`): the workspace's files, else
   * the instance's copy. From a document on the instance: the instance's copy (an open editable one
   * when there is one), else the workspace's, so an instance policy leads to the instance fragment
   * it includes.
   */
  async fragmentFiles(id: string, from?: U): Promise<U[]> {
    return (await this.candidates(id, from)).map((c) => c.uri);
  }

  /** Fragment `id` with its summary and parse, chosen as `fragmentFiles` orders them. */
  async fragment(id: string, from?: U): Promise<{ uri: U; summary: PolicySummary; doc?: Document } | undefined> {
    return (await this.candidates(id, from))[0];
  }

  private async candidates(id: string, from?: U): Promise<{ uri: U; summary: PolicySummary; doc?: Document }[]> {
    await this.ready;
    const entries = [...this.entries.values()].filter((e) => e.fragmentIds.includes(id));
    const files = entries.filter((e) => this.isFile(e.uri));
    const edits = entries.filter((e) => !this.isFile(e.uri));
    const remote = async () => (await this.remoteFragments()).filter((f) => f.id === id);
    if (from && this.host.scheme(from).startsWith('apim-')) {
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

  /** What the broader scopes set, placed in `doc` (the policy at `uri`); nothing without an instance and a scope. */
  async outerVariables(uri: U, doc: Document): Promise<OuterSet[]> {
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
    return this.remote.outerVariables(uri, doc, includeSets);
  }

  /** Whether `dir` holds an APIOps extract: apis/ or policyFragments/ under it. */
  isExtractRoot(dir: string): boolean {
    const prefix = this.host.key(this.host.file(dir));
    for (const key of this.entries.keys()) if (key.startsWith(`${prefix}/apis/`) || key.startsWith(`${prefix}/policyFragments/`)) return true;
    return false;
  }

  /** Variables visible in `doc` (the policy at `uri`), including through fragments and their callers. */
  async variables(uri: U, doc: Document): Promise<(KnownVariable & { uri: U })[]> {
    await this.ready;
    const self = this.entryFor(uri, doc);
    const selfKey = this.host.key(uri);
    const others: RelatedFile[] = [];
    for (const [key, e] of this.entries) {
      if (key === selfKey) continue;
      others.push({ key, label: this.host.label(e.uri), fragmentIds: e.fragmentIds, summary: e.summary });
    }
    // Fragments only the instance has; a workspace copy of the same id wins. Completion asks for
    // these too, so the instance gets 300 ms.
    const localIds = new Set(others.flatMap((o) => o.fragmentIds));
    for (const f of await within(this.remoteFragments(), [], 300)) {
      if (!localIds.has(f.id)) others.push({ key: this.host.key(f.uri), label: `fragment ${f.id} (instance)`, fragmentIds: [f.id], summary: f.summary });
    }
    const known = knownVariables(self.summary, self.fragmentIds, others).map((v) => ({
      ...v,
      uri: v.originKey ? this.host.parse(v.originKey) : uri,
    }));
    const names = new Set(known.map((v) => v.name));
    const remote = this.remote;
    if (!remote) return known;
    // Completion asks for these, so the instance gets 300 ms; the read carries on for next time.
    for (const o of await within(this.outerVariables(uri, doc), [], 300)) {
      if (names.has(o.name)) continue;
      names.add(o.name);
      known.push({ name: o.name, range: { start: 0, end: 0 }, element: 'set-variable', origin: `set by ${scopeLabel(o.scope)}`, uri: remote.policyUri(o.scope) });
    }
    return known;
  }

  // ---- upkeep -----------------------------------------------------------------------------------

  private entryFor(uri: U, doc: Document): Entry<U> {
    const summary = summarize(doc);
    // An editable copy from the instance is that fragment, by the id in its path.
    const path = this.host.path(uri);
    const instance = this.host.scheme(uri) === EDIT_SCHEME ? scopeFromInstancePath(path) : undefined;
    const ids = summary.root !== 'fragment' ? [] : instance ? (instance.kind === 'fragment' ? [instance.fragment] : []) : fragmentIdsFor(path);
    return { uri, fragmentIds: ids, summary, doc };
  }

  private isFile(uri: U): boolean {
    return this.host.scheme(uri) === 'file';
  }

  private ignored(uri: U): boolean {
    return IGNORED.test(this.host.path(uri));
  }

  private async scan(): Promise<void> {
    const [files, nvs] = await Promise.all([this.host.findPolicyFiles(), this.host.findNamedValueFiles()]);
    for (const u of nvs) {
      const parts = this.host.path(u).split('/');
      this.apiOpsNamedValues.add(parts[parts.length - 2]);
    }
    const queue = files.filter((u) => !this.ignored(u));
    const worker = async () => {
      for (let u = queue.pop(); u; u = queue.pop()) await this.updateFromDisk(u);
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    for (const { uri, doc } of this.host.openPolicies()) this.documentChanged(uri, doc);
  }

  private async updateFromDisk(uri: U): Promise<void> {
    let text: string | undefined;
    try {
      text = await this.host.readPolicy(uri);
    } catch {
      return;
    }
    if (text === undefined) {
      this.delete(this.host.key(uri));
      return;
    }
    const doc = parse(text);
    const summary = summarize(doc);
    const fragment = summary.root === 'fragment';
    this.set(this.host.key(uri), { uri, fragmentIds: fragment ? fragmentIdsFor(this.host.path(uri)) : [], summary, doc: fragment ? doc : undefined });
  }

  private set(key: string, entry: Entry<U>): void {
    this.entries.set(key, entry);
    this.notify();
  }

  private delete(key: string): void {
    if (this.entries.delete(key)) this.notify();
  }

  /** One event per burst: a workspace scan or a typing run updates many entries. */
  private notify(): void {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.listeners.forEach((l) => l()), 300);
  }

  dispose(): void {
    clearTimeout(this.changeTimer);
    this.listeners.clear();
    for (const d of this.disposables) d.dispose();
  }
}

/** Folders whose XML is never a policy anyone edits. */
const IGNORED = /\/(node_modules|\.git|bin|obj)\//;

/**
 * `p`, or `fallback` when it takes longer than `ms`; `p` carries on either way. Completion uses it
 * so the instance's first read over the network doesn't hold it up.
 */
export function within<T>(p: Promise<T>, fallback: T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
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

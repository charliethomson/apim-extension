import { open } from 'node:fs/promises';
import * as vscode from 'vscode';
import { LANGUAGE_ID, type DocumentCache } from '../documents';
import { looksLikePolicy } from '../parser/detect';
import { fragmentIdsFor } from '../parser/fragmentIds';
import { parse } from '../parser/scanner';
import { knownVariables, summarize, type KnownVariable, type PolicySummary, type RelatedFile } from '../policy/variables';

interface Entry {
  uri: vscode.Uri;
  fragmentIds: string[];
  summary: PolicySummary;
}

/**
 * Every policy file in the workspace with what it declares: fragment ids, includes, variables and
 * named values. Open documents are indexed from their live text.
 */
export class PolicyIndex implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly apiOpsNamedValues = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private scanned?: Promise<void>;

  constructor(private readonly cache: DocumentCache) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.xml');
    this.disposables.push(
      watcher,
      watcher.onDidCreate((u) => this.scanned && !ignored(u) && void this.updateFromDisk(u)),
      watcher.onDidChange((u) => {
        if (!this.scanned || ignored(u) || vscode.workspace.textDocuments.some((d) => d.uri.toString() === u.toString())) return;
        void this.updateFromDisk(u);
      }),
      watcher.onDidDelete((u) => this.entries.delete(u.toString())),
      vscode.workspace.onDidChangeTextDocument((e) => this.updateFromDocument(e.document)),
      vscode.workspace.onDidOpenTextDocument((d) => this.updateFromDocument(d)),
    );
  }

  /**
   * The workspace scan starts the first time a policy needs it, not on activation: the
   * extension activates for every XML file, including .csproj and web.config.
   */
  private get ready(): Promise<void> {
    return (this.scanned ??= this.scan());
  }

  async fragmentFiles(id: string): Promise<vscode.Uri[]> {
    await this.ready;
    return [...this.entries.values()].filter((e) => e.fragmentIds.includes(id)).map((e) => e.uri);
  }

  async fragmentIds(): Promise<string[]> {
    await this.ready;
    return [...new Set([...this.entries.values()].flatMap((e) => e.fragmentIds))].sort();
  }

  async namedValues(): Promise<string[]> {
    await this.ready;
    const all = new Set(this.apiOpsNamedValues);
    for (const e of this.entries.values()) e.summary.namedValues.forEach((n) => all.add(n));
    return [...all].sort();
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
    return knownVariables(self.summary, self.fragmentIds, others).map((v) => ({
      ...v,
      uri: v.originKey ? vscode.Uri.parse(v.originKey) : document.uri,
    }));
  }

  private entryFor(document: vscode.TextDocument): Entry {
    const doc = this.cache.get(document);
    const summary = summarize(doc);
    return { uri: document.uri, fragmentIds: summary.root === 'fragment' ? fragmentIdsFor(document.uri.path) : [], summary };
  }

  private updateFromDocument(document: vscode.TextDocument): void {
    if (document.languageId !== LANGUAGE_ID || document.uri.scheme !== 'file') return;
    this.entries.set(document.uri.toString(), this.entryFor(document));
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
      // Decide from the first 4 KB; only policies are read in full, and only up to a sane size.
      const head = await readHead(uri, 4096);
      if (head === undefined || !looksLikePolicy(head)) {
        this.entries.delete(uri.toString());
        return;
      }
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_POLICY_BYTES) return;
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return;
    }
    const summary = summarize(parse(text));
    this.entries.set(uri.toString(), { uri, fragmentIds: summary.root === 'fragment' ? fragmentIdsFor(uri.path) : [], summary });
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** APIM caps a fragment at 512 KB; a file far bigger than that isn't a policy. */
const MAX_POLICY_BYTES = 2 * 1024 * 1024;

function ignored(uri: vscode.Uri): boolean {
  return /\/(node_modules|\.git|bin|obj)\//.test(uri.path);
}

/** The first `bytes` of a file, without reading the rest when it's on local disk. */
async function readHead(uri: vscode.Uri, bytes: number): Promise<string | undefined> {
  if (uri.scheme === 'file') {
    const handle = await open(uri.fsPath, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buf, 0, bytes, 0);
      return new TextDecoder().decode(buf.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > MAX_POLICY_BYTES) return undefined;
  return new TextDecoder().decode((await vscode.workspace.fs.readFile(uri)).subarray(0, bytes));
}


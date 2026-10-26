import { open } from 'node:fs/promises';
import * as vscode from 'vscode';
import { looksLikePolicy, PROLOG_LIMIT, scanRoot } from '@charliethomson/apim-document';
import { PolicyIndex, type WorkspaceHost } from '@charliethomson/apim-workspace';
import { LANGUAGE_ID, type DocumentCache } from '../documents';

/** The policy index over VS Code's workspace, kept current from its file and document events. */
export function workspaceIndex(cache: DocumentCache): { index: PolicyIndex<vscode.Uri>; disposable: vscode.Disposable } {
  const isPolicy = (d: vscode.TextDocument) => d.languageId === LANGUAGE_ID;
  const host: WorkspaceHost<vscode.Uri> = {
    key: (uri) => uri.toString(),
    parse: (key) => vscode.Uri.parse(key),
    scheme: (uri) => uri.scheme,
    path: (uri) => uri.path,
    file: (path) => vscode.Uri.file(path),
    label: (uri) => vscode.workspace.asRelativePath(uri),
    findPolicyFiles: () => Promise.resolve(vscode.workspace.findFiles('**/*.xml', '**/{node_modules,.git,bin,obj}/**', 10000)),
    findNamedValueFiles: () => Promise.resolve(vscode.workspace.findFiles('**/namedValues/*/namedValueInformation.json', '**/node_modules/**', 5000)),
    readPolicy,
    readText,
    folders,
    openPolicies: () => vscode.workspace.textDocuments.filter(isPolicy).map((d) => ({ uri: d.uri, doc: cache.get(d) })),
    isOpen: (uri) => vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString()),
  };
  const index = new PolicyIndex(host);
  const changed = (d: vscode.TextDocument) => isPolicy(d) && index.documentChanged(d.uri, cache.get(d));
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.xml');
  // Which APIs each product holds, for the broader scopes around a policy in an extract.
  const productApis = vscode.workspace.createFileSystemWatcher('**/products/*/apis.json');
  const disposable = vscode.Disposable.from(
    index,
    watcher,
    productApis,
    ...[watcher, productApis].flatMap((w) => [w.onDidCreate((u) => index.fileCreated(u)), w.onDidChange((u) => index.fileChanged(u)), w.onDidDelete((u) => index.fileDeleted(u))]),
    vscode.workspace.onDidChangeTextDocument((e) => changed(e.document)),
    vscode.workspace.onDidOpenTextDocument(changed),
    vscode.workspace.onDidCloseTextDocument((d) => index.documentClosed(d.uri)),
  );
  return { index, disposable };
}

/** A file's text, or undefined when it doesn't exist. */
async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (e) {
    if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') return undefined;
    throw e;
  }
}

/** The names of the folders in `uri`; empty when it doesn't exist. */
async function folders(uri: vscode.Uri): Promise<string[]> {
  try {
    return (await vscode.workspace.fs.readDirectory(uri)).filter(([, type]) => type & vscode.FileType.Directory).map(([name]) => name);
  } catch {
    return [];
  }
}

/** APIM caps a fragment at 512 KB; a file far bigger than that isn't a policy. */
const MAX_POLICY_BYTES = 2 * 1024 * 1024;

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

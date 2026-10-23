import * as vscode from 'vscode';
import { type Document, parse } from '@apim-policy/document';

export const LANGUAGE_ID = 'apim-policy';

/** Parses each policy document once per version. */
export class DocumentCache implements vscode.Disposable {
  private readonly cache = new Map<string, { version: number; doc: Document }>();
  private readonly origins = new WeakMap<Document, vscode.Uri>();
  private readonly subscription = vscode.workspace.onDidCloseTextDocument((d) => this.cache.delete(d.uri.toString()));

  get(document: vscode.TextDocument): Document {
    const key = document.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === document.version) return hit.doc;
    const doc = parse(document.getText());
    this.cache.set(key, { version: document.version, doc });
    this.origins.set(doc, document.uri);
    return doc;
  }

  /** The document a parse came from, for one this cache made. */
  uriOf(doc: Document): vscode.Uri | undefined {
    return this.origins.get(doc);
  }

  dispose(): void {
    this.subscription.dispose();
    this.cache.clear();
  }
}

export function toRange(document: vscode.TextDocument, r: { start: number; end: number }): vscode.Range {
  return new vscode.Range(document.positionAt(r.start), document.positionAt(r.end));
}

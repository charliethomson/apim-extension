import * as vscode from 'vscode';
import type { Document } from './parser/ast';
import { parse } from './parser/scanner';

export const LANGUAGE_ID = 'apim-policy';

/** Parses each policy document once per version. */
export class DocumentCache implements vscode.Disposable {
  private readonly cache = new Map<string, { version: number; doc: Document }>();
  private readonly subscription = vscode.workspace.onDidCloseTextDocument((d) => this.cache.delete(d.uri.toString()));

  get(document: vscode.TextDocument): Document {
    const key = document.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === document.version) return hit.doc;
    const doc = parse(document.getText());
    this.cache.set(key, { version: document.version, doc });
    return doc;
  }

  dispose(): void {
    this.subscription.dispose();
    this.cache.clear();
  }
}

export function toRange(document: vscode.TextDocument, r: { start: number; end: number }): vscode.Range {
  return new vscode.Range(document.positionAt(r.start), document.positionAt(r.end));
}

import * as vscode from 'vscode';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import { type Catalog, type Severity, validate } from '@apim-policy/catalog';

const SEVERITY: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/** Publishes parser and structural diagnostics for open policy documents. */
export function registerStructuralDiagnostics(cache: DocumentCache, catalog: Catalog): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('apim-policy');
  const timers = new Map<string, NodeJS.Timeout>();

  const refresh = (document: vscode.TextDocument) => {
    if (document.languageId !== LANGUAGE_ID) {
      collection.delete(document.uri);
      return;
    }
    const doc = cache.get(document);
    const out: vscode.Diagnostic[] = [];
    for (const d of doc.diagnostics) {
      out.push(make(document, d.range, d.message, d.code, vscode.DiagnosticSeverity.Error));
    }
    for (const d of validate(doc, catalog)) {
      out.push(make(document, d.range, d.message, d.code, SEVERITY[d.severity]));
    }
    collection.set(document.uri, out);
  };

  const schedule = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      refresh(document);
    }, 150));
  };

  vscode.workspace.textDocuments.forEach(refresh);
  return vscode.Disposable.from(
    collection,
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
    { dispose: () => timers.forEach(clearTimeout) },
  );
}

function make(document: vscode.TextDocument, range: { start: number; end: number }, message: string, code: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
  const d = new vscode.Diagnostic(toRange(document, range), message, severity);
  d.source = 'apim';
  d.code = code;
  return d;
}

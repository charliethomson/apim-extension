import * as vscode from 'vscode';
import type { CSharpEngine } from '../csharp/lang/service';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';

/**
 * C# errors from the built-in engine (syntax, unknown names and members, wrong argument counts)
 * for policies the C# server isn't type-checking: in `builtin` mode, without the C# extension, in
 * Restricted Mode, and in `virtual` mode, where the server only gives completion.
 */
export function registerEngineDiagnostics(
  cache: DocumentCache,
  engine: () => Promise<CSharpEngine | undefined>,
  /** Resolves to true when the C# server is pulling diagnostics itself. */
  serverChecks: () => Promise<boolean>,
  /** Fires when that may have changed (workspace trust granted). */
  refreshAll: vscode.Event<void>,
): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('apim-csharp-builtin');
  const timers = new Map<string, NodeJS.Timeout>();

  const refresh = async (document: vscode.TextDocument) => {
    if (document.languageId !== LANGUAGE_ID || document.isClosed) return;
    const version = document.version;
    const doc = cache.get(document);
    const e = doc.expressions.length > 0 && !(await serverChecks()) ? await engine() : undefined;
    if (document.isClosed || document.version !== version) return;
    if (!e) {
      collection.delete(document.uri);
      return;
    }
    const out: vscode.Diagnostic[] = [];
    for (const expr of doc.expressions) {
      for (const d of e.diagnostics(expr.code, expr.kind)) {
        // Zero-width errors (a missing ';') get the character before them so they're visible.
        const span = d.end > d.start ? d : { start: Math.max(0, d.start - 1), end: Math.max(d.start, 1) };
        const range = expr.map.rangeToSource({ start: Math.min(span.start, expr.code.length), end: Math.min(span.end, expr.code.length) });
        if (!range) continue;
        const diag = new vscode.Diagnostic(toRange(document, range), d.message, vscode.DiagnosticSeverity.Error);
        diag.source = 'apim (C#)';
        out.push(diag);
      }
    }
    collection.set(document.uri, out);
  };

  const schedule = (document: vscode.TextDocument, delay = 300) => {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      void refresh(document);
    }, delay));
  };

  vscode.workspace.textDocuments.forEach((d) => schedule(d, 0));
  return vscode.Disposable.from(
    collection,
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 0)),
    refreshAll(() => vscode.workspace.textDocuments.forEach((d) => schedule(d, 0))),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
    { dispose: () => timers.forEach(clearTimeout) },
  );
}

import * as vscode from 'vscode';
import type { CSharpEngine } from '@apim-policy/csharp-engine';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';

/**
 * What the gateway rejects even though modern C# accepts it: syntax newer than C# 7.3, and .NET
 * types and members that .NET Framework 4.8 doesn't have.
 *
 * Newer syntax is an error. Framework gaps follow `apimPolicy.allowedTypes.severity` when it's
 * set, since they're the same kind of finding as the allowlist's. Unset, they're warnings rather
 * than the setting's default of error: a gateway on a newer runtime may accept them.
 */
export function registerCompatibility(
  cache: DocumentCache,
  engine: () => Promise<CSharpEngine | undefined>,
): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('apim-compatibility');
  const timers = new Map<string, NodeJS.Timeout>();

  const frameworkSeverity = (): vscode.DiagnosticSeverity | undefined => {
    const set = vscode.workspace.getConfiguration('apimPolicy').inspect<string>('allowedTypes.severity');
    const s = set?.workspaceFolderValue ?? set?.workspaceValue ?? set?.globalValue ?? 'warning';
    return s === 'off' ? undefined : s === 'error' ? vscode.DiagnosticSeverity.Error : s === 'information' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning;
  };

  const refresh = async (document: vscode.TextDocument) => {
    if (document.languageId !== LANGUAGE_ID || document.isClosed) return;
    const version = document.version;
    const doc = cache.get(document);
    const e = doc.expressions.length > 0 ? await engine() : undefined;
    if (document.isClosed || document.version !== version) return;
    if (!e) {
      collection.delete(document.uri);
      return;
    }
    const framework = frameworkSeverity();
    const out: vscode.Diagnostic[] = [];
    for (const expr of doc.expressions) {
      for (const d of e.compatibility(expr.code, expr.kind)) {
        const severity = d.code === 'framework' ? framework : vscode.DiagnosticSeverity.Error;
        if (severity === undefined) continue;
        const range = expr.map.rangeToSource({ start: d.start, end: Math.max(d.end, d.start + 1) });
        if (!range) continue;
        const diag = new vscode.Diagnostic(toRange(document, range), d.message, severity);
        diag.source = 'apim';
        diag.code = d.code;
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
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('apimPolicy.allowedTypes')) vscode.workspace.textDocuments.forEach((d) => schedule(d, 0));
    }),
    { dispose: () => timers.forEach(clearTimeout) },
  );
}

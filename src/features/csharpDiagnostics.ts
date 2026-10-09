import * as vscode from 'vscode';
import type { ShadowBackend } from '../csharp/backend';
import { isRestorePending, mapDiagnostics } from '../csharp/mapping';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import { log } from '../log';

/**
 * Pulls C# diagnostics for each open policy's shadow and publishes them on the policy. While the
 * shadow's packages are still restoring, Newtonsoft "type not found" errors are held back and the
 * pull is retried.
 */
export function registerCSharpDiagnostics(
  cache: DocumentCache,
  /** Fires when the backend may have become available (workspace trust granted). */
  refreshAll: vscode.Event<void>,
  backend: () => Promise<ShadowBackend | undefined>,
): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('apim-csharp');
  const timers = new Map<string, NodeJS.Timeout>();
  const tokens = new Map<string, vscode.CancellationTokenSource>();
  /** When each document's shadow was first analysed: the server may still be loading it. */
  const firstPull = new Map<string, number>();

  const refresh = async (document: vscode.TextDocument, attempt = 0) => {
    const key = document.uri.toString();
    if (document.languageId !== LANGUAGE_ID || document.isClosed) return;
    const doc = cache.get(document);
    if (doc.expressions.length === 0) {
      collection.delete(document.uri);
      return;
    }
    const b = await backend();
    if (!b?.canPullDiagnostics) return;
    tokens.get(key)?.cancel();
    const cts = new vscode.CancellationTokenSource();
    tokens.set(key, cts);
    const version = document.version;
    try {
      const synced = await b.sync(document, doc);
      if (!synced || cts.token.isCancellationRequested) return;
      const raw = await b.diagnostics(synced, cts.token);
      log().debug(`C# pull for ${document.uri.path}: ${raw ? raw.map((d) => d.code).join(', ') || 'none' : 'no result'}`);
      if (!raw || cts.token.isCancellationRequested || document.version !== version) return;
      const mapped = mapDiagnostics(synced.shadow, synced.index, raw);
      const pending = mapped.filter(isRestorePending);
      const shown = mapped.filter((d) => !isRestorePending(d));
      collection.set(
        document.uri,
        shown.map((d) => {
          const diag = new vscode.Diagnostic(toRange(document, d.range), d.message, d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
          diag.source = 'apim (C#)';
          diag.code = d.code;
          return diag;
        }),
      );
      // The first pulls can come before the server has loaded the shadow as a project, when it
      // only reports syntax errors (and Newtonsoft is unresolved). Keep re-pulling for a while.
      const since = Date.now() - (firstPull.get(key) ?? (firstPull.set(key, Date.now()), Date.now()));
      if ((pending.length > 0 && attempt < 20) || since < 30000) schedule(document, Math.min(1000 * 2 ** attempt, 8000), attempt + 1);
    } catch (e) {
      // The server can reject a pull while it's loading; the next change retries.
      log().warn(`C# pull failed for ${document.uri.path}: ${(e as Error).message}`);
    }
  };

  const schedule = (document: vscode.TextDocument, delay = 400, attempt = 0) => {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      void refresh(document, attempt);
    }, delay));
  };

  vscode.workspace.textDocuments.forEach((d) => schedule(d, 0));
  return vscode.Disposable.from(
    collection,
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 0)),
    refreshAll(() => vscode.workspace.textDocuments.forEach((d) => schedule(d, 0))),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => {
      collection.delete(d.uri);
      tokens.get(d.uri.toString())?.cancel();
      firstPull.delete(d.uri.toString());
      if (d.languageId === LANGUAGE_ID) void backend().then((b) => b?.forget(d));
    }),
    { dispose: () => timers.forEach(clearTimeout) },
  );
}

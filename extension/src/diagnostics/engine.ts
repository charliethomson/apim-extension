import * as vscode from 'vscode';
import type { CSharpEngine } from '@apim-policy/csharp-engine';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import { resultTypes } from '@apim-policy/analysis';
import type { Catalog } from '@apim-policy/catalog';
import type { ShapeService } from '../workspace/shapes';

/**
 * C# errors from the built-in engine: syntax, unknown names and members, argument counts and
 * types, failed conversions and missing returns. Expressions in bool attributes (`condition`)
 * must produce a bool, and a `set-variable` value one of the types a variable may hold. Newer-than-7.3 syntax and .NET Framework gaps are left to the
 * compatibility check.
 */
export function registerEngineDiagnostics(cache: DocumentCache, catalog: Catalog, engine: () => Promise<CSharpEngine | undefined>, shapes: ShapeService): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('apim-csharp');
  const timers = new Map<string, NodeJS.Timeout>();

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
    const out: vscode.Diagnostic[] = [];
    const types = resultTypes(doc, catalog);
    // A set-variable building a variable with a declared JSON shape is checked against it.
    const wanted = await shapes.wanted(doc);
    if (document.isClosed || document.version !== version) return;
    for (const expr of doc.expressions) {
      const expected = types.get(expr);
      for (const d of e.diagnostics(expr.code, expr.kind, expected, undefined, wanted.get(expr))) {
        if (d.code === 'language-version') continue;
        // Zero-width errors (a missing ';') get the character before them so they're visible.
        const span = d.end > d.start ? d : { start: Math.max(0, d.start - 1), end: Math.max(d.start, 1) };
        const range = expr.map.rangeToSource({ start: Math.min(span.start, expr.code.length), end: Math.min(span.end, expr.code.length) });
        if (!range) continue;
        // JSON built unlike its declared shape still compiles: a warning, not an error.
        const diag = new vscode.Diagnostic(toRange(document, range), d.message, d.code === 'json-shape' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
        diag.source = 'apim (C#)';
        if (d.code === 'json-shape') diag.code = 'json-shape';
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
    { dispose: () => timers.forEach(clearTimeout) },
  );
}

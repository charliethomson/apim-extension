import * as vscode from 'vscode';
import { type Allowlist, type CSharpEngine, lintAllowedTypes, type LintFinding, lintReferences } from '@apim-policy/csharp-engine';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import type { OffsetRange } from '@apim-policy/core';

interface Finding {
  range: OffsetRange;
  message: string;
  code: 'disallowed-type' | 'disallowed-member';
}

/**
 * Flags types and members outside APIM's allowlist. The syntactic pass runs on every change;
 * a semantic pass then catches what the syntax can't (instance members on restricted types,
 * aliases) from what the built-in engine bound.
 */
export function registerAllowlistLint(cache: DocumentCache, allow: Allowlist, engine: () => Promise<CSharpEngine | undefined>): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('apim-allowlist');
  const timers = new Map<string, NodeJS.Timeout>();
  // The syntactic pass depends only on the code, and an edit changes one expression, so the
  // rest come from here. Least recently used is dropped first.
  const lintCache = new Map<string, LintFinding[]>();
  const lint = (code: string): LintFinding[] => {
    let hit = lintCache.get(code);
    if (hit) lintCache.delete(code);
    else {
      hit = lintAllowedTypes(code, allow);
      if (lintCache.size >= 2000) lintCache.delete(lintCache.keys().next().value!);
    }
    lintCache.set(code, hit);
    return hit;
  };

  const severity = (): vscode.DiagnosticSeverity | undefined => {
    const s = vscode.workspace.getConfiguration('apimPolicy').get<string>('allowedTypes.severity', 'error');
    return s === 'off' ? undefined : s === 'error' ? vscode.DiagnosticSeverity.Error : s === 'information' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning;
  };

  const publish = (document: vscode.TextDocument, findings: Finding[]) => {
    const sev = severity();
    if (sev === undefined) {
      collection.delete(document.uri);
      return;
    }
    // Earlier findings win; the semantic pass often re-finds a syntactic one with a narrower range.
    const kept: Finding[] = [];
    for (const f of findings) {
      if (!kept.some((k) => f.range.start < k.range.end && k.range.start < f.range.end)) kept.push(f);
    }
    collection.set(
      document.uri,
      kept.map((f) => {
        const d = new vscode.Diagnostic(toRange(document, f.range), f.message, sev);
        d.source = 'apim';
        d.code = f.code;
        return d;
      }),
    );
  };

  const refresh = async (document: vscode.TextDocument) => {
    if (document.languageId !== LANGUAGE_ID || document.isClosed) return;
    const version = document.version;
    const doc = cache.get(document);
    const syntactic: Finding[] = [];
    for (const e of doc.expressions) {
      for (const f of lint(e.code)) {
        const range = e.map.rangeToSource(f.range);
        if (range) syntactic.push({ range, message: f.message, code: f.kind === 'type' ? 'disallowed-type' : 'disallowed-member' });
      }
    }
    publish(document, syntactic);

    const e = doc.expressions.length > 0 ? await engine() : undefined;
    if (!e || document.isClosed || document.version !== version) return;
    const semantic: Finding[] = [];
    for (const expr of doc.expressions) {
      for (const f of lintReferences(e.references(expr.code, expr.kind), allow)) {
        const range = expr.map.rangeToSource(f.range);
        if (range) semantic.push({ range, message: f.message, code: f.kind === 'type' ? 'disallowed-type' : 'disallowed-member' });
      }
    }
    publish(document, [...syntactic, ...semantic]);
  };

  const schedule = (document: vscode.TextDocument, delay = 500) => {
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

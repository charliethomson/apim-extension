import * as vscode from 'vscode';
import type { Allowlist } from '../csharp/allowedTypes';
import { lintAllowedTypes } from '../csharp/allowedTypes';
import type { ShadowBackend, SyncedShadow } from '../csharp/backend';
import { methodAt } from '../csharp/shadow';
import { decodeSemanticTokens, MEMBER_TOKENS, parseHoverSymbol, TYPE_TOKENS } from '../csharp/semanticLint';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import { log } from '../log';
import type { OffsetRange } from '../sourceMap';

interface Finding {
  range: OffsetRange;
  message: string;
  code: 'disallowed-type' | 'disallowed-member';
}

/**
 * Flags types and members outside APIM's allowlist. The syntactic pass runs on every change;
 * when the C# extension is available, a semantic pass then asks the server about type tokens
 * and suspicious member names, which catches what the syntax can't (instance members on
 * restricted types, aliases).
 */
export function registerAllowlistLint(cache: DocumentCache, allow: Allowlist, backend: () => Promise<ShadowBackend | undefined>): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('apim-allowlist');
  const timers = new Map<string, NodeJS.Timeout>();
  const suspicious = allow.suspiciousMembers();

  const severity = (): vscode.DiagnosticSeverity | undefined => {
    const s = vscode.workspace.getConfiguration('apimPolicy').get<string>('allowedTypes.severity', 'warning');
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
      for (const f of lintAllowedTypes(e.code, allow)) {
        const range = e.map.rangeToSource(f.range);
        if (range) syntactic.push({ range, message: f.message, code: f.kind === 'type' ? 'disallowed-type' : 'disallowed-member' });
      }
    }
    publish(document, syntactic);

    const b = doc.expressions.length > 0 ? await backend() : undefined;
    if (!b) return;
    try {
      const synced = await b.sync(document, doc);
      if (!synced || document.version !== version) return;
      const semantic = await semanticFindings(synced, allow, suspicious);
      if (document.version !== version) return;
      publish(document, [...syntactic, ...semantic]);
    } catch (e) {
      log().warn(`allowlist semantic pass failed: ${(e as Error).message}`);
    }
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

/** At most this many hover requests per pass, to bound the cost on huge policies. */
const HOVER_BUDGET = 300;

async function semanticFindings(synced: SyncedShadow, allow: Allowlist, suspicious: Set<string>): Promise<Finding[]> {
  const uri = synced.csDoc.uri;
  const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', uri);
  const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', uri);
  if (!legend || !tokens) return [];
  const out: Finding[] = [];
  const hoverCache = new Map<string, string>();
  let budget = HOVER_BUDGET;
  for (const t of decodeSemanticTokens(tokens.data, legend.tokenTypes)) {
    const start = synced.index.offsetAt({ line: t.line, character: t.character });
    if (!methodAt(synced.shadow, start)) continue;
    const name = synced.shadow.text.slice(start, start + t.length);
    const isType = TYPE_TOKENS.has(t.type);
    if (!isType && !(MEMBER_TOKENS.has(t.type) && suspicious.has(name))) continue;
    if (budget-- <= 0) break;
    const hover = await hoverText(uri, synced.csDoc.positionAt(start), hoverCache, `${t.type}:${name}:${isType ? '' : start}`);
    const sym = parseHoverSymbol(hover);
    const range = synced.shadow.map.rangeToSource({ start, end: start + t.length });
    if (!sym || !range) continue;
    if (sym.kind === 'type' && sym.fullName.includes('.') && !allow.isFullNameAllowed(sym.fullName)) {
      out.push({ range, code: 'disallowed-type', message: `'${sym.fullName}' isn't on the APIM policy expression allowlist.` });
    } else if (sym.kind === 'member') {
      const type = allow.restrictedByShortName(sym.typeName.split('.').pop()!);
      const allowed = type && allow.memberProblem(type, sym.member);
      if (allowed) {
        const list = allowed.filter((m) => m !== '(Constructor)');
        out.push({ range, code: 'disallowed-member', message: `APIM doesn't allow '${sym.typeName}.${sym.member}'.${list.length ? ` Allowed: ${list.slice(0, 8).join(', ')}${list.length > 8 ? ', …' : ''}.` : ''}` });
      }
    }
  }
  return out;
}

async function hoverText(uri: vscode.Uri, pos: vscode.Position, cache: Map<string, string>, key: string): Promise<string> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, pos);
  const text = (hovers ?? []).flatMap((h) => h.contents).map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : '')).join('\n');
  cache.set(key, text);
  return text;
}

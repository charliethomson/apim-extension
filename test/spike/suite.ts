// Spike: can we get C# language features for policy expressions by forwarding requests to
// the C# extension? Runs inside VS Code (see run.ts) and probes each variant:
//   A  virtual document (custom scheme), stubs inlined
//   B  .cs file on disk outside the workspace, as a .NET 10 file-based app, opened hidden
//   B2 same as B, but shown in an editor
// Writes out/spike/results.json.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { generateShadow, type Shadow } from '../../src/csharp/shadow';
import { parse } from '../../src/parser/scanner';

const root = process.env.APIM_SPIKE_ROOT!;
const log: string[] = [];
const say = (s: string) => {
  log.push(s);
  console.log(`[spike] ${s}`);
};

const POLICY = `<policies><inbound>
<set-variable name="a" value="@(context.Request.Headers.GetValueOrDefault(&quot;X&quot;, &quot;&quot;))" />
<set-variable name="b" value="@(context.Request.Body.As<JObject>(true)[&quot;x&quot;])" />
<set-variable name="c" value="@(context.Request.Nope)" />
<set-variable name="d" value="@(context.Request.)" />
<set-variable name="e" value="@(context.)" />
<set-variable name="f" value="@(System.IO.File.ReadAllText(&quot;x&quot;))" />
</inbound></policies>`;

interface Probe {
  ok: boolean;
  ms: number;
  detail: string;
}

type Results = Record<string, Record<string, Probe | string>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function positionAfter(doc: vscode.TextDocument, shadow: Shadow, needle: string, delta = needle.length): vscode.Position {
  const i = shadow.text.indexOf(needle);
  if (i < 0) throw new Error(`needle not found: ${needle}`);
  return doc.positionAt(i + delta);
}

async function timed<T>(fn: () => Thenable<T> | Promise<T>): Promise<{ v: T; ms: number }> {
  const t = Date.now();
  const v = await fn();
  return { v, ms: Date.now() - t };
}

/** Retries until the predicate holds or the timeout passes (project load can be slow). */
async function until<T>(label: string, fn: () => Thenable<T> | Promise<T>, ok: (v: T) => boolean, timeoutMs: number): Promise<{ v: T; ms: number }> {
  const t = Date.now();
  let v: T = await fn();
  while (!ok(v) && Date.now() - t < timeoutMs) {
    await sleep(1000);
    v = await fn();
  }
  say(`${label}: ${ok(v) ? 'ok' : 'gave up'} after ${Date.now() - t}ms`);
  return { v, ms: Date.now() - t };
}

async function probe(variant: string, doc: vscode.TextDocument, shadow: Shadow, results: Results, warmupMs: number): Promise<void> {
  const r: Record<string, Probe | string> = (results[variant] = {});
  r.uri = doc.uri.toString();
  r.languageId = doc.languageId;

  // Completion after `context.Request.` (retry until the server has loaded the document).
  const reqPos = positionAfter(doc, shadow, 'context.Request.;', 'context.Request.'.length);
  const comp = await until(
    `${variant} completion`,
    () => vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, reqPos, '.'),
    (l) => !!l?.items.some((i) => label(i) === 'Headers'),
    warmupMs,
  );
  const names = comp.v?.items.map(label) ?? [];
  r.completionRequest = {
    ok: names.includes('Headers') && names.includes('Body'),
    ms: comp.ms,
    detail: `${names.length} items; sample: ${names.filter((n) => /^[A-Z]/.test(n)).slice(0, 12).join(', ')}`,
  };

  const ctxPos = positionAfter(doc, shadow, 'context.;', 'context.'.length);
  const comp2 = await timed(() => vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, ctxPos, '.'));
  const names2 = comp2.v?.items.map(label) ?? [];
  r.completionContext = { ok: names2.includes('Request') && names2.includes('Variables'), ms: comp2.ms, detail: names2.filter((n) => /^[A-Z]/.test(n)).slice(0, 20).join(', ') };

  const hoverPos = positionAfter(doc, shadow, 'Headers.GetValueOrDefault', 2);
  const hover = await timed(() => vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, hoverPos));
  const hoverText = hoverToText(hover.v);
  r.hoverHeaders = { ok: /Headers/.test(hoverText) && /header/i.test(hoverText.replace(/Headers/g, '')), ms: hover.ms, detail: hoverText.slice(0, 300) };

  const jPos = positionAfter(doc, shadow, 'JObject>', 2);
  const hoverJ = await timed(() => vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, jPos));
  const jText = hoverToText(hoverJ.v);
  r.hoverJObject = { ok: /Newtonsoft|JObject/.test(jText), ms: hoverJ.ms, detail: jText.slice(0, 300) };

  const sigPos = positionAfter(doc, shadow, 'GetValueOrDefault("X"', 'GetValueOrDefault('.length);
  const sig = await timed(() => vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, sigPos, '('));
  r.signatureHelp = {
    ok: (sig.v?.signatures.length ?? 0) > 0,
    ms: sig.ms,
    detail: (sig.v?.signatures ?? []).map((s) => s.label).join(' | ').slice(0, 400),
  };

  const defPos = positionAfter(doc, shadow, 'Request.Headers.GetValueOrDefault', 2);
  const def = await timed(() =>
    vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, defPos),
  );
  const locs = (def.v ?? []).map((l) => ('targetUri' in l ? `${l.targetUri.toString()}#${l.targetRange.start.line}` : `${l.uri.toString()}#${l.range.start.line}`));
  r.definitionRequest = { ok: locs.length > 0, ms: def.ms, detail: locs.join(' ') };

  // Diagnostics as VS Code sees them (push, or pull for visible documents).
  const diags = await until(
    `${variant} diagnostics`,
    async () => vscode.languages.getDiagnostics(doc.uri),
    (d) => d.some((x) => String(typeof x.code === 'object' ? x.code.value : x.code) === 'CS1061'),
    Math.min(warmupMs, 30000),
  );
  r.diagnostics = {
    ok: diags.v.some((x) => String(typeof x.code === 'object' ? x.code.value : x.code) === 'CS1061'),
    ms: diags.ms,
    detail: diags.v.map((d) => `${typeof d.code === 'object' ? d.code.value : d.code}@${d.range.start.line}: ${d.message}`).slice(0, 15).join(' || '),
  };
}

function label(i: vscode.CompletionItem): string {
  return typeof i.label === 'string' ? i.label : i.label.label;
}

function hoverToText(h: vscode.Hover[] | undefined): string {
  return (h ?? [])
    .flatMap((x) => x.contents)
    .map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))
    .join('\n');
}

/** Pulls diagnostics straight from the server via the C# extension's export, if it has one. */
async function pullDiagnostics(api: any, uri: vscode.Uri): Promise<string> {
  const send = api?.experimental?.sendServerRequest;
  if (typeof send !== 'function') return 'no experimental.sendServerRequest export';
  try {
    const res = await send({ method: 'textDocument/diagnostic' }, { textDocument: { uri: uri.toString() } }, new vscode.CancellationTokenSource().token);
    const items: any[] = res?.items ?? [];
    return `kind=${res?.kind} items=${items.length}: ${items.map((d) => `${d.code}@${d.range?.start?.line}`).slice(0, 15).join(', ')}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

export async function run(): Promise<void> {
  const results: Results = {};
  const variants = (process.env.APIM_SPIKE_VARIANTS || 'A,B,B2').split(',');
  const stubs = readFileSync(join(root, 'stubs', 'ApimContext.cs'), 'utf8');
  const doc = parse(POLICY);

  const ext = vscode.extensions.getExtension('ms-dotnettools.csharp');
  if (!ext) throw new Error('C# extension not installed');
  const t0 = Date.now();
  const api: any = await ext.activate();
  say(`C# extension ${ext.packageJSON.version} activated in ${Date.now() - t0}ms; exports: ${Object.keys(api ?? {}).join(', ')}`);
  if (api?.experimental) say(`experimental exports: ${Object.keys(api.experimental).join(', ')}`);
  if (typeof api?.initializationFinished === 'function') {
    const t = Date.now();
    const done = await Promise.race([api.initializationFinished().then(() => true), sleep(20000).then(() => false)]);
    say(`initializationFinished ${done ? 'resolved' : 'still pending'} after ${Date.now() - t}ms`);
  }
  results.env = { csharp: ext.packageJSON.version, vscode: vscode.version, exports: Object.keys(api ?? {}).join(', ') };

  if (variants.includes('A')) {
    const shadow = generateShadow(doc, undefined, { footer: stubs, sourceName: 'spike.policy.xml' });
    const provider = new (class implements vscode.TextDocumentContentProvider {
      provideTextDocumentContent(): string {
        return shadow.text;
      }
    })();
    vscode.workspace.registerTextDocumentContentProvider('apim-cs', provider);
    const uri = vscode.Uri.parse('apim-cs:/shadow/spike.policy.cs');
    let vdoc = await vscode.workspace.openTextDocument(uri);
    if (vdoc.languageId !== 'csharp') vdoc = await vscode.languages.setTextDocumentLanguage(vdoc, 'csharp');
    await probe('A', vdoc, shadow, results, 60000);
    (results.A as any).pull = await pullDiagnostics(api, vdoc.uri);
  }

  if (variants.includes('B') || variants.includes('B2')) {
    const dir = join(tmpdir(), `apim-spike-shadow-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const shadow = generateShadow(doc, undefined, {
      header: '#:package Newtonsoft.Json@13.0.3\n#:property LangVersion=7.3\n#:property Nullable=disable',
      prelude: 'return;',
      footer: stubs,
      sourceName: 'spike.policy.xml',
    });
    if (variants.includes('B')) {
      const file = join(dir, 'spike.cs');
      writeFileSync(file, shadow.text);
      const fdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await probe('B', fdoc, shadow, results, 180000);
      (results.B as any).pull = await pullDiagnostics(api, fdoc.uri);
    }
    if (variants.includes('B2')) {
      const file = join(dir, 'spike2.cs');
      writeFileSync(file, shadow.text);
      const fdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(fdoc, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside });
      await probe('B2', fdoc, shadow, results, 180000);
      (results.B2 as any).pull = await pullDiagnostics(api, fdoc.uri);
    }
  }

  if (variants.includes('B4')) {
    // Round 1's B shape (top-level statement makes it a file-based app) minus LangVersion=7.3,
    // which rejects the top-level statement. Edits go through the in-memory document.
    const dir = join(tmpdir(), `apim-spike-shadow4-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const stubsNoUsings = stubs.replace(/^using [^;]+;\r?\n/gm, '');
    const make = (policy: string) =>
      generateShadow(parse(policy), undefined, {
        header: '#:package Newtonsoft.Json@13.0.3\n#:property Nullable=disable',
        prelude: 'return;',
        footer: stubsNoUsings,
        sourceName: 'spike.policy.xml',
      });
    const shadow = make(POLICY);
    const file = join(dir, 'spike4.cs');
    writeFileSync(file, shadow.text);
    const t0 = Date.now();
    const fdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const r: any = (results.B4 = { nugetPackages: process.env.NUGET_PACKAGES ?? '(default)' });
    const jPos = positionAfter(fdoc, shadow, 'JObject>', 2);
    const j = await until('B4 JObject hover', () => vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', fdoc.uri, jPos), (h) => /Newtonsoft|JObject/.test(hoverToText(h)), 180000);
    r.hoverJObjectFromOpen = { ok: /Newtonsoft|JObject/.test(hoverToText(j.v)), ms: Date.now() - t0, detail: hoverToText(j.v).slice(0, 200) };
    const p0 = Date.now();
    r.pull = { ok: true, ms: 0, detail: await pullDiagnostics(api, fdoc.uri) };
    (r.pull as Probe).ms = Date.now() - p0;
    const edited = make(POLICY.replace('context.Request.Nope', 'context.Request.Method.Length'));
    const we = new vscode.WorkspaceEdit();
    we.replace(fdoc.uri, new vscode.Range(fdoc.positionAt(0), fdoc.positionAt(fdoc.getText().length)), edited.text);
    const t2 = Date.now();
    await vscode.workspace.applyEdit(we);
    let after = '';
    while (Date.now() - t2 < 30000) {
      after = await pullDiagnostics(api, fdoc.uri);
      if (!after.includes('CS1061')) break;
      await sleep(50);
    }
    r.inMemoryEditLatency = { ok: !after.includes('CS1061'), ms: Date.now() - t2, detail: after };
    const c = await timed(() => vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', fdoc.uri, positionAfter(fdoc, edited, 'context.Request.;', 'context.Request.'.length), '.'));
    r.completionAfterEdit = { ok: !!c.v?.items.some((i) => label(i) === 'Headers'), ms: c.ms, detail: '' };
  }

  if (variants.includes('B3')) {
    // File-based app without top-level statements: shebang + Library output, stubs' usings stripped.
    const dir = join(tmpdir(), `apim-spike-shadow3-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const stubsNoUsings = stubs.replace(/^using [^;]+;\r?\n/gm, '');
    const make = (policy: string) =>
      generateShadow(parse(policy), undefined, {
        header: '#!/usr/bin/env dotnet\n#:package Newtonsoft.Json@13.0.3\n#:property LangVersion=7.3\n#:property OutputType=Library\n#:property Nullable=disable',
        footer: stubsNoUsings,
        sourceName: 'spike.policy.xml',
      });
    const shadow = make(POLICY);
    const file = join(dir, 'spike3.cs');
    writeFileSync(file, shadow.text);
    const fdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await probe('B3', fdoc, shadow, results, 180000);
    const r = results.B3 as any;
    const jPos = positionAfter(fdoc, shadow, 'JObject>', 2);
    const j = await until('B3 JObject hover', () => vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', fdoc.uri, jPos), (h) => /Newtonsoft|JObject/.test(hoverToText(h)), 180000);
    r.hoverJObjectEventually = { ok: /Newtonsoft|JObject/.test(hoverToText(j.v)), ms: j.ms, detail: hoverToText(j.v).slice(0, 200) };
    r.pull = await pullDiagnostics(api, fdoc.uri);

    // Edit: rewrite the file on disk and time until the pulled diagnostics reflect it.
    const edited = make(POLICY.replace('context.Request.Nope', 'context.Request.Url.Nope2 + 1'));
    const t = Date.now();
    writeFileSync(file, edited.text);
    let after = '';
    while (Date.now() - t < 30000) {
      after = await pullDiagnostics(api, fdoc.uri);
      if (fdoc.getText() === edited.text && after.includes('CS1061')) break;
      await sleep(100);
    }
    r.editLatency = { ok: fdoc.getText() === edited.text, ms: Date.now() - t, detail: after };

    // Same, but editing the in-memory document instead of the file.
    const edited2 = make(POLICY.replace('context.Request.Nope', 'context.Request.Method.Length'));
    const we = new vscode.WorkspaceEdit();
    we.replace(fdoc.uri, new vscode.Range(fdoc.positionAt(0), fdoc.positionAt(fdoc.getText().length)), edited2.text);
    const t2 = Date.now();
    await vscode.workspace.applyEdit(we);
    let after2 = '';
    while (Date.now() - t2 < 30000) {
      after2 = await pullDiagnostics(api, fdoc.uri);
      if (!after2.includes('CS1061')) break;
      await sleep(100);
    }
    r.inMemoryEditLatency = { ok: !after2.includes('CS1061'), ms: Date.now() - t2, detail: after2 };
  }

  results.log = { lines: log.join('\n') };
  const out = join(root, 'out', 'spike');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
  say(`wrote ${join(out, 'results.json')}`);
}

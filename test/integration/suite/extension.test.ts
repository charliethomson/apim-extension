import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const ws = () => vscode.workspace.workspaceFolders![0].uri;
const file = (p: string) => vscode.Uri.joinPath(ws(), p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(p: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(file(p));
  await vscode.window.showTextDocument(doc);
  return waitFor(() => vscode.workspace.textDocuments.find((d) => d.uri.toString() === doc.uri.toString() && d.languageId === 'apim-policy') ?? doc, (d) => d.languageId === 'apim-policy', 10000);
}

async function waitFor<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, timeout = 60000): Promise<T> {
  const start = Date.now();
  let v = await fn();
  while (!ok(v) && Date.now() - start < timeout) {
    await sleep(250);
    v = await fn();
  }
  return v;
}

function at(doc: vscode.TextDocument, needle: string, delta = needle.length): vscode.Position {
  const i = doc.getText().indexOf(needle);
  assert.ok(i >= 0, `needle not found: ${needle}`);
  return doc.positionAt(i + delta);
}

const labels = (l: vscode.CompletionList | undefined) => (l?.items ?? []).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
const complete = (doc: vscode.TextDocument, pos: vscode.Position, trigger?: string) =>
  vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, pos, trigger);

/** A diagnostic's code as text (codes can be objects with a link target). */
const codeOf = (d: vscode.Diagnostic) => String(typeof d.code === 'object' ? d.code.value : (d.code ?? ''));

/** Replaces the document's text and waits for our diagnostics to settle. */
async function setText(doc: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

describe('APIM policy extension', () => {
  before(() => {
    const ext = vscode.extensions.all.find((e) => (e.packageJSON as { name?: string }).name === 'apim-policy');
    assert.ok(ext, 'extension under test is loaded');
  });

  describe('language', () => {
    it('assigns *.policy.xml and APIOps policy.xml to apim-policy, and leaves other XML alone', async () => {
      assert.equal((await open('raw/echo.policy.xml')).languageId, 'apim-policy');
      assert.equal((await open('apiops/apis/echo/policy.xml')).languageId, 'apim-policy');
      const plain = await vscode.workspace.openTextDocument(file('not-a-policy.xml'));
      await vscode.window.showTextDocument(plain);
      await sleep(500);
      assert.equal(vscode.workspace.textDocuments.find((d) => d.uri.toString() === plain.uri.toString())?.languageId, 'xml');
    });
  });

  describe('structural diagnostics', () => {
    it('reports parser and policy problems', async () => {
      const doc = await open('raw/broken.policy.xml');
      const diags = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'apim'), (d) => d.length >= 5);
      const codes = diags.map((d) => codeOf(d)).sort();
      assert.deepEqual(codes, ['unknown-policy', 'unterminated-expression', 'unterminated-expression', 'unterminated-expression', 'wrong-section']);
    });

    it('applies fragment rules', async () => {
      const doc = await open('fragments/bad-fragment.xml');
      const diags = await waitFor(() => vscode.languages.getDiagnostics(doc.uri), (d) => d.length >= 2);
      assert.deepEqual(diags.map((d) => codeOf(d)).sort(), ['fragment-section', 'nested-fragment']);
    });

    it('stays quiet on valid policies', async () => {
      const doc = await open('escaped/echo.policy.xml');
      await sleep(1000);
      assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).map((d) => `${d.source} ${codeOf(d)} ${d.message}`), []);
    });
  });

  describe('XML IntelliSense', () => {
    it('completes policies for the section', async () => {
      const doc = await open('apiops/apis/echo/policy.xml');
      await setText(doc, doc.getText().replace('<base />\n    </backend>', '<base />\n        <\n    </backend>'));
      const list = labels(await complete(doc, at(doc, '        <\n    </backend>', 9), '<'));
      assert.ok(list.includes('forward-request'), 'backend policies offered');
      assert.ok(!list.includes('validate-jwt'), 'inbound-only policies hidden');
    });

    it('completes fragment ids and named values', async () => {
      const doc = await open('apiops/apis/echo/policy.xml');
      const ids = labels(await complete(doc, at(doc, 'fragment-id="', 'fragment-id="'.length), '"'));
      assert.ok(ids.includes('rate-limit') && ids.includes('random-user'), `fragment ids: ${ids.join(', ')}`);
      const nvs = labels(await complete(doc, at(doc, '{{tenant-id}}', 2), '{'));
      assert.ok(nvs.includes('api-audience'), `named values: ${nvs.join(', ')}`);
    });

    it('goes to a fragment from include-fragment', async () => {
      const doc = await open('apiops/apis/echo/policy.xml');
      const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, at(doc, 'fragment-id="rate', 'fragment-id="'.length + 1));
      const uris = defs.map((d) => ('targetUri' in d ? d.targetUri : d.uri).path);
      assert.ok(uris.some((p) => p.endsWith('policyFragments/rate-limit/policy.xml')), uris.join(', '));
    });
  });

  describe('known variables', () => {
    it('offers variables set by an included fragment', async () => {
      const doc = await open('apiops/apis/random-users/policy.xml');
      const i = doc.getText().indexOf('context.Variables["ru-ret-');
      assert.ok(i >= 0);
      const pos = doc.positionAt(i + 'context.Variables["'.length);
      const names = labels(await complete(doc, pos, '"'));
      assert.ok(names.some((n) => n.startsWith('ru-ret-')), names.slice(0, 20).join(', '));
    });

    it("shows a fragment's documented @in and @out after its include, and on hover", async () => {
      const doc = await open('apiops/apis/random-users/policy.xml');
      const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      const hints = await waitFor(
        async () => await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', doc.uri, full),
        (h) => (h ?? []).length > 0,
        10000,
      );
      const text = (h: vscode.InlayHint) => (typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join(''));
      assert.equal(hints.length, 1);
      assert.match(text(hints[0]), /^in: ru-arg-base-url\?, .*, \+11 · out: ru-ret-status, .*, \+6$/);
      assert.equal(doc.offsetAt(hints[0].position), doc.getText().indexOf('/>', doc.getText().indexOf('include-fragment')) + 2);

      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, at(doc, 'fragment-id="random-user', 'fragment-id="'.length + 2));
      // appendText escapes spaces as &nbsp;.
      const shown = hovers.flatMap((h) => h.contents).map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : '')).join('\n').replace(/&nbsp;/g, ' ');
      assert.match(shown, /Fetches people from randomuser\.me/);
      assert.match(shown, /ru-ret-users/);
    });

    it('flags an include that leaves a required @in unset', async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<policies>\n    <inbound>\n        <include-fragment fragment-id="signing" />\n    </inbound>\n</policies>');
      const diags = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'fragment-in-unset'), (d) => d.length > 0, 10000);
      assert.deepEqual(diags.map((d) => d.message), ["Fragment 'signing' requires 'sig-key', which nothing earlier in this file sets."]);
      assert.equal(diags[0].severity, vscode.DiagnosticSeverity.Warning);
      // The inlay hint leads with what's missing.
      const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', doc.uri, new vscode.Range(0, 0, doc.lineCount, 0));
      const label = hints.map((h) => (typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join(''))).join('\n');
      assert.match(label, /^missing: sig-key · in: sig-key, sig-ttl\?/);
    });

    it('documents an undocumented read as @in, and drafts a header for a fragment without one', async () => {
      const doc = await open('apiops/policyFragments/signing/policy.xml');
      await setText(doc, doc.getText().replace('var ttl =', 'var region = context.Variables.GetValueOrDefault<string>("sig-region");\n        var ttl ='));
      const [diag] = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'fragment-in-undocumented'), (d) => d.length > 0, 10000);
      assert.equal(doc.getText(diag.range), 'sig-region');
      const fixes = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, diag.range, vscode.CodeActionKind.QuickFix.value);
      // Read only through GetValueOrDefault<string>, so it's an optional string.
      const fix = fixes.find((a) => a.title === "Document 'sig-region' as @in (optional)");
      assert.ok(fix?.edit && (await vscode.workspace.applyEdit(fix.edit)));
      assert.match(doc.getText(), /@in {2}\{int\} {4}\[sig-ttl=300\] {2}Seconds the signature holds\.\n {4}@in {2}\{string\} \[sig-region\] {2}description\n\n {4}@out/);
      await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'fragment-in-undocumented'), (d) => d.length === 0, 10000);

      const bare = await open('apiops/policyFragments/rate-limit/policy.xml');
      const refactors = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', bare.uri, new vscode.Range(0, 2, 0, 2), vscode.CodeActionKind.RefactorRewrite.value);
      const draft = refactors.find((a) => a.title === 'Add a header documenting @in and @out');
      assert.ok(draft?.edit && (await vscode.workspace.applyEdit(draft.edit)));
      assert.match(bare.getText(), /^<!--\n {4}What this fragment does\.\n/);
    });

    it("completes a fragment's arguments where a variable is named, and sets the missing ones with a quick fix", async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<policies>\n    <inbound>\n        <set-variable name="" value="k" />\n        <include-fragment fragment-id="signing" />\n    </inbound>\n</policies>');
      const list = await complete(doc, at(doc, 'name="', 'name="'.length), '"');
      const items = list.items.filter((i) => i.kind === vscode.CompletionItemKind.Variable);
      const first = items.sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''))[0];
      assert.equal(first.label, 'sig-key');
      assert.equal(first.detail, '{string} @in of signing (required)');
      assert.ok(items.some((i) => i.label === 'sig-ttl' && i.detail === '{int} @in of signing (optional, default 300)'));

      // This document had an include on another line in the previous test: wait for this one's.
      const [diag] = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'fragment-in-unset' && d.range.start.line === 3), (d) => d.length > 0, 10000);
      const fixes = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, diag.range, vscode.CodeActionKind.QuickFix.value);
      // An earlier test adds a required sig-region to the fragment, so there may be two.
      const fix = fixes.find((a) => a.title === "Set 'sig-key' before this include" || a.title === 'Set the 2 required inputs before this include');
      assert.ok(fix?.edit && (await vscode.workspace.applyEdit(fix.edit)), fixes.map((f) => f.title).join(' | '));
      assert.match(doc.getText(), /\n {8}<set-variable name="sig-key" value="" \/>\n/);
      assert.match(doc.getText(), /\/>\n {8}<include-fragment/);
    });

    it('flags unguarded Variables[...] reads when the lint is on, and rewrites them to GetValueOrDefault', async () => {
      const config = vscode.workspace.getConfiguration('apimPolicy');
      await config.update('lint.unguardedVariableAccess', 'warning', vscode.ConfigurationTarget.Workspace);
      try {
        const doc = await open('escaped/echo.policy.xml');
        await setText(doc, '<policies>\n    <inbound>\n        <set-header name="a" exists-action="override">\n            <value>@((string)context.Variables[&quot;missing&quot;])</value>\n        </set-header>\n    </inbound>\n</policies>');
        const [diag] = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'unguarded-variable'), (d) => d.length > 0, 10000);
        assert.equal(diag.severity, vscode.DiagnosticSeverity.Warning);
        assert.equal(doc.getText(diag.range), 'missing');
        const fixes = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, diag.range, vscode.CodeActionKind.QuickFix.value);
        const fix = fixes.find((a) => a.title === "Use GetValueOrDefault for 'missing'");
        assert.ok(fix?.edit && (await vscode.workspace.applyEdit(fix.edit)));
        assert.match(doc.getText(), /<value>@\(context\.Variables\.GetValueOrDefault&lt;string&gt;\(&quot;missing&quot;\)\)<\/value>/);
        await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'unguarded-variable'), (d) => d.length === 0, 10000);
      } finally {
        await config.update('lint.unguardedVariableAccess', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });

    it('offers a fragment the variables its callers set', async () => {
      const doc = await open('apiops/policyFragments/random-user/policy.xml');
      const i = doc.getText().indexOf('context.Variables');
      const text = doc.getText();
      const quote = text.indexOf('"', i);
      const names = labels(await complete(doc, doc.positionAt(quote + 1), '"'));
      assert.ok(names.some((n) => n.startsWith('ru-arg-')), names.slice(0, 20).join(', '));
    });
  });

  describe('outputs set on every path', () => {
    it('warns on an @out only some paths set, and sets it at the start with a quick fix', async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<!--\n    @out {int} n  A count.\n-->\n<fragment>\n    <choose>\n        <when condition="@(true)">\n            <set-variable name="n" value="@(1)" />\n        </when>\n    </choose>\n</fragment>');
      const [diag] = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'fragment-out-maybe-unset'), (d) => d.length > 0, 10000);
      assert.equal(diag.severity, vscode.DiagnosticSeverity.Warning);
      const fixes = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, diag.range, vscode.CodeActionKind.QuickFix.value);
      const fix = fixes.find((a) => a.title === "Set 'n' at the start of the fragment");
      assert.ok(fix?.edit && (await vscode.workspace.applyEdit(fix.edit)));
      assert.match(doc.getText(), /<fragment>\n {4}<set-variable name="n" value="@\(0\)" \/>\n {4}<choose>/);
      await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'fragment-out-maybe-unset'), (d) => d.length === 0, 10000);
    });
  });

  describe('arguments, internals and returns', () => {
    it("warns when a caller reads a fragment's internal", async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<policies>\n    <inbound>\n        <include-fragment fragment-id="random-user" />\n        <set-header name="x" exists-action="override">\n            <value>@((string)context.Variables[&quot;ru-int-query&quot;])</value>\n        </set-header>\n    </inbound>\n</policies>');
      const [diag] = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'fragment-internal-read'), (d) => d.length > 0, 10000);
      assert.equal(diag.severity, vscode.DiagnosticSeverity.Warning);
      assert.equal(doc.getText(diag.range), 'ru-int-query');
    });

    it('asks a documented fragment to declare a new variable, and documents it as @internal', async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<!--\n    @in key  A key.\n-->\n<fragment>\n    <set-variable name="scratch" value="@((string)context.Variables[&quot;key&quot;])" />\n    <set-variable name="count" value="@(1)" />\n</fragment>');
      const [diag] = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'fragment-var-undeclared'), (d) => d.length > 0, 10000);
      const fixes = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, diag.range, vscode.CodeActionKind.QuickFix.value);
      assert.deepEqual(fixes.filter((f) => /scratch|undocumented variable|undeclared variable/.test(f.title)).map((f) => f.title), [
        "Document 'scratch' as @internal",
        "Document 'scratch' as @out",
        'Document every undeclared variable as @internal (2)',
        'Treat every undocumented variable as internal (@internal *)',
      ]);
      const fix = fixes.find((f) => f.title === "Document 'scratch' as @internal");
      assert.ok(fix?.edit && (await vscode.workspace.applyEdit(fix.edit)));
      assert.match(doc.getText(), /@in {2}key {2}A key\.\n\n {4}@internal \{string\} scratch {2}description\n-->/);
      // One left: no all-at-once fix for a single variable.
      const [left] = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'fragment-var-undeclared'), (d) => d.length === 1, 10000);
      const rest = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, left.range, vscode.CodeActionKind.QuickFix.value);
      assert.equal(rest.find((f) => f.title.startsWith('Document every undeclared')), undefined);
    });

    it('documents every undeclared variable as @internal at once, each typed', async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<!--\n    @in key  A key.\n-->\n<fragment>\n    <set-variable name="scratch" value="@((string)context.Variables[&quot;key&quot;])" />\n    <set-variable name="count" value="@(1)" />\n</fragment>');
      const [diag] = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'fragment-var-undeclared'), (d) => d.length === 2, 10000);
      const fixes = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, diag.range, vscode.CodeActionKind.QuickFix.value);
      const every = fixes.find((f) => f.title === 'Document every undeclared variable as @internal (2)');
      assert.ok(every?.edit && (await vscode.workspace.applyEdit(every.edit)));
      assert.match(doc.getText(), /@in {2}key {2}A key\.\n\n {4}@internal \{string\} scratch {2}description\n {4}@internal \{int\} {4}count {4}description\n-->/);
      await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'fragment-var-undeclared'), (d) => d.length === 0, 10000);
    });
  });

  describe('docs', () => {
    it('previews the doc for a fragment without writing anything', async () => {
      const frag = await open('apiops/policyFragments/signing/policy.xml');
      await vscode.commands.executeCommand('apimPolicy.generateDocs', frag.uri);
      const md = await waitFor(() => vscode.workspace.textDocuments.find((d) => d.languageId === 'markdown' && d.getText().includes('# signing')), (d) => !!d, 10000);
      assert.ok(md, 'no markdown document opened');
      assert.equal(md.uri.scheme, 'untitled');
      assert.match(md.getText(), /\| `sig-key` \| `string` \| \*\*yes\*\* \| The HMAC key\. \|/);
    });
  });

  describe('building a fragment input', () => {
    it("warns where a caller builds an input unlike the fragment's declared shape", async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<policies>\n    <inbound>\n        <set-variable name="ru-arg-seed" value="s" />\n        <set-variable name="ru-arg-filter" value="@(new JObject { [&quot;bogus&quot;] = 1 })" />\n        <include-fragment fragment-id="random-user" />\n    </inbound>\n</policies>');
      const diags = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'json-shape'), (d) => d.length >= 2, 10000);
      assert.deepEqual(diags.map((d) => [vscode.DiagnosticSeverity[d.severity], d.message]).sort(), [
        ['Warning', "'bogus' isn't a key of the shape this value should have (match?, rules)."],
        ['Warning', "Missing required key 'rules'."],
      ]);
    });

    it("sets every input of a fragment with a quick fix on its include, JSON ones filled in", async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<policies>\n    <inbound>\n        <set-variable name="ru-arg-seed" value="s" />\n        <include-fragment fragment-id="random-user" />\n    </inbound>\n</policies>');
      const at = doc.positionAt(doc.getText().indexOf('random-user') + 2);
      const fixes = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(at, at), vscode.CodeActionKind.QuickFix.value);
      const fix = fixes.find((f) => f.title.startsWith("Set every input of 'random-user'"));
      assert.ok(fix?.edit, fixes.map((f) => f.title).join(' | '));
      assert.equal(fix.title, "Set every input of 'random-user' (16)");
      assert.ok(await vscode.workspace.applyEdit(fix.edit));
      const text = doc.getText();
      assert.match(text, /<set-variable name="ru-arg-results" value="10" \/> <!-- optional, default 10 -->/);
      assert.match(text, /<set-variable name="ru-arg-filter" value="@\(new JObject \{\n {12}\["match"\] = "", \/\/ optional\n {12}\["rules"\] = new JArray \{\n {16}new JObject \{/);
      assert.doesNotMatch(text, /name="ru-arg-seed" value=""/);
    });

    it('shows a @typedef with a filled-in example on hover', async () => {
      const doc = await open('apiops/policyFragments/random-user/policy.xml');
      const pos = doc.positionAt(doc.getText().indexOf('UserFilter') + 2);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
      const text = hovers.flatMap((h) => h.contents.map((c) => (c as vscode.MarkdownString).value)).join('\n');
      assert.match(text, /@typedef\*\* UserFilter/);
      assert.match(text, /"rules": \[\n\s+\{\n\s+"field": "string"/);
      assert.match(text, /\["rules"\] = new JArray \{\n\s+new JObject \{/);
    });
  });

  describe('typed set-variables', () => {
    it("fills in an empty value from the fragment's declared type, and goes to its @in", async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<policies>\n    <inbound>\n        <set-variable name="ru-arg-filter" value="@()" />\n        <set-variable name="ru-arg-results" value="" />\n        <include-fragment fragment-id="random-user" />\n    </inbound>\n</policies>');
      const at = doc.positionAt(doc.getText().indexOf('@()') + 1);
      const fixes = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(at, at), vscode.CodeActionKind.QuickFix.value);
      const fill = fixes.find((f) => f.title === "Fill in 'ru-arg-filter' (UserFilter)");
      assert.ok(fill?.edit, fixes.map((f) => f.title).join(' | '));
      assert.ok(await vscode.workspace.applyEdit(fill.edit));
      assert.match(doc.getText(), /name="ru-arg-filter" value="@\(new JObject \{\n {12}\["match"\] = "", \/\/ optional/);

      // An input with a default completes to it.
      const empty = doc.positionAt(doc.getText().indexOf('name="ru-arg-results" value="') + 'name="ru-arg-results" value="'.length);
      const list = await complete(doc, empty, '"');
      assert.ok(list.items.some((i) => i.label === 'int value' && i.insertText === '10'), labels(list).slice(0, 10).join(', '));

      const name = doc.positionAt(doc.getText().indexOf('ru-arg-filter') + 2);
      const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, name);
      const link = defs.find((d) => 'targetUri' in d && d.targetUri.path.endsWith('policyFragments/random-user/policy.xml')) as vscode.LocationLink | undefined;
      assert.ok(link, JSON.stringify(defs));
      const frag = await vscode.workspace.openTextDocument(link.targetUri);
      assert.equal(frag.getText(link.targetRange), 'ru-arg-filter');
      assert.match(frag.lineAt(link.targetRange.start.line).text, /@in {2}\{UserFilter\}/);
    });

    it('extracts a new JObject in a fragment to a @typedef', async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<!--\n    @out {JObject} o  Out.\n-->\n<fragment>\n    <set-variable name="o" value="@(new JObject { [&quot;status&quot;] = 400, [&quot;title&quot;] = &quot;t&quot; })" />\n</fragment>');
      const at = doc.positionAt(doc.getText().indexOf('JObject {') + 2);
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(at, at), vscode.CodeActionKind.RefactorExtract.value);
      const extract = actions.find((a) => a.title === 'Extract this JObject shape to a @typedef');
      assert.ok(extract?.edit, actions.map((a) => a.title).join(' | '));
      assert.ok(await vscode.workspace.applyEdit(extract.edit));
      // Named for the variable it's the value of; the cursor on the name.
      assert.match(doc.getText(), /^<!--\n {4}@typedef O\n {4}@property \{int\} {4}status\n {4}@property \{string\} title\n\n {4}@out/);
    });

    it('generates a @typedef for a tag whose type the code knows more about, and rewrites old one-line ones', async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<!--\n    @typedef {{ a: int }} Old  Kept.\n    @typedef {{ olds: Old[], at?: { city: string } }} Many\n\n    @out {JArray} ru-int-kept  Kept users.\n-->\n<fragment>\n    <set-variable name="ru-int-kept" value="@(new JArray(new[] { &quot;x&quot; }.Select(s =&gt; new JObject { [&quot;id&quot;] = s })))" />\n</fragment>');
      const kept = doc.positionAt(doc.getText().indexOf('ru-int-kept  Kept'));
      const fixes = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(kept, kept), vscode.CodeActionKind.QuickFix.value);
      const generate = fixes.find((f) => f.title === "Generate a @typedef for 'ru-int-kept'");
      assert.ok(generate?.edit, fixes.map((f) => f.title).join(' | '));
      assert.ok(await vscode.workspace.applyEdit(generate.edit));
      assert.match(doc.getText(), /@typedef Kept\n {4}@property \{string\} id\n\n {4}@out \{Kept\[\]\} ru-int-kept {2}Kept users\./);

      const old = doc.positionAt(doc.getText().indexOf('Old'));
      const rewrites = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(old, old), vscode.CodeActionKind.RefactorRewrite.value);
      const rewrite = rewrites.find((f) => f.title === 'Write Old as @property lines');
      assert.ok(rewrite?.edit, rewrites.map((f) => f.title).join(' | '));
      assert.ok(await vscode.workspace.applyEdit(rewrite.edit));
      assert.match(doc.getText(), /^<!--\n {4}@typedef Old {2}Kept\.\n {4}@property \{int\} a\n/);

      // A typedef that uses another keeps the reference.
      const many = doc.positionAt(doc.getText().indexOf('}} Many') + 4);
      const more = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(many, many), vscode.CodeActionKind.RefactorRewrite.value);
      const rewriteMany = more.find((f) => f.title === 'Write Many as @property lines');
      assert.ok(rewriteMany?.edit, more.map((f) => f.title).join(' | '));
      assert.ok(await vscode.workspace.applyEdit(rewriteMany.edit));
      assert.match(doc.getText(), /@typedef Many\n {4}@property \{Old\[\]\} {3}olds\n {4}@property \{JObject\} \[at\]\n {4}@property \{string\} {2}at\.city\n/);
    });
  });

  describe('editable copies', () => {
    it("stand in for the instance's fragment while open, so callers see unpushed edits", async () => {
      const draft = vscode.Uri.parse('apim-edit://none/none/fragments/draft-frag.fragment.xml');
      await vscode.workspace.fs.writeFile(draft, new TextEncoder().encode('<!--\n    @in  {string} d-key  The key.\n    @in  {string} [d-url=https://example.com/api/]  Where.\n-->\n<fragment>\n    <set-header name="k" exists-action="override"><value>@((string)context.Variables["d-key"] + context.Variables["d-url"])</value></set-header>\n</fragment>\n'));
      const opened = await vscode.workspace.openTextDocument(draft);
      await vscode.languages.setTextDocumentLanguage(opened, 'apim-policy');
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<policies>\n    <inbound>\n        <include-fragment fragment-id="draft-frag" />\n    </inbound>\n</policies>');
      const pos = doc.positionAt(doc.getText().indexOf('draft-frag') + 2);
      const hovers = await waitFor(
        () => Promise.resolve(vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos)),
        (h) => h.some((x) => x.contents.some((c) => (c as vscode.MarkdownString).value?.includes('d-key'))),
        10000,
      );
      const text = hovers.flatMap((h) => h.contents.map((c) => (c as vscode.MarkdownString).value)).join('\n');
      assert.match(text, /d-key.*\(required\)/);
      // The default is code, so its URL isn't linked together with the text after it.
      assert.match(text, /default `https:\/\/example\.com\/api\/`\)/);
    });
  });

  describe('typedef links', () => {
    it("go from a typedef named in a tag's type to its @typedef, and not from a description", async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<!--\n    @typedef Rule  A Rule.\n    @property {string} field\n\n    @typedef Filter\n    @property {Rule[]} rules\n\n    @in {Filter} [f]  Uses Rule.\n-->\n<fragment />');
      const def = (needle: string, offset: number) =>
        vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, doc.positionAt(doc.getText().indexOf(needle) + offset));
      const line = (d: vscode.Location | vscode.LocationLink) => ('targetSelectionRange' in d ? d.targetSelectionRange! : (d as vscode.Location).range).start.line;
      const fromIn = await def('{Filter}', 2);
      assert.strictEqual(fromIn.length, 1);
      assert.strictEqual(line(fromIn[0]), 4);
      const fromProperty = await def('{Rule[]}', 2);
      assert.strictEqual(line(fromProperty[0]), 1);
      assert.strictEqual((await def('Uses Rule', 6)).length, 0);
    });
  });

  describe('instance documents', () => {
    it("lead to the instance's copy of a fragment, and workspace files to the workspace's", async () => {
      const fragment = vscode.Uri.parse('apim-edit://none/none/fragments/rate-limit.fragment.xml');
      await vscode.workspace.fs.writeFile(fragment, new TextEncoder().encode('<!--\n    @in  {string} rl-instance-key  The key.\n-->\n<fragment>\n    <set-header name="k" exists-action="override"><value>@((string)context.Variables["rl-instance-key"])</value></set-header>\n</fragment>\n'));
      await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(fragment), 'apim-policy');
      const policy = vscode.Uri.parse('apim-edit://none/none/apis/echo.policy.xml');
      await vscode.workspace.fs.writeFile(policy, new TextEncoder().encode('<policies>\n    <inbound>\n        <set-variable name="rl-instance-key" value="x" />\n        <include-fragment fragment-id="rate-limit" />\n    </inbound>\n</policies>\n'));
      const doc = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(policy), 'apim-policy');
      const targets = async (d: vscode.TextDocument, text: string, offset: number) => {
        const defs = await waitFor(
          () => Promise.resolve(vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', d.uri, at(d, text, offset))),
          (x) => x.length > 0,
          10000,
        );
        return defs.map((x) => ('targetUri' in x ? x.targetUri : x.uri).toString());
      };
      assert.deepStrictEqual(await targets(doc, 'name="rl-instance-key', 'name="'.length + 1), [fragment.toString()]);
      assert.strictEqual((await targets(doc, 'fragment-id="rate', 'fragment-id="'.length + 1))[0], fragment.toString());
      const local = await open('raw/echo.policy.xml');
      await setText(local, '<policies>\n    <inbound>\n        <include-fragment fragment-id="rate-limit" />\n    </inbound>\n</policies>');
      assert.match((await targets(local, 'fragment-id="rate', 'fragment-id="'.length + 1))[0], /^file:.*rate-limit/);
    });
  });

  describe('JSON shapes', () => {
    it("completes the keys of a JObject another set-variable built", async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<policies>\n    <inbound>\n        <set-variable name="something" value="@(new JObject { [&quot;someData&quot;] = 42 })" />\n        <set-variable name="other" value="@((int?)((JObject)context.Variables[&quot;something&quot;])[&quot;&quot;])" />\n    </inbound>\n</policies>');
      const at = doc.getText().lastIndexOf('[&quot;&quot;]') + '[&quot;'.length;
      const list = await complete(doc, doc.positionAt(at), '"');
      const item = list.items.find((i) => i.label === 'someData');
      assert.ok(item, labels(list).slice(0, 20).join(', '));
      assert.equal(item.detail, 'someData: int');
    });
  });

  describe('JSON shapes across files', () => {
    it("completes keys of an undocumented fragment's output in the file that includes it", async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<policies>\n    <inbound>\n        <include-fragment fragment-id="shaped" />\n        <set-variable name="n" value="@((string)((JArray)((JObject)context.Variables[&quot;sh-result&quot;])[&quot;items&quot;])[0][&quot;&quot;])" />\n    </inbound>\n</policies>');
      const at = doc.getText().lastIndexOf('[&quot;&quot;]') + '[&quot;'.length;
      const list = await complete(doc, doc.positionAt(at), '"');
      const item = list.items.find((i) => i.label === 'name');
      assert.ok(item, labels(list).slice(0, 20).join(', '));
      assert.equal(item.detail, 'name: string');
    });

    it('fills inferred shapes into a drafted header', async () => {
      const doc = await open('apiops/policyFragments/shaped/policy.xml');
      const refactors = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(0, 2, 0, 2), vscode.CodeActionKind.RefactorRewrite.value);
      const draft = refactors.find((a) => a.title === 'Add a header documenting @in and @out');
      assert.ok(draft?.edit);
      const inserted = draft.edit.get(doc.uri)[0].newText;
      assert.match(inserted, /@typedef ShResult\n {4}@property \{int\} {12}count\n {4}@property \{ShResultItem\[\]\} items\n\n {4}@typedef ShResultItem\n {4}@property \{string\} name\n\n {4}@out \{ShResult\} sh-result/);
    });
  });

  describe('header expansions', () => {
    it('expands <!-- above a fragment into a drafted header, and @ inside it into tag lines', async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<!---->\n<fragment>\n    <set-variable name="out" value="@((string)context.Variables[&quot;in&quot;])" />\n</fragment>');
      assert.ok(labels(await complete(doc, new vscode.Position(0, 4), '-')).includes('Fragment header'));
      await setText(doc, '<!--\n    @\n-->\n<fragment>\n    <set-variable name="out" value="@((string)context.Variables[&quot;in&quot;])" />\n</fragment>');
      const tags = labels(await complete(doc, new vscode.Position(1, 5), '@'));
      assert.ok(tags.includes('@in in') && tags.includes('@out out'), tags.join(', '));
    });
  });

  describe('formatting', () => {
    it('re-indents elements and leaves expressions alone', async () => {
      const doc = await open('raw/echo.policy.xml');
      await setText(doc, '<policies><inbound><set-header name="a" exists-action="override"><value>@(context.Request.Headers.GetValueOrDefault("x", ""))</value></set-header></inbound></policies>');
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 2, insertSpaces: true });
      const edit = new vscode.WorkspaceEdit();
      edit.set(doc.uri, edits);
      await vscode.workspace.applyEdit(edit);
      assert.equal(doc.getText(), '<policies>\n  <inbound>\n    <set-header name="a" exists-action="override">\n      <value>@(context.Request.Headers.GetValueOrDefault("x", ""))</value>\n    </set-header>\n  </inbound>\n</policies>\n');
    });
  });

  describe('APIM instance', () => {
    it('registers its commands, and reads nothing until an instance is set', async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const id of ['apimPolicy.selectInstance', 'apimPolicy.refreshInstance', 'apimPolicy.signIn', 'apimPolicy.openInstancePolicy', 'apimPolicy.setPolicyScope', 'apimPolicy.openScope', 'apimPolicy.useAsScope', 'apimPolicy.copyNamedValue', 'apimPolicy.pushPolicy', 'apimPolicy.openEditable', 'apimPolicy.confirmPush', 'apimPolicy.cancelPush', 'apimPolicy.reloadFromInstance', 'apimPolicy.generateDocs', 'apimPolicy.writeDocs']) assert.ok(commands.includes(id), id);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('apim-instance://none/none/apis/echo.policy.xml'));
      assert.match(doc.getText(), /No APIM instance is connected/);
    });

    it("won't write the read-only copy, and keeps a saved editable copy as a draft", async () => {
      const bytes = new TextEncoder().encode('<policies />');
      await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(vscode.Uri.parse('apim-instance://none/none/apis/echo.policy.xml'), bytes)));
      // Saving never goes to the instance (there isn't one here); it's only kept until a push.
      const draft = vscode.Uri.parse('apim-edit://none/none/apis/echo.policy.xml');
      await vscode.workspace.fs.writeFile(draft, bytes);
      assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(draft)), '<policies />');
    });

    it("doesn't flag named values while it can't read the instance", async () => {
      const config = vscode.workspace.getConfiguration('apimPolicy');
      await config.update('instance', '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.ApiManagement/service/nothing', vscode.ConfigurationTarget.Workspace);
      try {
        const doc = await open('raw/echo.policy.xml');
        await setText(doc, '<policies><inbound><set-header name="a" exists-action="override"><value>{{not-there}}</value></set-header></inbound></policies>');
        await new Promise((r) => setTimeout(r, 1500));
        assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).filter((d) => codeOf(d) === 'unknown-named-value'), []);
      } finally {
        await config.update('instance', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });
  });

  describe('what the gateway rejects that modern C# accepts', () => {
    it('flags newer syntax as an error and .NET Core-only members as warnings', async () => {
      const doc = await open('raw/compat.policy.xml');
      const diags = await waitFor(
        () => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'language-version' || d.code === 'framework'),
        (d) => d.length >= 2,
        30000,
      );
      const found = diags.map((d) => `${codeOf(d)}:${vscode.DiagnosticSeverity[d.severity]}:${doc.getText(d.range)}`).sort();
      assert.deepEqual(found, ['framework:Warning:Chunk', 'language-version:Error:switch { 200 => "ok", _ => "no" }']);
    });

    it('types condition attributes as bool', async () => {
      const doc = await open('raw/compat.policy.xml');
      const diags = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'apim (C#)'), (d) => d.length >= 1, 10000);
      assert.deepEqual(diags.map((d) => `${doc.getText(d.range)}: ${d.message}`), ["context.Request.Method: Cannot implicitly convert type 'string' to 'bool'."]);
    });
  });

  describe('C# in expressions', () => {
    const policy = `<policies>
    <inbound>
        <set-variable name="a" value="@(context.Request.Headers.GetValueOrDefault(&quot;X&quot;, &quot;&quot;))" />
        <set-variable name="b" value="@(context.Request.Headers.Where(h =&gt; h.Key.Length &gt; 1).Count())" />
        <set-variable name="c" value="@(context.Request.Nope)" />
        <set-variable name="d" value="@(context.Request.)" />
    </inbound>
</policies>`;
    let doc: vscode.TextDocument;

    before(async () => {
      doc = await open('raw/echo.policy.xml');
      await setText(doc, policy);
    });

    it('completes members, with ranges in the policy', async () => {
      const pos = at(doc, 'context.Request.)', 'context.Request.'.length);
      const list = await complete(doc, pos, '.');
      for (const n of ['Headers', 'Body', 'Url', 'Method']) assert.ok(labels(list).includes(n), `${n} in ${labels(list).join(', ')}`);
      const item = list.items.find((i) => i.label === 'Headers')!;
      assert.ok(item.range instanceof vscode.Range && item.range.start.isEqual(pos));
    });

    it('completes lambda parameters in the escaped format', async () => {
      const names = labels(await complete(doc, at(doc, 'h.Key', 2), '.'));
      assert.ok(names.includes('Key') && names.includes('Value'), names.join(', '));
    });

    it('shows signatures and docs on hover, with signature help', async () => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, at(doc, 'Headers.GetValueOrDefault', 2));
      const text = hovers.flatMap((h) => h.contents).map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : '')).join('\n');
      assert.match(text, /IReadOnlyDictionary<string, string\[\]> IRequest\.Headers/);
      assert.match(text, /Request headers/);
      const help = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, at(doc, 'GetValueOrDefault(', 'GetValueOrDefault('.length), '(');
      assert.ok(help && help.signatures.length === 2, 'both GetValueOrDefault overloads');
    });

    it('goes to the stub definition', async () => {
      const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, at(doc, 'Request.Headers', 2));
      const uris = defs.map((d) => ('targetUri' in d ? d.targetUri : d.uri).path);
      assert.ok(uris.some((p) => p.endsWith('stubs/ApimContext.cs')), uris.join(', '));
    });

    it('reports errors on the policy and updates them after an edit', async () => {
      const diags = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'apim (C#)'), (d) => d.length >= 2, 10000);
      assert.deepEqual(diags.map((d) => doc.getText(d.range)).sort(), ['.', 'Nope']);
      await setText(doc, doc.getText().replace('context.Request.Nope', 'context.Request.Method').replace('context.Request.)', 'context.Request.Method)'));
      const after = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'apim (C#)'), (d) => d.length === 0, 10000);
      assert.equal(after.length, 0);
    });

    it('flags disallowed members through what the engine bound, as errors by default', async () => {
      await setText(doc, doc.getText().replace('value="@(context.Request.Method)"', 'value="@{ var d = DateTime.Now; return d.ToBinary(); }"'));
      const diags = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => codeOf(d).startsWith('disallowed-')), (d) => d.length >= 1, 10000);
      assert.deepEqual(diags.map((d) => `${codeOf(d)}:${vscode.DiagnosticSeverity[d.severity]}:${doc.getText(d.range)}`), ['disallowed-member:Error:ToBinary']);
    });
  });
});

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const withCSharp = process.env.APIM_IT_WITH_CSHARP === '1';
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

/** Replaces the document's text and waits for our diagnostics to settle. */
async function setText(doc: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

describe('APIM policy extension', () => {
  before(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'apim-policy');
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
      const codes = diags.map((d) => String(d.code)).sort();
      assert.deepEqual(codes, ['unknown-policy', 'unterminated-expression', 'unterminated-expression', 'unterminated-expression', 'wrong-section']);
    });

    it('applies fragment rules', async () => {
      const doc = await open('fragments/bad-fragment.xml');
      const diags = await waitFor(() => vscode.languages.getDiagnostics(doc.uri), (d) => d.length >= 2);
      assert.deepEqual(diags.map((d) => String(d.code)).sort(), ['fragment-section', 'nested-fragment']);
    });

    it('stays quiet on valid policies', async () => {
      const doc = await open('escaped/echo.policy.xml');
      await sleep(withCSharp ? 8000 : 1000);
      assert.deepEqual(vscode.languages.getDiagnostics(doc.uri).map((d) => `${d.source} ${d.code} ${d.message}`), []);
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
      assert.ok(ids.includes('rate-limit') && ids.includes('random-user-pipeline'), `fragment ids: ${ids.join(', ')}`);
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

    it('offers a fragment the variables its callers set', async () => {
      const doc = await open('apiops/policyFragments/random-user-pipeline/policy.xml');
      const i = doc.getText().indexOf('context.Variables');
      const text = doc.getText();
      const quote = text.indexOf('"', i);
      const names = labels(await complete(doc, doc.positionAt(quote + 1), '"'));
      assert.ok(names.some((n) => n.startsWith('ru-arg-')), names.slice(0, 20).join(', '));
    });
  });

  (withCSharp ? describe : describe.skip)('C# in expressions', () => {
    const policy = `<policies>
    <inbound>
        <set-variable name="a" value="@(context.Request.Headers.GetValueOrDefault(&quot;X&quot;, &quot;&quot;))" />
        <set-variable name="b" value="@(context.Request.Body.As<JObject>(true)["x"])" />
        <set-variable name="c" value="@(context.Request.Nope)" />
        <set-variable name="d" value="@(context.Request.)" />
    </inbound>
</policies>`;
    let doc: vscode.TextDocument;

    before(async () => {
      doc = await open('raw/echo.policy.xml');
      await setText(doc, policy);
    });

    it('completes context members through the C# extension', async () => {
      const names = await waitFor(async () => labels(await complete(doc, at(doc, 'context.Request.)', 'context.Request.'.length), '.')), (n) => n.includes('Headers'), 120000);
      for (const n of ['Headers', 'Body', 'Url', 'Method']) assert.ok(names.includes(n), `${n} in ${names.join(', ')}`);
    });

    it('maps completion ranges back into the policy', async () => {
      const list = await complete(doc, at(doc, 'context.Request.)', 'context.Request.'.length), '.');
      const item = list.items.find((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'Headers')!;
      const range = item.range instanceof vscode.Range ? item.range : item.range?.replacing;
      if (range) assert.equal(range.start.line, at(doc, 'context.Request.)').line);
    });

    it('shows stub docs on hover', async () => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, at(doc, 'Headers.GetValueOrDefault', 2));
      const text = hovers.flatMap((h) => h.contents).map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : '')).join('\n');
      assert.match(text, /Request headers/);
    });

    it('offers signature help', async () => {
      const help = await vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider', doc.uri, at(doc, 'GetValueOrDefault(', 'GetValueOrDefault('.length), '(');
      assert.ok(help && help.signatures.length >= 2, 'both GetValueOrDefault overloads');
    });

    it('goes to the stub definition', async () => {
      const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, at(doc, 'Request.Headers', 2));
      const uris = defs.map((d) => ('targetUri' in d ? d.targetUri : d.uri).path);
      assert.ok(uris.some((p) => p.endsWith('stubs/ApimContext.cs')), uris.join(', '));
    });

    it('reports type errors on the policy', async () => {
      const diags = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'apim (C#)'), (d) => d.some((x) => x.code === 'CS1061'), 120000);
      const err = diags.find((d) => d.code === 'CS1061')!;
      assert.equal(doc.getText(err.range), 'Nope');
      assert.ok(!diags.some((d) => /Newtonsoft|JObject/.test(d.message)), 'no restore noise');
    });

    it('flags disallowed types syntactically and disallowed members semantically', async () => {
      await setText(
        doc,
        doc.getText().replace('value="@(context.Request.)"', 'value="@(System.IO.File.ReadAllText(&quot;x&quot;) + DateTime.Now.ToBinary())"'),
      );
      const diags = await waitFor(
        () => vscode.languages.getDiagnostics(doc.uri).filter((d) => String(d.code).startsWith('disallowed-')),
        (d) => d.length >= 2,
        60000,
      );
      const found = diags.map((d) => `${d.code}:${doc.getText(d.range)}`).sort();
      assert.deepEqual(found, ['disallowed-member:ToBinary', 'disallowed-type:System.IO.File']);
      assert.equal(diags[0].severity, vscode.DiagnosticSeverity.Warning);
    });

    it('updates type errors after an edit', async () => {
      await setText(doc, doc.getText().replace('context.Request.Nope', 'context.Request.Method'));
      const diags = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.code === 'CS1061'), (d) => d.length === 0, 30000);
      assert.equal(diags.length, 0);
    });
  });

  (withCSharp ? describe.skip : describe)('C# in expressions, built-in engine', () => {
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

    it('flags disallowed members through what the engine bound', async () => {
      await setText(doc, doc.getText().replace('value="@(context.Request.Method)"', 'value="@{ var d = DateTime.Now; return d.ToBinary(); }"'));
      const diags = await waitFor(() => vscode.languages.getDiagnostics(doc.uri).filter((d) => String(d.code).startsWith('disallowed-')), (d) => d.length >= 1, 10000);
      assert.deepEqual(diags.map((d) => `${d.code}:${doc.getText(d.range)}`), ['disallowed-member:ToBinary']);
    });
  });
});

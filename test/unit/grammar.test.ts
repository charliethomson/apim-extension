import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';

const root = join(__dirname, '..', '..');
const grammarFiles: Record<string, string> = {
  'text.xml.apim': join(root, 'syntaxes/apim-policy.tmLanguage.json'),
  'apim.expression.injection': join(root, 'syntaxes/apim-expression.injection.json'),
  'text.xml': join(root, 'test/grammars/xml.tmLanguage.json'),
  'source.cs': join(root, 'test/grammars/csharp.tmLanguage.json'),
};

let registry: vsctm.Registry;

beforeAll(async () => {
  const wasm = readFileSync(join(root, 'node_modules/vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scopeName) => {
      const path = grammarFiles[scopeName];
      return path ? vsctm.parseRawGrammar(readFileSync(path, 'utf8'), path) : null;
    },
    // Mirrors package.json: the injection is only injected into the APIM grammar.
    getInjections: (scopeName) => (scopeName === 'text.xml.apim' ? ['apim.expression.injection'] : undefined),
  });
});

interface Tok {
  text: string;
  scopes: string[];
}

async function tokenize(source: string, scope = 'text.xml.apim'): Promise<Tok[]> {
  const grammar = await registry.loadGrammar(scope);
  if (!grammar) throw new Error(`no grammar ${scope}`);
  let state = vsctm.INITIAL;
  const out: Tok[] = [];
  for (const line of source.split('\n')) {
    const r = grammar.tokenizeLine(line, state);
    for (const t of r.tokens) out.push({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes });
    state = r.ruleStack;
  }
  return out;
}

/** Scopes of the first token whose text is exactly `text`, searching from the `nth` match. */
function scopesOf(toks: Tok[], text: string, nth = 0): string[] {
  const hits = toks.filter((t) => t.text === text);
  const hit = hits[nth];
  if (!hit) throw new Error(`no token ${JSON.stringify(text)} (#${nth}) in ${JSON.stringify(toks.map((t) => t.text))}`);
  return hit.scopes;
}

const inExpr = (s: string[]) => s.some((x) => x.startsWith('meta.embedded.'));

describe('expression injection grammar', () => {
  it('ends a raw attribute expression at the balanced paren, not at a quote inside it', async () => {
    const toks = await tokenize('<when condition="@(context.Request.Method == "POST")">');
    expect(scopesOf(toks, 'POST').some((s) => s.startsWith('string.quoted.double.cs'))).toBe(true);
    expect(inExpr(scopesOf(toks, 'Method'))).toBe(true);
    const close = scopesOf(toks, '>');
    expect(inExpr(close)).toBe(false);
    expect(close.some((s) => s.startsWith('punctuation.definition.tag'))).toBe(true);
  });

  it('does not end at a ) inside a C# string or a nested call', async () => {
    const toks = await tokenize(
      '<value>@(context.Request.Headers.GetValueOrDefault("X", ")").Split(\',\').First())</value>',
    );
    expect(inExpr(scopesOf(toks, 'First'))).toBe(true);
    expect(inExpr(scopesOf(toks, 'value', 1))).toBe(false);
  });

  it('handles a multi-line block with } in strings and nested braces', async () => {
    const toks = await tokenize(
      [
        '<set-body>@{',
        '  var s = "}";',
        '  if (s.Length > 0) { return "{" + s; }',
        '  return context.Request.Url.Path;',
        '}</set-body>',
      ].join('\n'),
    );
    expect(inExpr(scopesOf(toks, 'Path'))).toBe(true);
    expect(inExpr(scopesOf(toks, 'set-body', 1))).toBe(false);
  });

  it('scopes generics and lambdas as C#', async () => {
    const toks = await tokenize(
      '<set-variable name="n" value="@(context.Request.Body.As<JObject>(true).Properties().Count(p => p.Name != "id"))" />',
    );
    expect(inExpr(scopesOf(toks, 'JObject'))).toBe(true);
    expect(inExpr(scopesOf(toks, 'Count'))).toBe(true);
    expect(inExpr(scopesOf(toks, '/>'))).toBe(false);
  });

  it('marks named values outside and inside expressions', async () => {
    const toks = await tokenize('<set-header name="k"><value>{{api-key}}</value></set-header>');
    expect(scopesOf(toks, '{{api-key}}')).toContain('variable.other.named-value.apim');
  });

  it('scopes C# comparison and arrow operators as unbalanced brackets, but not generics', async () => {
    // VS Code's bracket colouriser flags lone < and > red unless their scope is listed here.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const unbalanced: string[] = pkg.contributes.grammars[0].unbalancedBracketScopes;
    const isUnbalanced = (scopes: string[]) => scopes.some((s) => unbalanced.some((u) => s.startsWith(u)));
    const line = '<set-body>@{ if (a < b && c >= d) { xs.Where(x => x > 1); } return new List<int>(); }</set-body>';
    const toks = await tokenize(line);
    for (const op of ['<', '>=', '=>', '>']) {
      const t = toks.find((x) => x.text === op && inExpr(x.scopes));
      expect(t, op).toBeDefined();
      expect(isUnbalanced(t!.scopes), `${op}: ${t!.scopes.join(' ')}`).toBe(true);
    }
    const generic = toks.filter((x) => x.text === '<' && inExpr(x.scopes)).pop()!;
    expect(isUnbalanced(generic.scopes)).toBe(false);
  });

  it('leaves plain XML files alone', async () => {
    const toks = await tokenize('<a b="@(x == 1)">@{ return 1; }</a>', 'text.xml');
    expect(toks.some((t) => inExpr(t.scopes))).toBe(false);
  });
});

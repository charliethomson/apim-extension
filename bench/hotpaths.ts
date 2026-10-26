// Benchmarks for the work the extension does on startup, on every edit, and per request.
// Run: npm run bench (add -- --filter <text> to run some)
//
// "Per edit" is everything that reruns after a keystroke in a policy (each feature debounces on
// its own, but they all run): the XML parse, structural validation, the variable summary the
// workspace index keeps, the C# engine's diagnostics and compatibility check, and the
// allowlist lint.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Allowlist, type AllowlistData, type BclIndex, CSharpEngine, lintAllowedTypes, lintReferences, type RawModel, readStubs, TypeModel } from '@charliethomson/apim-csharp-engine';
import { parse } from '@charliethomson/apim-document';
import { catalog, validate } from '@charliethomson/apim-catalog';
import { resultTypes, summarize } from '@charliethomson/apim-analysis';

// ---- harness ----------------------------------------------------------------------------------

const filter = process.argv.includes('--filter') ? process.argv[process.argv.indexOf('--filter') + 1] : undefined;
const results: { group: string; name: string; mean: number; p50: number; p95: number; max: number; runs: number }[] = [];
let group = '';

function describe(name: string, f: () => void): void {
  group = name;
  f();
}

/** Runs `f` until it has had ~1s (at least 10 runs, at most 2000) after a short warmup. */
function bench(name: string, f: () => void): void {
  if (filter && !`${group} ${name}`.includes(filter)) return;
  for (let i = 0; i < 3; i++) f();
  const times: number[] = [];
  const until = performance.now() + 1000;
  while ((times.length < 10 || performance.now() < until) && times.length < 2000) {
    const t = performance.now();
    f();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  results.push({ group, name, mean: times.reduce((a, b) => a + b, 0) / times.length, p50: q(0.5), p95: q(0.95), max: times[times.length - 1], runs: times.length });
}

process.on('beforeExit', () => {
  if (!results.length) return;
  const ms = (n: number) => (n < 1 ? n.toFixed(3) : n < 100 ? n.toFixed(2) : n.toFixed(0)).padStart(8);
  let last = '';
  for (const r of results) {
    if (r.group !== last) console.log(`\n${(last = r.group)}\n${'mean ms'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)}  runs`);
    console.log(`${ms(r.mean)} ${ms(r.p50)} ${ms(r.p95)} ${ms(r.max)}  ${String(r.runs).padStart(4)}  ${r.name}`);
  }
  results.length = 0;
});

// ---- setup --------------------------------------------------------------------------------------

// `npm run bench` runs from bench/; the bundle in out/ can't find the assets by its own path.
const assets = join(process.cwd(), '..', 'packages', 'csharp-engine', 'assets');
const read = (name: string) => readFileSync(join(assets, name), 'utf8');
const modelText = read('csharp-model.json');
const stubs = read('ApimContext.cs');
const allowData = JSON.parse(read('allowed-types.json')) as AllowlistData;
const bcl = JSON.parse(read('bcl-types.json')) as BclIndex;

const raw = JSON.parse(modelText) as RawModel;
const engine = CSharpEngine.load(raw, stubs);
const allow = new Allowlist(allowData, bcl, new Set(engine.stubTypeNames()));

/** Realistic expressions, in the raw format, cycled to build policies of any size. */
const EXPRESSIONS = [
  '@(context.Request.Method == "POST")',
  '@(context.Request.Headers.GetValueOrDefault("Authorization", "").AsJwt()?.Subject)',
  '@(context.Request.Headers.Where(h => h.Key.StartsWith("x-")).Select(h => h.Value.First()).ToList().Count)',
  '@(context.Variables.GetValueOrDefault<int>("n", 0) + 1)',
  '@(string.Join(",", context.Request.Url.Query.Select(q => q.Key + "=" + q.Value.FirstOrDefault())))',
  '@(DateTime.UtcNow.AddSeconds({{ttl}}).ToString("o"))',
  '@(context.Response.StatusCode >= 500 ? "error" : "ok")',
  `@{
            var body = context.Request.Body.As<JObject>(preserveContent: true);
            var ids = body["items"].Select(i => (string)i["id"]).Where(id => id.Length < 10).ToList();
            if (ids.Count > 0 && ids[0] != "x") { body["first"] = ids[0]; }
            return body.ToString();
        }`,
  `@{
            string[] value;
            if (context.Request.Headers.TryGetValue("Authorization", out value) && value.Length > 0)
            {
                return Encoding.UTF8.GetString(Convert.FromBase64String(value[0].Substring(6)));
            }
            return null;
        }`,
  '@(from h in context.Request.Headers where h.Value.Length > 1 orderby h.Key select h.Key)',
];

function policy(expressions: number): string {
  const lines: string[] = ['<policies>', '    <inbound>', '        <base />'];
  for (let i = 0; i < expressions; i++) {
    const e = EXPRESSIONS[i % EXPRESSIONS.length];
    // Vary each copy so no two expressions share a cache entry.
    const code = e.replace('"POST"', `"POST${i}"`).replace('("n"', `("n${i}"`).replace('"x-"', `"x-${i}"`).replace('"x")', `"x${i}")`).replace('"Authorization"', `"Authorization${i}"`).replace('h.Value.Length > 1', `h.Value.Length > ${i}`).replace('"error"', `"error${i}"`).replace('"o"', `"o${i}"`).replace('"="', `"=${i}"`).replace('{{ttl}}', `{{ttl${i}}}`);
    if (i % 7 === 0) lines.push(`        <choose><when condition="${code.startsWith('@(') ? `@(context.Request.Method == "M${i}")` : code}"><base /></when></choose>`);
    else if (code.startsWith('@{')) lines.push(`        <set-body>${code}</set-body>`);
    else lines.push(`        <set-variable name="v${i}" value="${code}" />`);
  }
  lines.push('    </inbound>', '    <backend><forward-request /></backend>', '    <outbound><base /></outbound>', '    <on-error><base /></on-error>', '</policies>');
  return lines.join('\n');
}

const SMALL = policy(10);
const LARGE = policy(250);

/** The allowlist feature's cache of syntactic lint results, by code. */
const lintCache = new Map<string, unknown[]>();
const lint = (code: string) => {
  let hit = lintCache.get(code);
  if (!hit) lintCache.set(code, (hit = lintAllowedTypes(code, allow)));
  return hit;
};

/** Everything that reruns after one keystroke in `text`, with the caches as the editor has them. */
function perEdit(text: string, e: CSharpEngine): number {
  const doc = parse(text);
  let n = validate(doc, catalog).length + summarize(doc).variables.length;
  const types = resultTypes(doc, catalog);
  for (const x of doc.expressions) {
    n += e.diagnostics(x.code, x.kind, types.get(x)).length;
    n += e.compatibility(x.code, x.kind).length;
    n += lint(x.code).length;
    n += lintReferences(e.references(x.code, x.kind), allow).length;
  }
  return n;
}

/** The text after typing one character into the last expression, so every other expression is unchanged. */
function edited(text: string, i: number): string {
  const at = text.lastIndexOf('context.Request.Method');
  return `${text.slice(0, at)}context.Request.Method${i % 2 ? '' : ' '}${text.slice(at + 'context.Request.Method'.length)}`;
}

if (!filter) {
  // What the engine's cache costs when it's full (2000 analysed expressions).
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) {
    gc();
    const before = process.memoryUsage().heapUsed;
    const fresh = new CSharpEngine(engine.model);
    for (const x of parse(policy(2000)).expressions) fresh.diagnostics(x.code, x.kind);
    gc();
    console.log(`a full engine cache (2000 expressions) holds ${((process.memoryUsage().heapUsed - before) / 1024 / 1024).toFixed(1)} MB`);
  }
}

describe('startup (once per window, when the first policy opens)', () => {
  bench('parse csharp-model.json', () => {
    JSON.parse(modelText);
  });
  bench('build the type model and read the stubs', () => {
    const r = JSON.parse(modelText) as RawModel;
    new TypeModel(r, readStubs(stubs, r));
  });
  bench('build the allowlist', () => {
    new Allowlist(allowData, bcl, new Set(['IProxyRequestContext']));
  });
  bench('first diagnostics on a fresh engine (cold member and supertype caches)', () => {
    const fresh = CSharpEngine.load(JSON.parse(modelText) as RawModel, stubs);
    for (const x of parse(SMALL).expressions) fresh.diagnostics(x.code, x.kind);
  });
});

describe('per edit, 10-expression policy', () => {
  let i = 0;
  bench('everything', () => {
    perEdit(edited(SMALL, i++), engine);
  });
});

describe('per edit, 250-expression policy', () => {
  let i = 0;
  bench('everything', () => {
    perEdit(edited(LARGE, i++), engine);
  });
  bench('XML parse', () => {
    parse(edited(LARGE, i++));
  });
  const doc = parse(LARGE);
  bench('structural validation', () => {
    validate(doc, catalog);
  });
  bench('variable summary (workspace index, on every change)', () => {
    // A new object per run: summaries are memoised per parsed document.
    summarize({ ...doc });
  });
  bench('allowlist lint, syntactic (no cache)', () => {
    for (const x of doc.expressions) lintAllowedTypes(x.code, allow);
  });
  bench('engine diagnostics, all expressions uncached', () => {
    const fresh = new CSharpEngine(engine.model);
    for (const x of doc.expressions) fresh.diagnostics(x.code, x.kind);
  });
});

describe('requests (completion, hover, signature help) in a large block', () => {
  const block = `var body = context.Request.Body.As<JObject>(preserveContent: true);
var ids = body["items"].Select(i => (string)i["id"]).Where(id => id.Length < 10).ToList();
foreach (var h in context.Request.Headers) { if (h.Key.StartsWith("x-")) { ids.Add(h.Value[0]); } }
int Twice(int x) => x * 2;
var q = from h in context.Request.Headers where h.Value.Length > Twice(1) select h.Key;
`.repeat(10);
  const at = (marker: string) => {
    const code = `${block}${marker}\nreturn ids.Count;`;
    return { code: code.replace('|', ''), offset: code.indexOf('|') };
  };
  const member = at('context.Request.|');
  const linq = at('ids.|');
  const name = at('var z = |');
  const sig = at('string.Join(|');
  bench('member completion: context.Request.', () => {
    engine.complete(member.code, 'block', member.offset);
  });
  bench('member completion with LINQ extensions: list.', () => {
    engine.complete(linq.code, 'block', linq.offset);
  });
  bench('name completion (locals, types, keywords)', () => {
    engine.complete(name.code, 'block', name.offset);
  });
  bench('hover', () => {
    engine.hover(linq.code, 'block', linq.code.indexOf('Select'));
  });
  bench('signature help: string.Join(', () => {
    engine.signatureHelp(sig.code, 'block', sig.offset);
  });
});

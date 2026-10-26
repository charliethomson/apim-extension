import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunInput, RunResult } from '../src/protocol';
import { nodeFiles } from '../src/project';
import { findTestFiles, runTests, type TestResult } from '../src/run';
import type { Runner } from '../src/runner';

const extract = join(__dirname, 'extract');
const ok: RunResult = { variables: {}, calls: [], trace: [], steps: [] };

/** A runner that answers every run with `answer(input)`. */
const fakeRunner = (answer: (input: RunInput) => RunResult | Promise<RunResult>) => {
  const runs: RunInput[] = [];
  const runner: Runner = { run: async (input) => (runs.push(input), answer(input)), close: () => Promise.resolve() };
  return { runs, start: () => Promise.resolve(runner) };
};

/** In-memory files over the real extract: `extra` adds or replaces files. */
const files = (extra: Record<string, string>) => ({
  read: (p: string) => (p in extra ? Promise.resolve(extra[p]) : nodeFiles.read(p)),
  folders: (p: string) => nodeFiles.folders(p),
});

describe('finding test files', () => {
  it('takes YAML in tests/ folders under a directory, and files as given', async () => {
    const found = (await findTestFiles([extract])).map((f) => f.slice(extract.length + 1));
    expect(found).toEqual(['apis/orders/tests/create.yaml', 'apis/orders/tests/orders.yaml', 'policyFragments/stamp/tests/stamp.yaml', 'tests/global.yaml']);
    expect(await findTestFiles([join(extract, 'policy.xml')])).toEqual([join(extract, 'policy.xml')]);
  });
});

describe('running tests', () => {
  const orders = join(extract, 'apis', 'orders', 'tests', 'x.yaml');

  it('runs each case and reports passes and failures with their lines', async () => {
    const runner = fakeRunner((input) => (input.request.headers?.Fail ? { ...ok, response: { status: 500, headers: {} } } : { ...ok, response: { status: 200, headers: {} } }));
    const seen: TestResult[] = [];
    const results = await runTests([orders], {
      runner: runner.start,
      files: files({ [orders]: 'product: gold\nrequest: { url: /x }\nexpect:\n  response:\n    status: 200\ncases:\n  - name: passes\n  - name: fails\n    request: { headers: { Fail: "1" } }\n' }),
      onResult: (r) => seen.push(r),
    });
    expect(results.map((r) => [r.name, r.status, r.messages])).toEqual([
      ['passes', 'passed', []],
      ['fails', 'failed', [{ message: 'Expected status 200, got 500.', file: orders, line: 5 }]],
    ]);
    expect(seen).toEqual(results);
    expect(runner.runs[0].scopes.map((s) => s.kind)).toEqual(['api', 'product', 'global']);
  });

  it('only runs the cases the filter names', async () => {
    const runner = fakeRunner(() => ok);
    const results = await runTests([orders], { runner: runner.start, filter: 'TWO', files: files({ [orders]: 'product: gold\nrequest: { url: /x }\ncases:\n  - name: one\n  - name: two\n' }) });
    expect(results.map((r) => r.name)).toEqual(['two']);
  });

  it("reports what the runner couldn't do as errors, in the policy's file", async () => {
    const failure = (f: Partial<NonNullable<RunResult['failure']>>): RunResult => ({ ...ok, failure: { kind: 'unsupported', message: 'no <quota>', line: 4, col: 9, diagnostics: [], ...f } });
    const answers = [
      failure({ file: '/p/policy.xml' }),
      failure({ kind: 'compile', message: 'x', diagnostics: [{ code: 'CS1061', message: 'no Nope', file: '/p/policy.xml', line: 3, col: 41 }] }),
      failure({ kind: 'test', message: 'no backend', file: undefined, line: 0, col: 0 }),
    ];
    const runner = fakeRunner(() => answers.shift()!);
    const results = await runTests([orders], { runner: runner.start, files: files({ [orders]: 'product: gold\nrequest: { url: /x }\ncases:\n  - name: a\n  - name: b\n  - name: c\n' }) });
    expect(results.map((r) => [r.status, r.messages])).toEqual([
      ['error', [{ message: 'no <quota>', file: '/p/policy.xml', line: 4, col: 9 }]],
      ['error', [{ message: 'CS1061: no Nope', file: '/p/policy.xml', line: 3, col: 41 }]],
      ['error', [{ message: 'no backend', file: orders, line: 6 }]],
    ]);
  });

  it("reports a file it can't read, a case it can't build, and a runner that fails", async () => {
    const broken = join(extract, 'apis', 'orders', 'tests', 'broken.yaml');
    const missing = join(extract, 'apis', 'orders', 'tests', 'missing.yaml');
    const unbuildable = join(extract, 'apis', 'orders', 'tests', 'unbuildable.yaml');
    const results = await runTests([broken, missing, unbuildable, orders], {
      runner: () => Promise.reject(new Error('no dotnet')),
      files: files({ [broken]: 'request: [', [unbuildable]: 'request: { url: /x }', [orders]: 'product: gold\nrequest: { url: /x }' }),
    });
    expect(results.map((r) => [r.name, r.status, r.messages[0].message.split(':')[0], r.messages[0].line])).toEqual([
      ['broken.yaml', 'error', 'Not valid YAML', 1],
      ['missing.yaml', 'error', "The test file isn't there.", 1],
      ['unbuildable', 'error', 'API orders is in products gold, silver', 1],
      ['x', 'error', 'no dotnet', 1],
    ]);
  });
});

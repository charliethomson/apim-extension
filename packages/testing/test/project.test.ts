import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bodyText, buildRun, locate, nodeFiles, Project, requestFor, TEST_HOST } from '../src/project';
import { parseTestFile, type TestCase, TestFileError } from '../src/testFile';

const root = join(__dirname, 'extract');
const at = (rel: string) => join(root, rel);
const test = (file: string, yaml: string): TestCase => parseTestFile(at(file), yaml)[0];

async function run(file: string, yaml: string) {
  const t = test(file, yaml);
  const located = await locate(t);
  return { located, input: await buildRun(t, new Project(located.root), located) };
}

const rejects = async (p: Promise<unknown>, message: string) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(TestFileError);
  expect((e as Error).message).toContain(message);
};

describe('locating a test', () => {
  it("finds the scope from the tests folder's place", async () => {
    expect(await locate(test('apis/orders/tests/a.yaml', 'request: { url: /x }'))).toEqual({ root, scope: { kind: 'api', api: 'orders' }, policyFile: at('apis/orders/policy.xml') });
    expect((await locate(test('apis/orders/tests/a.yaml', 'policy: operations/create\nrequest: { url: /x }'))).scope).toEqual({ kind: 'operation', api: 'orders', operation: 'create' });
    expect((await locate(test('policyFragments/stamp/tests/a.yaml', 'request: { url: /x }'))).scope).toEqual({ kind: 'fragment', fragment: 'stamp' });
    expect(await locate(test('tests/a.yaml', 'request: { url: /x }'))).toMatchObject({ root, scope: { kind: 'global' } });
  });

  it('turns away a file outside tests/, or beside no policy', async () => {
    await rejects(locate(test('apis/orders/a.yaml', 'request: { url: /x }')), 'lives in a tests/ folder');
    await rejects(locate(test('apis/orders/tests/a.yaml', 'policy: elsewhere\nrequest: { url: /x }')), "isn't a policy in an APIOps extract");
    await rejects(locate(parseTestFile(join(__dirname, 'tests', 'a.yaml'), 'request: { url: /x }')[0]), "isn't a policy in an APIOps extract");
  });
});

describe('building a run', () => {
  it('puts the policy and its broader scopes in order, through the named product', async () => {
    const { input } = await run('apis/orders/tests/a.yaml', 'policy: operations/create\nproduct: gold\nrequest: { url: /orders }');
    expect(input.scopes.map((s) => [s.kind, s.label, s.file, s.root?.name])).toEqual([
      ['operation', 'operation orders/create', at('apis/orders/operations/create/policy.xml'), 'policies'],
      ['api', 'API orders', at('apis/orders/policy.xml'), 'policies'],
      ['product', 'product gold', at('products/gold/policy.xml'), 'policies'],
      ['global', 'global', at('policy.xml'), 'policies'],
    ]);
    expect(Object.keys(input.fragments)).toEqual(['stamp']);
    expect(input.context).toEqual({
      api: { id: 'orders', name: 'Orders', path: 'orders', serviceUrl: 'https://backend.example.net/api' },
      operation: { id: 'create', name: 'create' },
      product: { id: 'gold', name: 'Gold' },
    });
    expect(input.request).toMatchObject({ url: `${TEST_HOST}/orders/orders`, backendUrl: 'https://backend.example.net/api/orders' });
  });

  it('has a product with no policy as base, and its id as its name', async () => {
    const { input } = await run('apis/orders/tests/a.yaml', 'product: silver\nrequest: { url: /x }');
    expect(input.scopes[1]).toMatchObject({ kind: 'product', root: undefined });
    expect(input.context?.product).toEqual({ id: 'silver', name: 'silver' });
  });

  it('needs the product when an API is in several, and one it is in', async () => {
    await rejects(run('apis/orders/tests/a.yaml', 'request: { url: /x }'), 'is in products gold, silver: say which');
    await rejects(run('apis/orders/tests/a.yaml', 'product: bronze\nrequest: { url: /x }'), "isn't in product bronze; it's in gold, silver");
  });

  it('runs the global policy alone, with plain named values and the test on top', async () => {
    const { input } = await run('tests/a.yaml', 'namedValues: { extra: x }\nrequest: { url: https://h/ }');
    expect(input.scopes.map((s) => s.kind)).toEqual(['global']);
    expect(input.namedValues).toEqual({ 'tenant-name': 'contoso', extra: 'x' });
    expect(input.request.backendUrl).toBeUndefined();
  });

  it("runs a fragment alone, in the test's section, forwarding when there's a backend", async () => {
    const { input } = await run('policyFragments/stamp/tests/a.yaml', 'variables: { tenant: t }\nrequest: { url: https://h/ }\nbackend: { status: 200 }');
    expect(input.scopes).toHaveLength(1);
    expect(input.scopes[0].root?.children?.map((c) => [c.name, c.children?.[0]?.name])).toEqual([
      ['inbound', 'include-fragment'],
      ['backend', 'forward-request'],
    ]);
    expect(input.variables).toEqual({ tenant: 't' });
    const out = await run('policyFragments/stamp/tests/a.yaml', 'section: outbound\nrequest: { url: https://h/ }');
    expect(out.input.scopes[0].root?.children?.map((c) => c.name)).toEqual(['outbound']);
  });

  it("turns away a fragment test where there's no fragment", async () => {
    const t = parseTestFile(at('policyFragments/gone/tests/a.yaml'), 'request: { url: /x }')[0];
    const located = await locate(t);
    await rejects(buildRun(t, new Project(located.root), located), "There's no fragment gone");
  });

  it('reads body files beside the test, and says when one is missing', async () => {
    const t = test('apis/orders/tests/a.yaml', 'request: { url: /x }');
    expect(await bodyText({ file: 'data/order.json' }, t)).toContain('"id": 42');
    expect(await bodyText({ json: { a: 1 } }, t)).toBe('{"a":1}');
    expect(await bodyText(undefined, t)).toBeUndefined();
    await rejects(bodyText({ file: 'data/none.json' }, t), "Body file data/none.json isn't there");
  });
});

describe('the request', () => {
  const t = (url: string) => test('apis/orders/tests/a.yaml', `request: { url: "${url}" }`);
  it('puts a path under the API on the test host, and maps it to the service URL', () => {
    expect(requestFor(t('/a/b?c=1'), { api: { path: '/orders/', serviceUrl: 'https://b.example/api/' } })).toMatchObject({
      url: `${TEST_HOST}/orders/a/b?c=1`,
      backendUrl: 'https://b.example/api/a/b?c=1',
    });
    expect(requestFor(t('/'), { api: { path: 'orders', serviceUrl: 'https://b.example/api' } }).backendUrl).toBe('https://b.example/api');
    expect(requestFor(t('https://elsewhere.example/x'), { api: { path: 'orders', serviceUrl: 'https://b.example/api' } }).backendUrl).toBe('https://b.example/api/x');
    expect(requestFor(t('/x'), {}).url).toBe(`${TEST_HOST}/x`);
  });
});

describe('the project', () => {
  it('reads each policy once, and treats a broken information file as none', async () => {
    const reads: string[] = [];
    const files = { read: (p: string) => (reads.push(p), p.endsWith('apiInformation.json') ? Promise.resolve('{ broken') : nodeFiles.read(p)), folders: (p: string) => nodeFiles.folders(p) };
    const project = new Project(root, files);
    await project.doc(at('policy.xml'));
    await project.doc(at('policy.xml'));
    expect(reads.filter((p) => p === at('policy.xml'))).toHaveLength(1);
    expect(await project.json(at('apis/orders/apiInformation.json'))).toBeUndefined();
    expect(await nodeFiles.read(at('nothing.txt'))).toBeUndefined();
    expect(await nodeFiles.folders(at('nothing'))).toEqual([]);
    await expect(nodeFiles.read('\u0000bad')).rejects.toThrow();
  });
});

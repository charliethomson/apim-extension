import { describe, expect, it } from 'vitest';
import { type Document, parse } from '@charliethomson/apim-document';
import { ExtractReader, type ExtractFiles, productApis, scopeChains } from '../src/extract';
import { policyXml } from './memory';

/** An extract held in memory: file text by absolute path. */
function files(text: Record<string, string>): ExtractFiles & { textReads: number } {
  const f = {
    textReads: 0,
    policy: (path: string) => Promise.resolve<Document | undefined>(text[path] === undefined ? undefined : parse(text[path])),
    text: (path: string) => {
      f.textReads++;
      return Promise.resolve(text[path]);
    },
    folders: (path: string) => {
      const prefix = `${path}/`;
      return Promise.resolve([...new Set(Object.keys(text).filter((k) => k.startsWith(prefix) && k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length).split('/')[0]))]);
    },
  };
  return f;
}

const sets = (doc: Document | undefined) => doc?.root?.children.flatMap((s) => (s.type === 'element' ? s.children : [])).flatMap((n) => (n.type === 'element' && n.name === 'set-variable' ? [n.attributes.find((a) => a.name === 'name')?.value] : []));

describe('an extract on disk', () => {
  const extract = files({
    '/r/policy.xml': policyXml('<set-variable name="tenant" value="t" />'),
    '/r/products/gold/policy.xml': policyXml('<set-variable name="tier" value="gold" />'),
    '/r/products/gold/apis.json': '["echo", "orders"]',
    '/r/products/silver/apis.json': '[{ "name": "echo" }]',
    '/r/products/empty/productInformation.json': '{}',
    '/r/apis/echo/policy.xml': policyXml('<set-variable name="api" value="echo" />'),
  });

  it("reads an API's products from every product's apis.json, once", async () => {
    const reader = new ExtractReader('/r', extract);
    expect(await reader.productsOf('echo')).toEqual(['gold', 'silver']);
    expect(await reader.productsOf('orders')).toEqual(['gold']);
    expect(await reader.productsOf('none')).toEqual([]);
    expect(extract.textReads).toBe(3);
    reader.forgetProducts();
    await reader.productsOf('echo');
    expect(extract.textReads).toBe(6);
  });

  it('builds one chain per product, with each scope\'s policy or none', async () => {
    const chains = await scopeChains({ kind: 'operation', api: 'echo', operation: 'get' }, new ExtractReader('/r', extract));
    expect(chains.map((c) => c.map((l) => [l.scope.kind, sets(l.doc)]))).toEqual([
      [['api', ['api']], ['product', ['tier']], ['global', ['tenant']]],
      [['api', ['api']], ['product', undefined], ['global', ['tenant']]],
    ]);
  });

  it('has no chain around the global policy, and only global around a product', async () => {
    const reader = new ExtractReader('/r', extract);
    expect(await scopeChains({ kind: 'global' }, reader)).toEqual([]);
    expect((await scopeChains({ kind: 'product', product: 'gold' }, reader)).map((c) => c.map((l) => l.scope.kind))).toEqual([['global']]);
    expect(reader.policyPath({ kind: 'fragment', fragment: 'sign' })).toBe('/r/policyFragments/sign/policy.xml');
  });

  it("treats an unreadable apis.json as listing nothing", async () => {
    const broken = { ...extract, text: () => Promise.reject(new Error('locked')) };
    expect(await new ExtractReader('/r', broken).productsOf('echo')).toEqual([]);
  });
});

describe("a product's apis.json", () => {
  it('reads names, name objects and resource ids, and nothing else', () => {
    expect(productApis('["a", {"name": "b"}, {"id": "/subscriptions/s/apis/c"}, 4, null, {}]')).toEqual(['a', 'b', 'c']);
    expect(productApis('{"value": []}')).toEqual([]);
    expect(productApis('not json')).toEqual([]);
  });
});

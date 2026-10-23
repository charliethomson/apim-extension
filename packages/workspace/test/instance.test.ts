import { describe, expect, it, vi } from 'vitest';
import type { Fragment, NamedValue } from '@apim-policy/azure';
import { instancePath, type Scope } from '@apim-policy/core';
import { parse } from '@apim-policy/document';
import { documentScope, type Guard, InstanceReader, type InstanceReads, unknownNamedValues } from '../src/instance';
import { fragmentXml, policyXml } from './memory';

/** An instance whose reads are the given data, each list one promise until `refresh`. */
class FakeInstance implements InstanceReads {
  private lists = new Map<string, Promise<unknown>>();
  readonly policyReads: string[] = [];
  constructor(
    public fragmentList: Fragment[] = [],
    readonly policies: Record<string, string> = {},
    readonly products: Record<string, string[]> = {},
  ) {}
  private once<T>(key: string, value: () => T): Promise<T> {
    if (!this.lists.has(key)) this.lists.set(key, Promise.resolve(value()));
    return this.lists.get(key) as Promise<T>;
  }
  refresh() {
    this.lists.clear();
  }
  fragments = () => this.once('fragments', () => this.fragmentList);
  namedValues = () => Promise.resolve<NamedValue[]>([{ id: 'nv', displayName: 'Key', secret: false }]);
  backends = () => Promise.reject(new Error('backends are down'));
  productsOf = (api: string) => Promise.resolve((this.products[api] ?? []).map((id) => ({ id, displayName: id })));
  policy = (scope: Scope) => {
    const key = instancePath(scope, 'inst');
    this.policyReads.push(key);
    return Promise.resolve(this.policies[key]);
  };
}

const passThrough: Guard = (read, fallback) => read.catch(() => fallback);
const uriOf = (scope: Scope) => `apim-instance://inst${instancePath(scope, 'inst')}`;

describe('reading an instance', () => {
  it('summarises its fragments once per read of the list', async () => {
    const instance = new FakeInstance([{ id: 'sign', xml: fragmentXml(['sig']) }]);
    const reader = new InstanceReader(instance, passThrough, uriOf);
    const first = await reader.fragments();
    expect(first.map((f) => [f.id, f.uri, f.summary.header?.outputs.map((v) => v.name)])).toEqual([['sign', 'apim-instance://inst/inst/fragments/sign.fragment.xml', ['sig']]]);
    expect(await reader.fragments()).toBe(first);
    instance.refresh();
    expect(await reader.fragments()).not.toBe(first);
  });

  it('reads through the guard, which decides what a failure gives', async () => {
    const guard = vi.fn(passThrough);
    const reader = new InstanceReader(new FakeInstance(), guard as Guard, uriOf);
    expect(await reader.backends()).toEqual([]);
    expect((await reader.namedValues()).map((n) => n.displayName)).toEqual(['Key']);
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("places what an API's products and the global policy set, once per parse", async () => {
    const instance = new FakeInstance([], {
      '/inst/global.policy.xml': policyXml('<set-variable name="tenant" value="t" />'),
      '/inst/products/gold.policy.xml': policyXml('<set-variable name="tier" value="gold" />'),
    }, { echo: ['gold'] });
    const reader = new InstanceReader(instance, passThrough, uriOf);
    const doc = parse(policyXml(''));
    const api: Scope = { kind: 'api', api: 'echo' };
    const names = async (d = doc, scope: Scope = api) => [...new Set((await reader.outerVariables('file:///ws/apis/echo/policy.xml', scope, d, () => undefined)).map((o) => o.name))].sort();
    expect(await names()).toEqual(['tenant', 'tier']);
    expect(instance.policyReads).toEqual(['/inst/products/gold.policy.xml', '/inst/global.policy.xml']);
    await names();
    expect(instance.policyReads).toHaveLength(2);
    // A new parse, another scope or an invalidate works it out again.
    await names(parse(policyXml('')));
    await names(doc, { kind: 'product', product: 'gold' });
    reader.invalidate();
    await names();
    expect(instance.policyReads).toHaveLength(2 + 2 + 1 + 2);
  });
});

describe("a document's scope", () => {
  const notRoot = () => false;

  it("is an instance document's from its path, whatever was set by hand", () => {
    expect(documentScope('apim-instance', '/inst/apis/echo.policy.xml', { kind: 'global' }, notRoot)).toEqual({ kind: 'api', api: 'echo' });
    expect(documentScope('apim-edit', '/inst/fragments/sign.fragment.xml', undefined, notRoot)).toEqual({ kind: 'fragment', fragment: 'sign' });
  });

  it("is a workspace file's as set by hand, else from its APIOps path", () => {
    expect(documentScope('file', '/ws/apis/echo/policy.xml', { kind: 'product', product: 'gold' }, notRoot)).toEqual({ kind: 'product', product: 'gold' });
    expect(documentScope('file', '/ws/apis/echo/policy.xml', undefined, notRoot)).toEqual({ kind: 'api', api: 'echo' });
    expect(documentScope('file', '/ws/policy.xml', undefined, (dir) => dir === '/ws')).toEqual({ kind: 'global' });
    expect(documentScope('file', '/ws/elsewhere.xml', undefined, notRoot)).toBeUndefined();
  });
});

describe('named values the instance lacks', () => {
  const doc = parse('<policies><inbound><set-header name="{{Key}}"><value>{{key}} {{missing}}</value></set-header><set-body><![CDATA[{{gone}}]]></set-body></inbound></policies>');

  it('are those used anywhere in the policy, matched ignoring case', () => {
    expect(unknownNamedValues(doc, [{ id: 'nv', displayName: 'KEY', secret: false }])?.map((n) => n.name)).toEqual(['missing', 'gone']);
  });

  it("aren't worked out when nothing was read", () => {
    expect(unknownNamedValues(doc, [])).toBeUndefined();
  });
});

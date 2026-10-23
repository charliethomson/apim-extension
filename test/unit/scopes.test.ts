import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/scanner';
import { chainsFor, instancePath, outerVariables, scopeFromInstancePath, scopeFromPath, scopeKey, scopeLabel, type Scope } from '../../src/policy/scopes';

describe('scopeFromPath', () => {
  it('reads the APIOps layout', () => {
    expect(scopeFromPath('/r/apis/echo/operations/get/policy.xml')).toEqual({ kind: 'operation', api: 'echo', operation: 'get' });
    expect(scopeFromPath('/r/apis/echo/policy.xml')).toEqual({ kind: 'api', api: 'echo' });
    expect(scopeFromPath('/r/products/starter/policy.xml')).toEqual({ kind: 'product', product: 'starter' });
    expect(scopeFromPath('/r/workspaces/team/policy.xml')).toEqual({ kind: 'workspace', workspace: 'team' });
    expect(scopeFromPath('C:\\r\\policyFragments\\sign\\policy.xml')).toEqual({ kind: 'fragment', fragment: 'sign' });
  });

  it('only calls a bare policy.xml global at an extract root, and ignores other files', () => {
    expect(scopeFromPath('/r/policy.xml')).toBeUndefined();
    expect(scopeFromPath('/r/policy.xml', (dir) => dir === '/r')).toEqual({ kind: 'global' });
    expect(scopeFromPath('/r/apis/echo/other.xml')).toBeUndefined();
  });

  it('names scopes', () => {
    const all: Scope[] = [
      { kind: 'global' },
      { kind: 'workspace', workspace: 'w' },
      { kind: 'product', product: 'p' },
      { kind: 'api', api: 'a' },
      { kind: 'operation', api: 'a', operation: 'o' },
      { kind: 'fragment', fragment: 'f' },
    ];
    expect(all.map(scopeLabel)).toEqual(['global', 'workspace w', 'product p', 'API a', 'operation a/o', 'fragment f']);
    expect(new Set(all.map(scopeKey)).size).toBe(all.length);
  });
});

describe('instance document paths', () => {
  it('name each policy for what it is, and read back to the same scope', () => {
    const all: Scope[] = [
      { kind: 'global' },
      { kind: 'workspace', workspace: 'w' },
      { kind: 'product', product: 'starter' },
      { kind: 'api', api: 'echo' },
      { kind: 'operation', api: 'echo', operation: 'get-users' },
      { kind: 'fragment', fragment: 'random-user' },
    ];
    expect(all.map((s) => instancePath(s, 'apim1'))).toEqual([
      '/apim1/global.policy.xml',
      '/apim1/workspaces/w.policy.xml',
      '/apim1/products/starter.policy.xml',
      '/apim1/apis/echo.policy.xml',
      '/apim1/apis/echo/get-users.policy.xml',
      '/apim1/fragments/random-user.fragment.xml',
    ]);
    expect(all.map((s) => scopeFromInstancePath(instancePath(s, 'apim1')))).toEqual(all);
  });

  it('reads nothing from other paths, like the folders above a policy', () => {
    for (const p of ['/apim1', '/apim1/apis', '/apim1/apis/echo', '/apim1/fragments/x.policy.xml', '/apim1/apis/.policy.xml', '/apim1/other/x.policy.xml', '/apim1/apis/a/b/c.policy.xml']) {
      expect(scopeFromInstancePath(p), p).toBeUndefined();
    }
  });
});

describe('chainsFor', () => {
  it('wraps an operation in its API, each product, then global', () => {
    expect(chainsFor({ kind: 'operation', api: 'a', operation: 'o' }, ['p1', 'p2']).map((c) => c.map(scopeLabel))).toEqual([
      ['API a', 'product p1', 'global'],
      ['API a', 'product p2', 'global'],
    ]);
    expect(chainsFor({ kind: 'api', api: 'a' }, []).map((c) => c.map(scopeLabel))).toEqual([['global']]);
    expect(chainsFor({ kind: 'product', product: 'p' }, [])).toEqual([[{ kind: 'global' }]]);
    expect(chainsFor({ kind: 'global' }, [])).toEqual([]);
    expect(chainsFor({ kind: 'fragment', fragment: 'f' }, [])).toEqual([]);
  });
});

describe('outerVariables', () => {
  const GLOBAL: Scope = { kind: 'global' };
  const product = (p: string): Scope => ({ kind: 'product', product: p });
  const policy = (inbound: string, extra = '') => parse(`<policies><inbound>${inbound}</inbound>${extra}</policies>`);
  const names = (xml: string, chains: Parameters<typeof outerVariables>[1], includeSets?: Parameters<typeof outerVariables>[2]) => {
    const doc = parse(xml);
    return outerVariables(doc, chains, includeSets).map((o) => [o.name, xml.slice(0, o.at).split('<').length - 1, scopeLabel(o.scope)]);
  };

  it("places a broader scope's variables right after <base />", () => {
    const xml = '<policies><inbound><set-variable name="mine" value="1" /><base /><set-header name="x" /></inbound></policies>';
    const out = outerVariables(parse(xml), [[{ scope: GLOBAL, doc: policy('<set-variable name="g" value="1" />') }]]);
    expect(out).toEqual([{ name: 'g', at: xml.indexOf('<set-header'), scope: GLOBAL }]);
  });

  it("counts nothing from a section without <base />, and from earlier sections only when they ran", () => {
    const outer = [[{ scope: GLOBAL, doc: policy('<set-variable name="g" value="1" />', '<outbound><set-variable name="o" value="1" /></outbound>') }]];
    expect(names('<policies><inbound><set-header name="x" /></inbound><outbound><base /></outbound></policies>', outer)).toEqual([['o', 6, 'global']]);
    const both = '<policies><inbound><base /></inbound><backend /><outbound><base /></outbound></policies>';
    expect(outerVariables(parse(both), outer).map((o) => o.name).sort()).toEqual(['g', 'g', 'g', 'o']);
  });

  it('walks outward through products to global, stopping where a scope skips <base />', () => {
    const doc = '<policies><inbound><base /></inbound></policies>';
    const g = { scope: GLOBAL, doc: policy('<set-variable name="g" value="1" />') };
    expect(outerVariables(parse(doc), [[{ scope: product('p'), doc: policy('<base /><set-variable name="p" value="1" />') }, g]]).map((o) => o.name)).toEqual(['p', 'g']);
    expect(outerVariables(parse(doc), [[{ scope: product('p'), doc: policy('<set-variable name="p" value="1" />') }, g]]).map((o) => o.name)).toEqual(['p']);
    // A scope with no policy at all behaves as <base />.
    expect(outerVariables(parse(doc), [[{ scope: product('p'), doc: undefined }, g]]).map((o) => o.name)).toEqual(['g']);
  });

  it('keeps only what every product chain sets', () => {
    const doc = '<policies><inbound><base /></inbound></policies>';
    const g = { scope: GLOBAL, doc: policy('<set-variable name="g" value="1" />') };
    const chains = [
      [{ scope: product('a'), doc: policy('<base /><set-variable name="shared" value="1" /><set-variable name="only-a" value="1" />') }, g],
      [{ scope: product('b'), doc: policy('<base /><set-variable name="shared" value="1" />') }, g],
    ];
    expect(outerVariables(parse(doc), chains).map((o) => o.name).sort()).toEqual(['g', 'shared']);
  });

  it("counts top-level sets and includes' outputs, not sets inside a choose or a cache miss", () => {
    const doc = '<policies><inbound><base /></inbound></policies>';
    const outer = policy(
      '<choose><when condition="@(true)"><set-variable name="maybe" value="1" /></when></choose>' +
        '<cache-lookup-value key="k" variable-name="miss" /><cache-lookup-value key="k" variable-name="hit" default-value="" />' +
        '<send-request response-variable-name="resp" /><include-fragment fragment-id="f" /><include-fragment fragment-id="unknown" />',
    );
    expect(outerVariables(parse(doc), [[{ scope: GLOBAL, doc: outer }]], (id) => (id === 'f' ? ['from-f'] : undefined)).map((o) => o.name)).toEqual(['hit', 'resp', 'from-f']);
  });

  it('has nothing to say about a fragment, or without chains', () => {
    expect(outerVariables(parse('<fragment><base /></fragment>'), [[{ scope: GLOBAL, doc: policy('<set-variable name="g" value="1" />') }]])).toEqual([]);
    expect(outerVariables(parse('<policies><inbound><base /></inbound></policies>'), [])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { parse } from '@charliethomson/apim-document';
import { chainsFor, outerVariables } from '../src/scopes';
import { scopeLabel, type Scope } from '@charliethomson/apim-core';

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

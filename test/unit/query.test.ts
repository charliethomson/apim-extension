import { describe, expect, it } from 'vitest';
import { fragmentIdsFor } from '../../src/parser/fragmentIds';
import { nodeAt } from '../../src/parser/query';
import { parse } from '../../src/parser/scanner';

const src = `<policies><inbound>
  <set-header name="X" exists-action="override"><value>@(context.Request.Method)</value></set-header>
  <include-fragment fragment-id="rate-limit" />
  <set-variable name="k" value="{{key}}" />
</inbound></policies>`;
const doc = parse(src);
const at = (needle: string, delta = 1) => nodeAt(doc, src.indexOf(needle) + delta);

describe('nodeAt', () => {
  it('finds element names in start and end tags', () => {
    expect(at('set-header').onElementName).toBe(true);
    expect(at('set-header').element?.name).toBe('set-header');
    expect(at('/set-header>').onElementName).toBe(true);
    expect(at('</inbound>', 3).element?.name).toBe('inbound');
  });

  it('finds attributes and their values', () => {
    const name = at('exists-action');
    expect(name.attribute?.name).toBe('exists-action');
    expect(name.onAttributeName).toBe(true);
    const value = at('rate-limit"');
    expect(value.attribute?.name).toBe('fragment-id');
    expect(value.onAttributeValue).toBe(true);
    expect(value.path.map((e) => e.name)).toEqual(['policies', 'inbound', 'include-fragment']);
  });

  it('finds expressions in text', () => {
    const hit = at('Request');
    expect(hit.expression?.code).toBe('context.Request.Method');
    expect(hit.element?.name).toBe('value');
  });

  it('finds named values', () => {
    expect(at('{{key}}', 3).namedValue?.name).toBe('key');
  });

  it('returns an empty hit outside the document', () => {
    expect(nodeAt(parse('<a/>  '), 5).element).toBeUndefined();
  });
});

describe('fragmentIdsFor', () => {
  it.each([
    ['fragments/rate-limit.policy.xml', ['rate-limit']],
    ['fragments/rate-limit.xml', ['rate-limit']],
    ['policyFragments/rate-limit/policy.xml', ['rate-limit']],
    ['C:\\repo\\policyFragments\\auth\\policy.xml', ['auth']],
    ['policy.xml', []],
  ])('%s', (path, ids) => expect(fragmentIdsFor(path)).toEqual(ids));
});

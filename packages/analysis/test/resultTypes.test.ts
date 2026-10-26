import { describe, expect, it } from 'vitest';
import { parse } from '@charliethomson/apim-document';
import { resultTypes } from '../src/resultTypes';
import { Catalog } from '@charliethomson/apim-catalog';

const catalog = new Catalog({
  policies: [
    {
      name: 'choose',
      description: '',
      sections: [],
      docs: '',
      category: '',
      content: {
        kind: 'children',
        children: [
          {
            name: 'when',
            description: '',
            attributes: [{ name: 'condition', type: 'bool', expressions: true, description: '' }],
            content: { kind: 'policies' },
          },
        ],
      },
    },
    {
      name: 'rate-limit-by-key',
      description: '',
      sections: [],
      docs: '',
      category: '',
      attributes: [{ name: 'calls', type: 'int', expressions: true, description: '' }],
      content: { kind: 'empty' },
    },
  ],
});

describe('resultTypes', () => {
  it('types bool attributes, including on child elements, and leaves the rest untyped', () => {
    const doc = parse('<choose><when condition="@(true)"/></choose><rate-limit-by-key calls="@(5)"/><x>@(1)</x>');
    const types = resultTypes(doc, catalog);
    expect(doc.expressions.map((e) => types.get(e))).toEqual(['bool', undefined, undefined]);
  });

  it("marks set-variable's value, whose type the gateway checks against a list", () => {
    const doc = parse('<set-variable name="a" value="@(1)" /><set-variable name="b" value="plain" />');
    expect(doc.expressions.map((e) => resultTypes(doc, catalog).get(e))).toEqual(['variable']);
  });
});

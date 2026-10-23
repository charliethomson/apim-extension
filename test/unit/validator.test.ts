import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/scanner';
import { Catalog, type PolicyFile } from '../../src/policy/schema';
import { validate } from '../../src/policy/validator';

const ALL = ['inbound', 'backend', 'outbound', 'on-error'] as const;
const value = { name: 'value', description: 'v', content: { kind: 'text' as const, expressions: true } };

/** A small catalog in the shape of data/policies.json, so these tests don't move with the real data. */
const catalog = new Catalog({
  policies: [
    { name: 'base', description: 'b', sections: [...ALL], docs: '', category: '', content: { kind: 'empty' } },
    {
      name: 'set-header',
      description: 'h',
      sections: [...ALL],
      docs: '',
      category: '',
      attributes: [
        { name: 'name', required: true, expressions: true, description: 'n' },
        { name: 'exists-action', enum: ['override', 'skip', 'append', 'delete'], expressions: true, description: 'e' },
      ],
      content: { kind: 'children', children: [value] },
    },
    {
      name: 'set-variable',
      description: 'v',
      sections: [...ALL],
      docs: '',
      category: '',
      attributes: [
        { name: 'name', required: true, description: 'n' },
        { name: 'value', required: true, expressions: true, description: 'v' },
      ],
      content: { kind: 'empty' },
    },
    {
      name: 'choose',
      description: 'c',
      sections: [...ALL],
      docs: '',
      category: '',
      content: {
        kind: 'children',
        children: [
          {
            name: 'when',
            description: 'w',
            min: 1,
            attributes: [{ name: 'condition', required: true, expressions: true, type: 'bool', description: 'c' }],
            content: { kind: 'policies' },
          },
          { name: 'otherwise', description: 'o', max: 1, content: { kind: 'policies' } },
        ],
      },
    },
    {
      name: 'validate-jwt',
      description: 'j',
      sections: ['inbound'],
      docs: '',
      category: '',
      attributes: [
        { name: 'header-name', expressions: true, description: 'h' },
        { name: 'query-parameter-name', expressions: true, description: 'q' },
        { name: 'token-value', expressions: true, description: 't' },
        { name: 'require-scheme', description: 's' },
        { name: 'failed-validation-httpcode', type: 'int', expressions: true, description: 'c' },
      ],
      oneOf: [['header-name', 'query-parameter-name', 'token-value']],
      content: { kind: 'any' },
    },
    { name: 'forward-request', description: 'f', sections: ['backend'], docs: '', category: '', attributes: [{ name: 'buffer-request-body', type: 'bool', description: 'b' }], content: { kind: 'empty' } },
    { name: 'set-method', description: 'm', sections: ['inbound', 'on-error'], docs: '', category: '', content: { kind: 'text', expressions: true } },
    { name: 'mock-response', description: 'm', sections: ['inbound'], docs: '', category: '', content: { kind: 'text' } },
    { name: 'retry', description: 'r', sections: [...ALL], docs: '', category: '', content: { kind: 'policies', exclude: ['wait'] } },
    { name: 'wait', description: 'w', sections: [...ALL], docs: '', category: '', content: { kind: 'policies', only: ['choose'] } },
    {
      name: 'include-fragment',
      description: 'i',
      sections: [...ALL],
      docs: '',
      category: '',
      attributes: [{ name: 'fragment-id', required: true, description: 'f' }],
      content: { kind: 'empty' },
    },
  ],
} satisfies PolicyFile);

function check(xml: string) {
  const doc = parse(xml);
  return validate(doc, catalog).map((d) => ({ code: d.code, at: xml.slice(d.range.start, d.range.end), severity: d.severity }));
}

const codes = (xml: string) => check(xml).map((d) => d.code);
const inSection = (section: string, body: string) => `<policies><${section}>${body}</${section}></policies>`;

describe('validate', () => {
  it('accepts a well-formed policy document', () => {
    expect(
      check(`<policies>
  <inbound>
    <base />
    <set-header name="X" exists-action="override"><value>@(context.RequestId)</value></set-header>
    <choose>
      <when condition="@(true)"><set-variable name="a" value="1" /></when>
      <otherwise />
    </choose>
    <validate-jwt header-name="Authorization" failed-validation-httpcode="401" />
  </inbound>
  <backend><forward-request buffer-request-body="true" /></backend>
  <outbound><base /></outbound>
  <on-error><set-method>GET</set-method></on-error>
</policies>`),
    ).toEqual([]);
  });

  it('requires a policies or fragment root', () => {
    expect(codes('')).toEqual(['invalid-root']);
    expect(check('<xml/>')).toEqual([{ code: 'invalid-root', at: 'xml', severity: 'error' }]);
  });

  it('only allows sections directly under policies, once each', () => {
    expect(check('<policies><base/><foo/></policies>').map((d) => [d.code, d.at])).toEqual([
      ['unexpected-element', 'base'],
      ['unexpected-element', 'foo'],
    ]);
    expect(codes('<policies><inbound/><inbound/></policies>')).toEqual(['duplicate-section']);
  });

  it('flags unknown policies', () => {
    expect(check(inSection('inbound', '<bogus/>'))).toEqual([{ code: 'unknown-policy', at: 'bogus', severity: 'error' }]);
  });

  it('flags a policy in the wrong section, including when nested', () => {
    expect(codes(inSection('outbound', '<validate-jwt header-name="a"/>'))).toEqual(['wrong-section']);
    expect(codes(inSection('inbound', '<choose><when condition="@(true)"><forward-request/></when></choose>'))).toEqual([
      'wrong-section',
    ]);
  });

  it('flags misplaced section tags', () => {
    expect(codes(inSection('inbound', '<outbound/>'))).toEqual(['misplaced-section']);
  });

  it('flags missing required attributes', () => {
    expect(check(inSection('inbound', '<set-variable value="1"/>'))).toEqual([
      { code: 'missing-attribute', at: 'set-variable', severity: 'error' },
    ]);
  });

  it('enforces one-of attribute groups', () => {
    expect(codes(inSection('inbound', '<validate-jwt/>'))).toEqual(['one-of-attributes']);
    expect(check(inSection('inbound', '<validate-jwt header-name="a" token-value="b"/>')).map((d) => d.at)).toEqual([
      'token-value',
    ]);
  });

  it('warns on unknown attributes but allows id and xmlns', () => {
    expect(check(inSection('inbound', '<base foo="1" id="x" xmlns:a="u"/>'))).toEqual([
      { code: 'unknown-attribute', at: 'foo', severity: 'warning' },
    ]);
  });

  it('checks enum and typed literals, skipping expressions and named values', () => {
    expect(check(inSection('inbound', '<set-header name="a" exists-action="replace"/>')).map((d) => [d.code, d.at])).toEqual([
      ['invalid-value', 'replace'],
    ]);
    expect(codes(inSection('inbound', '<set-header name="a" exists-action="@(&quot;skip&quot;)"/>'))).toEqual([]);
    expect(codes(inSection('inbound', '<set-header name="a" exists-action="{{mode}}"/>'))).toEqual([]);
    expect(codes(inSection('backend', '<forward-request buffer-request-body="yes"/>'))).toEqual(['invalid-value']);
    expect(codes(inSection('inbound', '<validate-jwt header-name="a" failed-validation-httpcode="4o1"/>'))).toEqual([
      'invalid-value',
    ]);
  });

  it('warns on expressions where they are not accepted', () => {
    expect(check(inSection('inbound', '<validate-jwt header-name="a" require-scheme="@(1)"/>'))).toEqual([
      { code: 'expression-not-allowed', at: '@(1)', severity: 'warning' },
    ]);
    expect(codes(inSection('inbound', '<mock-response>@(1)</mock-response>'))).toEqual(['expression-not-allowed']);
  });

  it('checks child elements, counts and required children', () => {
    expect(codes(inSection('inbound', '<choose><otherwise/></choose>'))).toEqual(['missing-element']);
    expect(codes(inSection('inbound', '<choose><when condition="@(true)"/><otherwise/><otherwise/></choose>'))).toEqual([
      'too-many-elements',
    ]);
    expect(check(inSection('inbound', '<set-header name="a"><values/></set-header>')).map((d) => [d.code, d.at])).toEqual([
      ['unexpected-element', 'values'],
    ]);
    expect(codes(inSection('inbound', '<set-method><x/></set-method>'))).toEqual(['unexpected-element']);
  });

  it('warns on content where an element should be empty or hold only elements', () => {
    expect(check(inSection('inbound', '<base>x</base>'))).toEqual([{ code: 'unexpected-content', at: 'x', severity: 'warning' }]);
    expect(check(inSection('inbound', ' stray '))).toEqual([{ code: 'unexpected-content', at: 'stray', severity: 'warning' }]);
    expect(codes(inSection('inbound', '<base><!-- ok --></base>'))).toEqual([]);
  });

  it('applies only/exclude constraints on nested policies', () => {
    expect(codes(inSection('inbound', '<retry><wait/></retry>'))).toEqual(['policy-not-allowed-here']);
    expect(codes(inSection('inbound', '<wait><base/></wait>'))).toEqual(['policy-not-allowed-here']);
  });

  it('warns when backend holds more than one policy', () => {
    expect(check(inSection('backend', '<base/><forward-request/>'))).toEqual([
      { code: 'backend-multiple', at: 'forward-request', severity: 'warning' },
    ]);
  });

  describe('fragments', () => {
    it('accepts policies from any section', () => {
      expect(codes('<fragment><validate-jwt header-name="a"/><forward-request/></fragment>')).toEqual([]);
    });

    it('rejects sections, base and include-fragment', () => {
      expect(codes('<fragment><inbound/><base/><include-fragment fragment-id="x"/></fragment>')).toEqual([
        'fragment-section',
        'fragment-base',
        'nested-fragment',
      ]);
    });

    it('applies nested-fragment rules inside nested policies too', () => {
      expect(codes('<fragment><choose><when condition="@(true)"><include-fragment fragment-id="x"/></when></choose></fragment>')).toEqual([
        'nested-fragment',
      ]);
    });
  });
});

describe('validate with the bundled catalog', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { catalog: real } = await import('../../src/policy/catalog');
  const run = (file: string) =>
    validate(parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', file), 'utf8')), real).map((d) => d.code);

  it.each([
    'raw/echo.policy.xml',
    'escaped/echo.policy.xml',
    'raw/tricky.policy.xml',
    'fragments/auth-headers.xml',
    'apiops/apis/echo/policy.xml',
    'apiops/apis/random-users/policy.xml',
    'apiops/policyFragments/rate-limit/policy.xml',
    'apiops/policyFragments/random-user/policy.xml',
  ])('%s is valid', (file) => {
    expect(run(file)).toEqual([]);
  });

  it('flags the broken fixtures', () => {
    expect(run('fragments/bad-fragment.xml')).toEqual(['fragment-section', 'nested-fragment']);
    expect(run('raw/broken.policy.xml')).toEqual(['unknown-policy', 'wrong-section']);
  });

  it('knows every policy the docs index lists', () => {
    expect(real.names.length).toBeGreaterThanOrEqual(60);
    for (const name of ['set-header', 'choose', 'include-fragment', 'base', 'llm-token-limit', 'validate-jwt']) {
      expect(real.get(name), name).toBeDefined();
    }
  });
});

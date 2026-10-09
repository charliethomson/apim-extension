import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateShadow, methodAt } from '../../src/csharp/shadow';
import { parse } from '../../src/parser/scanner';
import { Catalog } from '../../src/policy/schema';

const fixture = (p: string) => readFileSync(join(__dirname, '..', 'fixtures', p), 'utf8');

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

describe('generateShadow', () => {
  for (const file of [
    'raw/echo.policy.xml',
    'escaped/echo.policy.xml',
    'raw/tricky.policy.xml',
    'apiops/policyFragments/random-user-pipeline/policy.xml',
    'apiops/apis/random-users/policy.xml',
  ]) {
    it(`maps every generated code character back to the policy (${file})`, () => {
      const doc = parse(fixture(file));
      const shadow = generateShadow(doc, catalog);
      expect(shadow.methods).toHaveLength(doc.expressions.length);
      for (const m of shadow.methods) {
        const code = shadow.text.slice(m.codeRange.start, m.codeRange.end);
        if (m.expression.namedValues.length === 0) expect(code).toBe(m.expression.code);
        for (let g = m.codeRange.start; g < m.codeRange.end; g++) {
          const src = shadow.map.toSource(g)!;
          expect(src).toBeGreaterThanOrEqual(m.expression.codeRange.start);
          expect(src).toBeLessThanOrEqual(m.expression.codeRange.end);
        }
        expect(shadow.map.toSource(m.codeRange.start)).toBe(m.expression.codeRange.start);
        expect(shadow.map.toSource(m.codeRange.end)).toBe(m.expression.codeRange.end);
      }
    });
  }

  it('round-trips document positions inside expressions', () => {
    const doc = parse(fixture('escaped/echo.policy.xml'));
    const shadow = generateShadow(doc, catalog);
    const at = doc.source.indexOf('GetValueOrDefault');
    const gen = shadow.map.toGenerated(at)!;
    expect(shadow.text.startsWith('GetValueOrDefault', gen)).toBe(true);
    expect(methodAt(shadow, gen)?.expression.codeRange.start).toBeLessThan(at);
    expect(shadow.map.toSource(gen)).toBe(at);
  });

  it('leaves scaffolding unmapped', () => {
    const shadow = generateShadow(parse('<a x="@(1)"/>'), undefined);
    expect(shadow.map.toSource(0)).toBeUndefined();
    expect(methodAt(shadow, 0)).toBeUndefined();
  });

  it('wraps expressions and blocks in methods taking context', () => {
    const shadow = generateShadow(parse('<a x="@(1)">@{ return 2; }</a>'), undefined);
    expect(shadow.text).toContain('static object __E0(IProxyRequestContext context) =>\n        1;');
    expect(shadow.text).toContain('static object __E1(IProxyRequestContext context)\n    { return 2; }');
    expect(shadow.text).toContain('using Apim.Policies;');
  });

  it('types bool attributes from the catalog and leaves the rest as object', () => {
    const shadow = generateShadow(
      parse('<choose><when condition="@(true)"/></choose><rate-limit-by-key calls="@(5)"/>'),
      catalog,
    );
    expect(shadow.methods.map((m) => m.returnType)).toEqual(['bool', 'object']);
  });

  it('places header, prelude and footer', () => {
    const shadow = generateShadow(parse('<a x="@(1)"/>'), undefined, {
      header: '#:package X@1',
      prelude: 'return;',
      footer: 'class Stub {}',
      sourceName: 'a.xml',
    });
    const t = shadow.text;
    expect(t.indexOf('#:package X@1')).toBeLessThan(t.indexOf('using System;'));
    expect(t.indexOf('return;')).toBeGreaterThan(t.indexOf('using Apim.Policies;'));
    expect(t.indexOf('return;')).toBeLessThan(t.indexOf('static class'));
    expect(t.trimEnd().endsWith('class Stub {}')).toBe(true);
    expect(t).toContain('from a.xml');
  });

  it('keeps a hostile source path on the comment line', () => {
    for (const brk of ['\n', '\r', '\u0085', '\u2028', '\u2029']) {
      const shadow = generateShadow(parse('<a x="@(1)"/>'), undefined, {
        header: '#:package X@1',
        sourceName: `policies/x${brk}#:sdk Evil.Sdk@6.6.6${brk}// .policy.xml`,
      });
      const lines = shadow.text.split(/\r\n|[\r\n\u0085\u2028\u2029]/);
      expect(lines.filter((l) => l.startsWith('#:'))).toEqual(['#:package X@1']);
    }
  });

  it('rewrites named values in code but not in strings or comments', () => {
    const src = '<a x="@({{n}} + &quot;{{s}}&quot; /* {{c}} */)"/>';
    const doc = parse(src);
    const shadow = generateShadow(doc, undefined);
    const m = shadow.methods[0];
    const code = shadow.text.slice(m.codeRange.start, m.codeRange.end);
    expect(code).toBe('NamedValues.Get("n") + "{{s}}" /* {{c}} */');
    // Anywhere inside the rewritten call maps onto the {{n}} token.
    const r = shadow.map.rangeToSource({ start: m.codeRange.start + 3, end: m.codeRange.start + 5 })!;
    expect(src.slice(r.start, r.end)).toBe('{{n}}');
    // Text after the call still maps exactly.
    const plus = code.indexOf('+');
    expect(src[shadow.map.toSource(m.codeRange.start + plus)!]).toBe('+');
  });
});

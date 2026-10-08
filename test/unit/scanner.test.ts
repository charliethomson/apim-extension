import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Document, Element, Node } from '../../src/parser/ast';
import { parse } from '../../src/parser/scanner';

const fixture = (p: string) => readFileSync(join(__dirname, '..', 'fixtures', p), 'utf8');

function elements(nodes: Node[], out: Element[] = []): Element[] {
  for (const n of nodes) {
    if (n.type === 'element') {
      out.push(n);
      elements(n.children, out);
    }
  }
  return out;
}

const byName = (doc: Document, name: string) => elements(doc.children).filter((e) => e.name === name);
const attr = (el: Element, name: string) => el.attributes.find((a) => a.name === name);
const slice = (doc: Document, r: { start: number; end: number }) => doc.source.slice(r.start, r.end);

describe('parse: raw format', () => {
  const doc = parse(fixture('raw/echo.policy.xml'));

  it('parses without diagnostics', () => {
    expect(doc.diagnostics).toEqual([]);
  });

  it('builds the element tree', () => {
    expect(doc.root?.name).toBe('policies');
    expect(doc.root?.children.filter((c) => c.type === 'element').map((c) => (c as Element).name)).toEqual([
      'inbound',
      'backend',
      'outbound',
      'on-error',
    ]);
    const when = byName(doc, 'when')[0];
    expect(byName(doc, 'set-header').length).toBe(3);
    expect(elements(when.children).map((e) => e.name)).toEqual(['set-header', 'value']);
  });

  it('finds an attribute expression containing quotes', () => {
    const a = attr(byName(doc, 'set-variable')[0], 'value')!;
    expect(a.expression?.kind).toBe('expr');
    expect(a.expression?.code).toBe('context.Request.Method == "POST"');
    expect(slice(doc, a.valueRange!)).toBe('@(context.Request.Method == "POST")');
  });

  it('keeps && and generics inside an attribute expression', () => {
    const cond = attr(byName(doc, 'when')[0], 'condition')!;
    expect(cond.expression?.code).toContain('&& context.Variables.GetValueOrDefault<bool>("isPost")');
  });

  it('finds a block in element text, with < and "}" inside', () => {
    const body = byName(doc, 'set-body')[0];
    const text = body.children[0];
    expect(text.type).toBe('text');
    if (text.type !== 'text') return;
    expect(text.expression?.kind).toBe('block');
    expect(text.expression?.code).toContain('id.Length < 10');
    expect(text.expression?.code.trim().endsWith('return body.ToString();')).toBe(true);
    expect(body.endTag).toBeDefined();
  });

  it('records named values inside expressions with document ranges', () => {
    const nv = doc.expressions.flatMap((e) => e.namedValues);
    expect(nv.map((n) => n.name)).toEqual(['backend-token']);
    expect(slice(doc, nv[0].range)).toBe('{{backend-token}}');
  });

  it('maps every expression character back to the same document character', () => {
    for (const e of doc.expressions) {
      for (let i = 0; i < e.code.length; i++) {
        expect(doc.source[e.map.toSource(i)!]).toBe(e.code[i]);
      }
      expect(e.map.toSource(0)).toBe(e.codeRange.start);
      expect(e.map.toSource(e.code.length)).toBe(e.codeRange.end);
    }
  });

  it('does not treat literal attribute values as expressions', () => {
    const rw = byName(doc, 'rewrite-uri')[0];
    expect(attr(rw, 'template')?.expression).toBeUndefined();
    expect(attr(rw, 'template')?.value).toBe('/v2/{id}');
  });
});

describe('parse: escaped format', () => {
  const raw = parse(fixture('raw/echo.policy.xml'));
  const esc = parse(fixture('escaped/echo.policy.xml'));

  it('parses without diagnostics', () => {
    expect(esc.diagnostics).toEqual([]);
  });

  it('decodes to the same C# as the raw format', () => {
    expect(esc.expressions.map((e) => e.code)).toEqual(raw.expressions.map((e) => e.code));
  });

  it('maps decoded characters onto entities in the source', () => {
    const e = esc.expressions[0];
    const q = e.code.indexOf('"');
    expect(slice(esc, e.map.rangeToSource({ start: q, end: q + 1 })!)).toBe('&quot;');
    const p = e.code.indexOf('POST');
    expect(slice(esc, e.map.rangeToSource({ start: p, end: p + 4 })!)).toBe('POST');
  });
});

describe('parse: tricky expressions', () => {
  const doc = parse(fixture('raw/tricky.policy.xml'));
  const values = Object.fromEntries(
    byName(doc, 'set-variable').map((el) => [attr(el, 'name')!.value!, attr(el, 'value')!]),
  );

  it('parses without diagnostics', () => {
    expect(doc.diagnostics).toEqual([]);
  });

  it.each([
    ['a', 'string.Join(")", new[] { "(", "}", "{" })'],
    ['b', `context.Request.Url.Path.Split('/').Last() + ')' + '"'`],
    ['c', '@"C:\\temp\\" + @"say ""hi"")"'],
    ['e', '$@"{{literal}} {context.Api.Name} ""q"" }}"'],
    ['f', 'context.Request.Headers.ContainsKey("X-\'Single\'") ? 1 : 0'],
    ['g', 'new Dictionary<string, List<int>>() { { "k", new List<int> { 1, 2 } } }.Count'],
  ])('expression %s', (name, code) => {
    expect(values[name].expression?.code).toBe(code);
  });

  it('handles interpolation with nested ternaries and format specifiers', () => {
    expect(values.d.expression?.code.endsWith('{context.Timestamp:yyyy-MM-dd}"')).toBe(true);
  });

  it('handles lambdas with nested strings', () => {
    expect(values.h.expression?.code.endsWith('.Count()')).toBe(true);
  });

  it('does not end a block at "</set-body>" inside a string', () => {
    const bodies = byName(doc, 'set-body');
    expect(bodies).toHaveLength(2);
    const text = bodies[0].children[0];
    expect(text.type === 'text' && text.expression?.code).toContain('return x.ToString() + sq(3);');
  });

  it('finds an expression in CDATA without decoding entities', () => {
    const cdata = byName(doc, 'set-body')[1].children[0];
    expect(cdata.type).toBe('cdata');
    if (cdata.type !== 'cdata') return;
    expect(cdata.expression?.code).toBe(' return "<raw> & \\"cdata\\""; ');
    expect(cdata.expression?.map.toSource(1)).toBe(cdata.expression!.codeRange.start + 1);
  });
});

describe('parse: large APIOps fragment and caller', () => {
  it.each(['apiops/policyFragments/random-user-pipeline/policy.xml', 'apiops/apis/random-users/policy.xml'])(
    '%s parses cleanly and every expression is closed where its attribute or element ends',
    (file) => {
      const doc = parse(fixture(file));
      expect(doc.diagnostics).toEqual([]);
      expect(doc.expressions.length).toBeGreaterThan(5);
      for (const e of doc.expressions) {
        const after = doc.source.slice(e.range.end).trimStart()[0];
        expect(['"', "'", '<'], doc.source.slice(e.range.start, e.range.start + 60)).toContain(after);
      }
    },
  );
});

describe('parse: error recovery', () => {
  const doc = parse(fixture('raw/broken.policy.xml'));
  const codes = doc.diagnostics.map((d) => d.code);

  it('reports each broken expression once, on its own line', () => {
    expect(codes).toEqual(['unterminated-expression', 'unterminated-expression', 'unterminated-expression']);
    const lines = doc.diagnostics.map((d) => doc.source.slice(0, d.range.start).split('\n').length);
    expect(lines).toEqual([3, 6, 8]);
  });

  it('salvages the value of an attribute whose expression is broken', () => {
    expect(attr(byName(doc, 'set-variable')[0], 'value')?.value).toBe('@(context.Request.Method == "POST"');
    expect(byName(doc, 'set-variable')[2].selfClosing).toBe(true);
  });

  it('keeps going and finds the elements after each error', () => {
    const names = elements(doc.children).map((e) => e.name);
    expect(names).toEqual([
      'policies',
      'inbound',
      'set-variable',
      'set-variable',
      'set-header',
      'value',
      'set-variable',
      'bogus-policy',
      'outbound',
      'validate-jwt',
    ]);
    expect(attr(byName(doc, 'set-variable')[1], 'value')?.value).toBe('ok');
  });

  it('closes elements properly after recovery', () => {
    expect(byName(doc, 'set-header')[0].endTag).toBeDefined();
    expect(byName(doc, 'inbound')[0].endTag).toBeDefined();
    expect(doc.root?.endTag).toBeDefined();
  });
});

describe('parse: XML structure', () => {
  it('handles comments, declarations, self-closing and single-quoted attributes', () => {
    const doc = parse(`<?xml version="1.0"?>\n<!-- c --><a x='1' y="2"><b/></a>`);
    expect(doc.diagnostics).toEqual([]);
    expect(doc.children.map((n) => n.type)).toEqual(['declaration', 'text', 'comment', 'element']);
    expect(doc.root?.attributes.map((a) => [a.name, a.value])).toEqual([
      ['x', '1'],
      ['y', '2'],
    ]);
    expect(byName(doc, 'b')[0].selfClosing).toBe(true);
  });

  it('reports missing end tags and closes the element at the parent end tag', () => {
    const doc = parse('<a><b><c></a>');
    expect(doc.diagnostics.map((d) => d.code)).toEqual(['missing-end-tag', 'missing-end-tag']);
    expect(doc.root?.endTag).toBeDefined();
  });

  it('reports a stray end tag', () => {
    const doc = parse('<a></b></a>');
    expect(doc.diagnostics.map((d) => d.code)).toEqual(['unexpected-end-tag']);
  });

  it('reports unclosed elements at the end of input', () => {
    const doc = parse('<a><b>');
    expect(doc.diagnostics.map((d) => d.code)).toEqual(['missing-end-tag', 'missing-end-tag']);
  });

  it('reports multiple roots', () => {
    expect(parse('<a/><b/>').diagnostics.map((d) => d.code)).toEqual(['multiple-roots']);
  });

  it('reports unescaped < in text', () => {
    const doc = parse('<a>1 < 2</a>');
    expect(doc.diagnostics.map((d) => d.code)).toEqual(['unescaped-lt']);
    expect(doc.root?.endTag).toBeDefined();
  });

  it('reports attribute problems', () => {
    const codes = (s: string) => parse(s).diagnostics.map((d) => d.code);
    expect(codes('<a x/>')).toEqual(['attribute-without-value']);
    expect(codes('<a x=1/>')).toEqual(['unquoted-attribute']);
    expect(codes('<a x="1" x="2"/>')).toEqual(['duplicate-attribute']);
    expect(codes('<a x="1/>\n<b/>')).toContain('unterminated-attribute');
    expect(codes('<a $/>')).toEqual(['unexpected-character']);
    expect(codes('<a x="1"')).toEqual(['unterminated-tag']);
  });

  it('reports unterminated comments, CDATA and declarations', () => {
    expect(parse('<a><!-- x').diagnostics.map((d) => d.code)).toContain('unterminated-comment');
    expect(parse('<a><![CDATA[ x').diagnostics.map((d) => d.code)).toContain('unterminated-cdata');
    expect(parse('<?xml ').diagnostics.map((d) => d.code)).toEqual(['unterminated-declaration']);
  });

  it('reports a missing quote after an attribute expression and resyncs', () => {
    const doc = parse('<a x="@(1) junk" y="2"/>');
    expect(doc.diagnostics.map((d) => d.code)).toEqual(['expected-quote-after-expression']);
    expect(doc.root?.attributes.map((a) => [a.name, a.value])).toEqual([
      ['x', '@(1) junk'],
      ['y', '2'],
    ]);
    expect(doc.root?.attributes[0].expression?.code).toBe('1');
  });

  it('stops an expression at an end tag', () => {
    const doc = parse('<a><b>@(1 + </b></a>');
    expect(doc.diagnostics.map((d) => d.code)).toEqual(['unterminated-expression']);
    expect(doc.root?.endTag).toBeDefined();
  });

  it('reports text after an expression', () => {
    const doc = parse('<a>@(1) extra</a>');
    expect(doc.diagnostics.map((d) => [d.code, slice(doc, d.range)])).toEqual([['text-after-expression', 'extra']]);
  });

  it('reports an unterminated end tag', () => {
    expect(parse('<a></a').diagnostics.map((d) => d.code)).toEqual(['unterminated-tag']);
  });

  it('finds named values in plain attributes and text', () => {
    const doc = parse('<a x="{{one}}/{{two}}">{{three}}</a>');
    expect(doc.root?.attributes[0].namedValues.map((n) => n.name)).toEqual(['one', 'two']);
    const t = doc.root?.children[0];
    expect(t?.type === 'text' && t.namedValues.map((n) => n.name)).toEqual(['three']);
  });

  it('allows whitespace before an expression in a value', () => {
    const doc = parse('<a x=" @(1)">\n  @{ return 1; }\n</a>');
    expect(doc.diagnostics).toEqual([]);
    expect(doc.expressions.map((e) => e.kind)).toEqual(['expr', 'block']);
  });

  it('never throws on arbitrary input', () => {
    const samples = ['', '<', '<<', '</', '@(', '<a x="@(', '<a>@{', '<a x=">', '<![CDATA[@(', '&', '<a>&quot;@(</a>'];
    for (const s of samples) expect(() => parse(s), s).not.toThrow();
  });
});

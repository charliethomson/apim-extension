import { describe, expect, it } from 'vitest';
import { parse } from '@apim-policy/document';
import { toRunTree } from '../src/tree';

describe('run trees', () => {
  it('places elements, attributes and expressions, with entities decoded', () => {
    const tree = toRunTree(
      parse('<policies>\n  <inbound>\n    <set-variable name="a&amp;b" value="@(context.Request.Headers.GetValueOrDefault("x", ""))" />\n    <!-- gone -->\n  </inbound>\n</policies>'),
    )!;
    const inbound = tree.children!.find((c) => c.name === 'inbound')!;
    const sv = inbound.children!.find((c) => c.name === 'set-variable')!;
    expect(sv).toMatchObject({ line: 3, col: 5 });
    expect(sv.attrs![0]).toEqual({ name: 'name', value: 'a&b' });
    expect(sv.attrs![1].expr).toEqual({ code: 'context.Request.Headers.GetValueOrDefault("x", "")', multi: false, line: 3, col: 43 });
    expect(inbound.children!.some((c) => c.text?.includes('gone'))).toBe(false);
  });

  it('reads the escaped format and blocks in text', () => {
    const tree = toRunTree(parse('<fragment><set-body>@{\n  return &quot;a&lt;b&quot;;\n}</set-body><set-method>POST</set-method></fragment>'))!;
    const body = tree.children![0].children![0];
    expect(body.expr).toMatchObject({ code: '\n  return "a<b";\n', multi: true, line: 1, col: 23 });
    expect(tree.children![1].children![0]).toMatchObject({ text: 'POST' });
  });

  it('keeps CDATA as written', () => {
    const tree = toRunTree(parse('<fragment><set-body><![CDATA[a &amp; <b>]]></set-body></fragment>'))!;
    expect(tree.children![0].children![0].text).toBe('a &amp; <b>');
  });

  it('has nothing for a document without a root', () => {
    expect(toRunTree(parse('<!-- just a comment -->'))).toBeUndefined();
  });
});

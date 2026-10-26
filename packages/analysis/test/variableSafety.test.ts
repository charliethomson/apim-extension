import { describe, expect, it } from 'vitest';
import { parse } from '@charliethomson/apim-document';
import { fragmentDoc } from '../src/fragmentDoc';
import { emptyValueFor, outputsNotAlwaysSet, unguardedReads } from '../src/variableSafety';

const policy = (inbound: string) => `<policies>\n<inbound>\n${inbound}\n</inbound>\n</policies>`;

/** Names reported, and each fix applied to its expression's source text. */
function lint(xml: string, includeSets: Record<string, string[]> = {}) {
  const doc = parse(xml);
  return unguardedReads(doc, fragmentDoc(doc), (id) => includeSets[id]).map((r) => ({
    name: r.name,
    key: xml.slice(r.range.start, r.range.end),
    fixed: r.fix && xml.slice(r.fix.expression.codeRange.start, r.fix.range.start) + r.fix.code + xml.slice(r.fix.range.end, r.fix.expression.codeRange.end),
  }));
}

describe('unguarded Variables[...] reads', () => {
  it('reports an indexer read of a variable nothing sets, with a GetValueOrDefault rewrite', () => {
    expect(lint(policy(`<set-header name="a"><value>@(context.Variables["x"].ToString())</value></set-header>`))).toEqual([
      { name: 'x', key: 'x', fixed: 'context.Variables.GetValueOrDefault<object>("x").ToString()' },
    ]);
  });

  it("keeps a cast's type, but not when the cast applies to something after the access", () => {
    expect(lint(policy(`<set-header name="a"><value>@("v" + (string)context.Variables["x"])</value></set-header>`))[0].fixed).toBe('"v" + context.Variables.GetValueOrDefault<string>("x")');
    expect(lint(policy(`<set-header name="a"><value>@((JObject)context.Variables["x"])</value></set-header>`))[0].fixed).toBe('context.Variables.GetValueOrDefault<JObject>("x")');
    expect(lint(policy(`<set-header name="a"><value>@((string)context.Variables["x"].ToString())</value></set-header>`))[0].fixed).toBe('(string)context.Variables.GetValueOrDefault<object>("x").ToString()');
  });

  it('leaves GetValueOrDefault, ContainsKey and TryGetValue alone', () => {
    expect(lint(policy(`<set-header name="a"><value>@(context.Variables.GetValueOrDefault<string>("x"))</value></set-header>`))).toEqual([]);
  });

  it('accepts a variable set earlier, outside a choose', () => {
    expect(lint(policy(`<set-variable name="x" value="1" />\n<set-header name="a"><value>@((string)context.Variables["x"])</value></set-header>`))).toEqual([]);
    expect(lint(policy(`<send-request response-variable-name="x" />\n<set-header name="a"><value>@(context.Variables["x"])</value></set-header>`))).toEqual([]);
  });

  it('reports a variable set only later, only inside a choose, or by its own set-variable', () => {
    expect(lint(policy(`<set-header name="a"><value>@(context.Variables["x"])</value></set-header>\n<set-variable name="x" value="1" />`))).toHaveLength(1);
    expect(lint(policy(`<choose><when condition="@(true)"><set-variable name="x" value="1" /></when></choose>\n<set-header name="a"><value>@(context.Variables["x"])</value></set-header>`))).toHaveLength(1);
    expect(lint(policy(`<set-variable name="x" value="@((int)context.Variables[&quot;x&quot;] + 1)" />`))).toHaveLength(1);
  });

  it('counts a set inside a choose branch for reads later in that branch, not in a sibling', () => {
    const branch = (setIn: string, readIn: string) =>
      policy(`<choose><when condition="@(true)">${setIn}${readIn}</when></choose>`);
    expect(lint(branch('<set-variable name="x" value="1" />', '<set-header name="a"><value>@(context.Variables["x"])</value></set-header>'))).toEqual([]);
    expect(lint(policy(`<choose><when condition="@(true)"><set-variable name="x" value="1" /><choose><when condition="@(true)"><set-header name="a"><value>@(context.Variables["x"])</value></set-header></when></choose></when></choose>`))).toEqual([]);
    expect(lint(policy(`<choose><when condition="@(true)"><set-variable name="x" value="1" /></when><otherwise><set-header name="a"><value>@(context.Variables["x"])</value></set-header></otherwise></choose>`))).toHaveLength(1);
  });

  it("sees what a retry's children set from its condition", () => {
    expect(lint(policy(`<retry condition="@(((IResponse)context.Variables[&quot;r&quot;]).StatusCode == 202)" count="3" interval="1"><send-request mode="new" response-variable-name="r" /></retry>`))).toEqual([]);
  });

  it('counts cache-lookup-value only with a default, since a miss sets nothing', () => {
    const read = '<set-header name="a"><value>@(context.Variables["c"])</value></set-header>';
    expect(lint(policy(`<cache-lookup-value key="k" variable-name="c" />${read}`))).toHaveLength(1);
    expect(lint(policy(`<cache-lookup-value key="k" variable-name="c" default-value="" />${read}`))).toEqual([]);
  });

  it('knows the cache idiom: a when on !ContainsKey(x) that sets x leaves x set after the choose', () => {
    const idiom = (body: string) =>
      policy(`<cache-lookup-value key="k" variable-name="t" />\n<choose><when condition="@(!context.Variables.ContainsKey(&quot;t&quot;))">${body}</when></choose>\n<set-header name="a"><value>@((string)context.Variables["t"])</value></set-header>`);
    expect(lint(idiom('<set-variable name="t" value="1" />'))).toEqual([]);
    expect(lint(idiom('<set-variable name="other" value="1" />'))).toHaveLength(1);
  });

  it('accepts a check in the same expression or an enclosing when', () => {
    expect(lint(policy(`<set-header name="a"><value>@(context.Variables.ContainsKey("x") ? context.Variables["x"] : null)</value></set-header>`))).toEqual([]);
    expect(lint(policy(`<choose><when condition="@(context.Variables.ContainsKey(&quot;x&quot;))"><set-header name="a"><value>@(context.Variables["x"])</value></set-header></when></choose>`))).toEqual([]);
    expect(lint(policy(`<set-header name="a"><value>@{ object v; return context.Variables.TryGetValue("x", out v) ? context.Variables["x"] : null; }</value></set-header>`))).toEqual([]);
    expect(lint(policy(`<choose><when condition="@(context.Variables.GetValueOrDefault&lt;string&gt;(&quot;x&quot;) != null)"><set-header name="a"><value>@(context.Variables["x"])</value></set-header></when></choose>`))).toEqual([]);
  });

  it("accepts what an earlier include sets", () => {
    const xml = policy(`<include-fragment fragment-id="f" />\n<set-header name="a"><value>@(context.Variables["x"])</value></set-header>`);
    expect(lint(xml, { f: ['x'] })).toEqual([]);
    expect(lint(xml, { f: ['y'] })).toHaveLength(1);
  });

  it('accepts what a broader scope sets from the point it runs', () => {
    const xml = policy(`<set-header name="a"><value>@(context.Variables["early"])</value></set-header>\n<base />\n<set-header name="b"><value>@(context.Variables["g"])</value></set-header>`);
    const at = xml.indexOf('<base />') + '<base />'.length;
    const doc = parse(xml);
    const reads = unguardedReads(doc, undefined, () => undefined, [{ name: 'g', at }, { name: 'early', at }]);
    expect(reads.map((r) => r.name)).toEqual(['early']);
  });

  it("in a fragment, accepts its required @in and reports an optional one", () => {
    const xml = `<!--\n  @in  needed\n  @in  [maybe]\n-->\n<fragment>\n<set-header name="a"><value>@(context.Variables["needed"] + context.Variables["maybe"])</value></set-header>\n</fragment>`;
    expect(lint(xml).map((r) => r.name)).toEqual(['maybe']);
  });

  it('writes the rewrite as plain C#, which the editor escapes for the escaped format', () => {
    const xml = policy(`<set-variable name="y" value="@((string)context.Variables[&quot;x&quot;])" />`);
    const [r] = unguardedReads(parse(xml), undefined, () => undefined);
    expect(xml.slice(r.range.start, r.range.end)).toBe('x');
    expect(xml.slice(r.fix!.range.start, r.fix!.range.end)).toBe('(string)context.Variables[&quot;x&quot;]');
    expect(r.fix!.code).toBe('context.Variables.GetValueOrDefault<string>("x")');
  });

});

describe('@outs set on every path', () => {
  const check = (body: string, includeSets: Record<string, string[]> = {}) => {
    const doc = parse(`<!--\n  @out a\n  @out b\n-->\n<fragment>\n${body}\n</fragment>`);
    return outputsNotAlwaysSet(doc, fragmentDoc(doc)!, (id) => includeSets[id]).map((v) => v.name);
  };

  it('accepts outputs set up front and overwritten later (the bookkeeping pattern)', () => {
    expect(check('<set-variable name="a" value="" /><set-variable name="b" value="" /><choose><when condition="@(true)"><set-variable name="a" value="1" /></when></choose>')).toEqual([]);
  });

  it('flags an output only some branches set, and one set only without an otherwise', () => {
    expect(check('<set-variable name="b" value="" /><choose><when condition="@(true)"><set-variable name="a" value="1" /></when></choose>')).toEqual(['a']);
    expect(check('<set-variable name="b" value="" /><choose><when condition="@(true)"><set-variable name="a" value="1" /></when><otherwise><set-variable name="b" value="2" /></otherwise></choose>')).toEqual(['a']);
  });

  it('accepts every branch setting it, branches that end with return-response, and includes', () => {
    expect(check('<choose><when condition="@(true)"><set-variable name="a" value="1" /><set-variable name="b" value="1" /></when><otherwise><set-variable name="a" value="2" /><set-variable name="b" value="2" /></otherwise></choose>')).toEqual([]);
    expect(check('<set-variable name="b" value="" /><choose><when condition="@(true)"><return-response /></when></choose><set-variable name="a" value="1" />')).toEqual([]);
    expect(check('<choose><when condition="@(true)"><return-response /></when><otherwise><set-variable name="a" value="1" /><include-fragment fragment-id="f" /></otherwise></choose>', { f: ['b'] })).toEqual([]);
  });

  it("counts a retry's steps, but not a cache lookup without a default; and leaves never-set outputs to the other warning", () => {
    expect(check('<retry condition="@(false)" count="1" interval="1"><set-variable name="a" value="1" /></retry><cache-lookup-value key="k" variable-name="b" />')).toEqual(['b']);
    expect(check('<set-variable name="a" value="1" />')).toEqual([]);
  });

  it('starts an output at an empty value of its type', () => {
    expect(['bool', 'int', 'double', 'decimal', 'JArray', 'JObject', 'string', undefined].map(emptyValueFor)).toEqual(['@(false)', '@(0)', '@(0d)', '@(0m)', '@(new JArray())', '@(new JObject())', '', '']);
  });
});

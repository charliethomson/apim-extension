import { describe, expect, it } from 'vitest';
import type { CSharpEngine } from '@apim-policy/csharp-engine';
import { loadEngine } from '@apim-policy/csharp-engine/testing';
import { parse } from '@apim-policy/document';
import { summarize } from '@apim-policy/analysis';
import { declarationOf, includedFragments, inputLine, typeForTag, valueFor } from '../src/fragments';
import { PolicyIndex } from '../src/policyIndex';
import { ShapeService } from '../src/shapes';
import { fragmentXml, MemoryHost, policyXml } from './memory';

const engine = loadEngine();
const SIGN = 'file:///ws/policyFragments/sign/policy.xml';
const BARE = 'file:///ws/policyFragments/bare/policy.xml';
const CALLER = 'file:///ws/apis/echo/policy.xml';

const typed = `<!--
  Builds a user.

  @typedef {{ id: string, age?: int }} User
  @in  {User} user  Who.
  @in  {string} [mode=a&"b"]  How.
  @in  {Mystery} odd  Something unreadable.
  @in  {string} name  A name.
  @out {JObject} result
-->
<fragment><set-variable name="result" value="@(new JObject { [&quot;id&quot;] = &quot;u&quot; })" /></fragment>
`;

const setup = () => {
  const host = new MemoryHost({
    [SIGN]: fragmentXml(['sig'], ['key']),
    [BARE]: '<fragment><set-variable name="a" value="1" /><set-variable name="b" value="2" /></fragment>\n',
    [CALLER]: policyXml('<include-fragment fragment-id="sign" /><include-fragment fragment-id="bare" /><include-fragment fragment-id="gone" />'),
  });
  const index = new PolicyIndex(host);
  return { host, index, shapes: new ShapeService(index, (): Promise<CSharpEngine | undefined> => Promise.resolve(engine)) };
};

describe('what a document includes', () => {
  it('reads each include once: headers with their files, what each hands back, and internals for documented ones', async () => {
    const { host, index } = setup();
    const included = await includedFragments(index, CALLER, summarize(parse(host.files.get(CALLER)!)));
    expect([...included.headers].map(([id, h]) => [id, h.uri])).toEqual([['sign', SIGN]]);
    expect([included.sets('sign'), included.sets('bare'), included.sets('gone')]).toEqual([['sig'], ['a', 'b'], undefined]);
    expect(included.internals('sign')?.sets).toEqual(['sig']);
    expect([included.header('bare'), included.internals('bare')]).toEqual([undefined, undefined]);
  });
});

describe('where a variable is declared', () => {
  it("is an included fragment's @in, else the document's own @out or @internal", async () => {
    const { host, index } = setup();
    const caller = summarize(parse(host.files.get(CALLER)!));
    const key = await declarationOf(index, CALLER, caller, 'key');
    expect([key?.uri, key?.v.name, key?.own]).toEqual([SIGN, 'key', false]);
    expect(await declarationOf(index, CALLER, caller, 'sig')).toBeUndefined();
    const own = await declarationOf(index, SIGN, summarize(parse(host.files.get(SIGN)!)), 'sig');
    expect([own?.uri, own?.own]).toEqual([SIGN, true]);
  });
});

describe('values for a declared variable', () => {
  const header = summarize(parse(typed)).header!;
  const input = (name: string) => header.inputs.find((v) => v.name === name)!;
  const layout = { indent: '    ', unit: '  ', escaped: true };

  it('uses the default, escaped for an attribute', async () => {
    const { shapes } = setup();
    expect(await valueFor(shapes, header, input('mode'), layout)).toEqual({ value: 'a&amp;&quot;b&quot;', known: true });
  });

  it('builds a JSON type key by key, escaped for the document', async () => {
    const { shapes } = setup();
    const { value, known } = await valueFor(shapes, header, input('user'), layout);
    expect(known).toBe(true);
    expect(value).toContain('[&quot;id&quot;] = &quot;&quot;');
    expect(value.startsWith('@(new JObject {')).toBe(true);
    expect((await valueFor(shapes, header, input('user'), { ...layout, escaped: false })).value).toContain('["id"] = ""');
  });

  it("leaves a string empty, and says when it can't read the type", async () => {
    const { shapes } = setup();
    expect(await valueFor(shapes, header, input('name'), layout)).toEqual({ value: '', known: true });
    expect(await valueFor(shapes, header, input('odd'), layout)).toEqual({ value: '', known: false });
  });

  it('writes a set-variable line, noting an optional input or a type it could not build', async () => {
    const { shapes } = setup();
    expect(await inputLine(shapes, header, input('mode'), layout)).toBe('    <set-variable name="mode" value="a&amp;&quot;b&quot;" /> <!-- optional, default a&"b" -->\n');
    expect(await inputLine(shapes, header, input('odd'), layout)).toBe('    <set-variable name="odd" value="" /> <!-- Mystery -->\n');
    expect(await inputLine(shapes, header, input('name'), layout)).toBe('    <set-variable name="name" value="" />\n');
  });
});

describe('the type on a new tag', () => {
  it('names an inline shape the code builds as a new typedef, and keeps any other type', async () => {
    const { shapes } = setup();
    const doc = parse('<fragment><set-variable name="result" value="@(new JObject { [&quot;n&quot;] = 1 })" /></fragment>\n');
    const model = { summary: [], entries: [] };
    const stop = (t: string) => t;
    expect(await typeForTag(shapes, doc, model, stop, 'result', '{ n: int }', new Set())).toBe('Result');
    expect(model.entries.map((e: { kind: string }) => e.kind)).toEqual(['typedef', 'property']);
    expect(await typeForTag(shapes, doc, model, stop, 'result', 'long', new Set())).toBe('long');
    expect(await typeForTag(shapes, doc, model, stop, 'missing', '{ a: int }', new Set())).toBe('{ a: int }');
  });
});

describe("what a fragment's callers read", () => {
  it('collects the reads of every file that includes it, by file name or instance path', async () => {
    const host = new MemoryHost({
      [SIGN]: fragmentXml(['sig']),
      [CALLER]: policyXml('<include-fragment fragment-id="sign" /><set-header name="x"><value>@((string)context.Variables["sig"])</value></set-header>'),
    });
    const index = new PolicyIndex(host);
    expect([...(await index.readByCallers(SIGN))]).toEqual(['sig']);
    expect([...(await index.readByCallers('apim-edit://inst/inst/fragments/sign.fragment.xml'))]).toEqual(['sig']);
    expect([...(await index.readByCallers('file:///ws/policyFragments/other/policy.xml'))]).toEqual([]);
  });
});

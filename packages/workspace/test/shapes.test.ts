import { describe, expect, it, vi } from 'vitest';
import type { CSharpEngine } from '@apim-policy/csharp-engine';
import { loadEngine } from '@apim-policy/csharp-engine/testing';
import { type Document, parse } from '@apim-policy/document';
import { summarize } from '@apim-policy/analysis';
import { PolicyIndex } from '../src/policyIndex';
import { ShapeService } from '../src/shapes';
import { MemoryHost, MemoryInstance, policyXml, type Uri } from './memory';

const engine = loadEngine();
type EngineOf = () => Promise<CSharpEngine | undefined>;
const on: EngineOf = () => Promise.resolve(engine);
const off: EngineOf = () => Promise.resolve(undefined);

/** A fragment whose `set-variable` builds `json` (C#) into `name`, optionally including others. */
const builder = (name: string, json: string, includes: string[] = []) =>
  `<fragment>${includes.map((id) => `<include-fragment fragment-id="${id}" />`).join('')}<set-variable name="${name}" value="@(${json.replace(/"/g, '&quot;')})" /></fragment>\n`;
const frag = (id: string) => `file:///ws/policyFragments/${id}/policy.xml`;

const service = (files: Record<Uri, string>, originOf?: (doc: Document) => Uri | undefined, engineOf = on) => {
  const host = new MemoryHost(files);
  const index = new PolicyIndex(host);
  return { host, index, shapes: new ShapeService(index, engineOf, originOf) };
};

const show = async (shapes: ShapeService<Uri>, doc: Document, name: string) => {
  const s = (await shapes.forDocument(doc))?.get(name);
  return s && engine.displayShape(s);
};

describe('shapes through includes', () => {
  it('knows what an included fragment builds, from what the fragments it includes build', async () => {
    const { shapes } = service({
      [frag('user')]: builder('user', 'new JObject { ["id"] = "u1", ["age"] = 3 }'),
      [frag('wrap')]: builder('wrapped', 'new JObject { ["inner"] = (JObject)context.Variables["user"] }', ['user']),
    });
    const caller = parse(policyXml('<include-fragment fragment-id="wrap" />'));
    expect(await show(shapes, caller, 'wrapped')).toBe('{ inner: { id: string, age: int } }');
    // Without a header, a fragment hands on only what it sets itself.
    expect([...(await shapes.outputsOf('wrap')).keys()]).toEqual(['wrapped']);
  });

  it('stops at fragments that include each other', async () => {
    const { shapes } = service({
      [frag('a')]: builder('from-a', 'new JObject { ["a"] = 1 }', ['b']),
      [frag('b')]: builder('from-b', 'new JObject { ["b"] = 1 }', ['a']),
    });
    const caller = parse(policyXml('<include-fragment fragment-id="a" />'));
    expect(await show(shapes, caller, 'from-a')).toBe('{ a: int }');
  });

  it("reads the instance's fragments for a policy that came from the instance", async () => {
    const instancePolicy = parse(policyXml('<include-fragment fragment-id="user" />'));
    const { index, shapes } = service({ [frag('user')]: builder('user', 'new JObject { ["local"] = 1 }') }, (doc) => (doc === instancePolicy ? 'apim-instance://inst/inst/apis/echo.policy.xml' : undefined));
    index.attach(new MemoryInstance({ user: builder('user', 'new JObject { ["remote"] = 1 }') }));
    expect(await show(shapes, instancePolicy, 'user')).toBe('{ remote: int }');
    expect(await show(shapes, parse(policyXml('<include-fragment fragment-id="user" />')), 'user')).toBe('{ local: int }');
  });

  it('works them out again after an indexed file changes', async () => {
    const { host, index, shapes } = service({ [frag('user')]: builder('user', 'new JObject { ["old"] = 1 }') });
    const caller = parse(policyXml('<include-fragment fragment-id="user" />'));
    expect(await show(shapes, caller, 'user')).toBe('{ old: int }');
    index.documentChanged(frag('user'), host.edit(frag('user'), builder('user', 'new JObject { ["new"] = 1 }')));
    await vi.waitFor(async () => expect(await show(shapes, caller, 'user')).toBe('{ new: int }'), { timeout: 2000 });
  });
});

describe('what a fragment header asks for', () => {
  const typed = `<!--
  @typedef {{ id: string }} User
  @in  {User} user
  @out {JObject} result
-->
<fragment />
`;

  it("gives each set-variable the declared shape of the input it fills", async () => {
    const { shapes } = service({ [frag('greet')]: typed });
    const caller = parse(policyXml('<set-variable name="user" value="@(new JObject())" /><set-variable name="other" value="@(1)" /><include-fragment fragment-id="greet" />'));
    const wanted = await shapes.wanted(caller);
    expect([...wanted.values()].map((s) => engine.displayShape(s))).toEqual(['{ id: string }']);
    expect(await shapes.wanted(caller)).toBe(wanted);
  });

  it('spells out a declared type with a filled-in example', async () => {
    const { shapes } = service({});
    const header = summarize(parse(typed)).header!;
    const example = await shapes.example(header, 'User[]', { strings: 'empty' });
    expect(example?.shape).toBe('{ id: string }[]');
    expect(JSON.parse(example!.json)).toEqual([{ id: '' }]);
    expect(example?.csharp).toContain('["id"] = ""');
    expect(await shapes.example(header, 'Nope')).toBeUndefined();
  });
});

describe('header types for what a document sets', () => {
  const doc = parse(`<!--
  Sets things.

  @typedef {{ id: string }} User
  @out {User} user
-->
<fragment>
  <set-variable name="user" value="@(new JObject { [&quot;id&quot;] = &quot;u&quot; })" />
  <set-variable name="fresh" value="@(new JObject { [&quot;k&quot;] = 1 })" />
  <set-variable name="bag" value="@{ var o = new JObject(); o[context.RequestId.ToString()] = 1; return o; }" />
  <set-variable name="count" value="@(42L)" />
</fragment>
`);

  it('names a shape by the typedef it fits, else spells it out, else gives the type of what sets it', async () => {
    const { shapes } = service({});
    const text = await shapes.typeTexts(doc);
    expect(['user', 'fresh', 'bag', 'count', 'unset'].map(text)).toEqual(['User', '{ k: int }', 'JObject', 'long', undefined]);
  });

  it('drafts typedefs only for shapes no typedef fits yet', async () => {
    const { shapes } = service({});
    expect(await shapes.typedefsFor(doc, 'user', new Set())).toBeUndefined();
    const drafts = await shapes.draftTypedefs(doc);
    expect([...drafts.keys()]).toEqual(['fresh']);
    expect(drafts.get('fresh')?.name).toBe('Fresh');
  });

  it('reads the JObject under the cursor', async () => {
    const { shapes } = service({});
    const expr = doc.expressions[1];
    const at = expr.code.indexOf('JObject') + 1;
    expect(await shapes.createdShapeAt(doc, expr, at)).toBe('{ k: int }');
    // Named apart from the names already taken.
    expect((await shapes.typedefsForCreated(doc, expr, at, 'fresh', new Set(['Fresh'])))?.name).toBe('Fresh2');
  });

  it('turns a type written in a header into typedefs', async () => {
    const { shapes } = service({});
    const header = summarize(doc).header!;
    expect((await shapes.typedefsForType(header, '{ a: int }', 'thing', new Set()))?.entries.map((e) => [e.kind, e.name, e.type])).toEqual([
      ['typedef', 'Thing', undefined],
      ['property', 'a', 'int'],
    ]);
  });
});

describe('with C# features off', () => {
  it('has nothing to say', async () => {
    const doc = parse(builder('x', 'new JObject { ["a"] = 1 }'));
    const { shapes } = service({}, undefined, off);
    const header = summarize(parse('<!-- @in {{ a: int }} x -->\n<fragment />')).header!;
    expect(await shapes.forDocument(doc)).toBeUndefined();
    expect((await shapes.typeTexts(doc))('x')).toBeUndefined();
    expect((await shapes.wanted(doc)).size).toBe(0);
    expect(await shapes.example(header, 'JObject')).toBeUndefined();
    expect(await shapes.createdShapeAt(doc, doc.expressions[0], 5)).toBeUndefined();
    expect(await shapes.typedefsFor(doc, 'x', new Set())).toBeUndefined();
    expect(await shapes.typedefsForType(header, '{ a: int }', 'x', new Set())).toBeUndefined();
    expect(await shapes.typedefsForCreated(doc, doc.expressions[0], 5, 'x', new Set())).toBeUndefined();
    expect((await shapes.outputsOf('x')).size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { declaredType, displayShape, NO_SHAPES, shapeOf } from '@charliethomson/apim-csharp-engine';
import { loadEngine } from '@charliethomson/apim-csharp-engine/testing';
import { parse } from '@charliethomson/apim-document';
import { documentShapes, envOf, generateTypedefs, outputShapes, setterTypes, setVariableTargets, typedefFor, wantedShapes } from '../src/shapes';
import { propertyDocs } from '../src/fragmentDoc';
import { draftModel, renderHeader } from '../src/headerShape';
import { summarize } from '../src/variables';

const engine = loadEngine();

describe('shapes across expressions', () => {
  const env = envOf(engine.model, new Map([['something', engine.resultShape('return new JObject { ["someData"] = 42, ["deep"] = new JObject { ["k"] = "v" } };', 'block', NO_SHAPES)!]]));

  it('completes and hovers keys of a variable read through a cast or GetValueOrDefault<JObject>', () => {
    const a = 'int? result = (int?)((JObject)context.Variables["something"])?["someData"]; return null;';
    const at = a.indexOf('someData') + 2;
    expect(engine.complete(a, 'block', at, env)?.entries.map((e) => e.detail)).toEqual(['someData: int', 'deep: { k: string }']);
    expect(engine.hover(a, 'block', at, env)?.signature).toBe('(JSON key) someData: int');
    const b = 'context.Variables.GetValueOrDefault<JObject>("something")["deep"]["k"]';
    expect(engine.hover(b, 'expr', b.lastIndexOf('"k"') + 1, env)?.signature).toBe('(JSON key) k: string');
  });

  it('offers nothing in other strings, or for variables without a shape', () => {
    expect(engine.complete('(string)context.Variables["other"]', 'expr', 27, env)).toBeUndefined();
    expect(engine.complete('"plain"', 'expr', 3, env)).toBeUndefined();
  });

  it("builds a document's shapes in order, from headers and set-variables", () => {
    const doc = parse(`<!--
    @typedef {{ id: string, age?: int }} User
    @in  {JArray<User>} users
    @out {{ count: int }} result
-->
<fragment>
    <set-variable name="first" value="@(((JArray)context.Variables[&quot;users&quot;]).OfType&lt;JObject&gt;().First())" />
    <set-variable name="result" value="@(new JObject { [&quot;count&quot;] = 1, [&quot;extra&quot;] = true })" />
</fragment>`);
    const shapes = documentShapes(doc, engine);
    const show = (n: string) => displayShape(engine.model, shapes.get(n)!);
    expect(show('users')).toBe('{ id: string, age?: int }[]');
    expect(show('first')).toBe('{ id: string, age?: int }');
    expect(show('result')).toBe('{ count: int, extra: bool }');
  });
});

describe("a fragment's outputs", () => {
  const frag = (header: string) =>
    parse(`${header}<fragment><set-variable name="pub" value="@(new JObject { [&quot;a&quot;] = 1 })" /><set-variable name="internal" value="@(new JObject())" /></fragment>`);

  it('hands callers its @outs, or everything it sets without a header', () => {
    const documented = frag('<!-- @out pub -->\n');
    expect([...outputShapes(documented, documentShapes(documented, engine)).keys()]).toEqual(['pub']);
    const bare = frag('');
    expect([...outputShapes(bare, documentShapes(bare, engine)).keys()]).toEqual(['pub', 'internal']);
  });

  it('writes inferred shapes into a drafted header', () => {
    const bare = frag('');
    const env = documentShapes(bare, engine);
    const text = (n: string) => {
      const s = env.get(n);
      return s && engine.displayShape(s);
    };
    expect(renderHeader(draftModel(bare, summarize(bare), 'Doc.', text, new Set(['pub'])), '', '  ')).toContain('@out {{ a: int }} pub');
  });
});

describe('the shapes set-variables should build', () => {
  it("says which declared shape each set-variable should build", () => {
    const frag = parse('<!--\n  @typedef {{ a: int }} A\n  @in {A} in-a\n  @out {A} out-a\n-->\n<fragment />');
    const caller = parse('<!--\n  @out {{ b: string }} mine\n-->\n<fragment><set-variable name="in-a" value="@(new JObject())" /><set-variable name="mine" value="@(new JObject())" /><set-variable name="other" value="@(1)" /></fragment>');
    const shapes = wantedShapes(engine.model, summarize(caller).header, [summarize(frag).header!]);
    expect([...shapes].map(([k, s]) => `${k}=${displayShape(engine.model, s)}`)).toEqual(['mine={ b: string }', 'in-a={ a: int }']);
    expect([...setVariableTargets(caller).values()]).toEqual(['in-a', 'mine', 'other']);
  });
});

describe('types of what a fragment sets', () => {
  it("uses each set-variable's result type, IResponse for send-request, and lets a blanking \"\" lose", () => {
    const doc = parse('<fragment><set-variable name="t" value="@(DateTime.UtcNow.Ticks)" /><set-variable name="s" value="text" /><send-request mode="new" response-variable-name="r" /><set-variable name="r" value="" /><set-variable name="e" value="" /><set-variable name="o" value="@((object)1)" /></fragment>');
    expect([...setterTypes(doc, (c, k) => engine.resultType(c, k))]).toEqual([['t', 'long'], ['s', 'string'], ['r', 'IResponse'], ['e', 'string']]);
  });

  it('names a shape by the @typedef it fits, an array of one too', () => {
    const header = parse('<!--\n  @typedef {{ id: string, age?: int }} User\n  @in {User} u\n-->\n<fragment />');
    const h = summarize(header).header;
    const built = (code: string) => engine.resultShape(code, 'block', NO_SHAPES)!;
    expect(typedefFor(engine.model, built('return new JObject { ["id"] = "x" };'), h)).toBe('User');
    expect(typedefFor(engine.model, built('return new JArray(new[] { "x" }.Select(s => new JObject { ["id"] = s, ["age"] = (int?)1 }));'), h)).toBe('User[]');
    expect(typedefFor(engine.model, built('return new JObject { ["id"] = "x", ["other"] = 1 };'), h)).toBeUndefined();
    expect(typedefFor(engine.model, built('return new JObject { ["age"] = 1 };'), h)).toBeUndefined();
  });
});

describe('writing typedefs', () => {
  const built = (code: string) => engine.resultShape(code, 'block', NO_SHAPES)!;
  const lines = (g: ReturnType<typeof generateTypedefs>) => g!.entries.map((e) => `@${e.kind} ${e.type ? `{${e.type}} ` : ''}${e.optional ? `[${e.name}]` : e.name}`);

  it('names a typedef for its variable, with @property lines, nested objects dotted', () => {
    const g = generateTypedefs(engine.model, 'ru-int-reply', built('return new JObject { ["code"] = 1, ["error"] = new JObject { ["source"] = "s" } };'), new Set());
    expect(g?.type).toBe('Reply');
    expect(lines(g)).toEqual(['@typedef Reply', '@property {int} code', '@property {JObject} error', '@property {string} error.source']);
  });

  it('gives an array of objects an element typedef, named for its key, and keeps names apart', () => {
    const taken = new Set(['Filter']);
    const g = generateTypedefs(engine.model, 'ru-arg-filters', built('return new JArray(new JObject { ["rules"] = new JArray(new JObject { ["field"] = "f" }) });'), taken);
    expect(g?.type).toBe('Filter2[]');
    expect(lines(g)).toEqual(['@typedef Filter2', '@property {Filter2Rule[]} rules', '@typedef Filter2Rule', '@property {string} field']);
    expect(generateTypedefs(engine.model, 'x', built('return new JObject();'), new Set())).toBeUndefined();
  });

  it('round-trips: the typedef it writes describes the same shape', () => {
    const shape = built('return new JObject { ["id"] = "x", ["tags"] = new JArray(new[] { "a" }), ["meta"] = new JObject { ["n"] = 1 } };');
    const g = generateTypedefs(engine.model, 'thing', shape, new Set())!;
    const header = summarize(parse(`<!--\n${g.entries.map((e) => `  @${e.kind} ${e.type ? `{${e.type}} ` : ''}${e.name}`).join('\n')}\n  @in {${g.type}} t\n-->\n<fragment />`)).header!;
    expect(typedefFor(engine.model, shape, header)).toBe('Thing');
  });

  it('carries @property descriptions into key completion and hover', () => {
    const header = summarize(parse('<!--\n  @typedef Rule\n  @property {string} field  The User field it tests.\n  @in {Rule} r\n-->\n<fragment />')).header!;
    const want = shapeOf(declaredType(engine.model, 'Rule', header.typedefs, propertyDocs(header))!)!;
    const code = 'new JObject { [""] = 1 }';
    expect(engine.complete(code, 'expr', code.indexOf('""') + 1, NO_SHAPES, want)?.entries[0]).toMatchObject({ label: 'field', documentation: 'The User field it tests.' });
    const set = 'new JObject { ["field"] = "nat" }';
    expect(engine.hover(set, 'expr', set.indexOf('field') + 1, NO_SHAPES, want)?.documentation).toBe('The User field it tests.');
  });
});

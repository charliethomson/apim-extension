import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declaredType, displayShape, displayShaped, exampleCSharp, exampleJson, NO_SHAPES, shapeOf } from '../../src/csharp/lang/json';
import type { RawModel } from '../../src/csharp/lang/model';
import { CSharpEngine } from '../../src/csharp/lang/service';
import { parse } from '../../src/parser/scanner';
import { documentShapes, envOf, generateTypedefs, outputShapes, setterTypes, setVariableTargets, typedefFor, wantedShapes } from '../../src/policy/shapes';
import { propertyDocs } from '../../src/policy/fragmentDoc';
import { draftModel, renderHeader } from '../../src/policy/headerShape';
import { summarize } from '../../src/policy/variables';

const root = join(__dirname, '..', '..');
const engine = CSharpEngine.load(JSON.parse(readFileSync(join(root, 'data/csharp-model.json'), 'utf8')) as RawModel, readFileSync(join(root, 'stubs/ApimContext.cs'), 'utf8'));
const shape = (code: string, kind: 'expr' | 'block' = 'block') => {
  const s = engine.resultShape(code, kind, NO_SHAPES);
  return s && engine.displayShape(s);
};

describe('JSON shapes from code', () => {
  it('reads an initializer, nested objects and arrays', () => {
    expect(shape('var result = 42; return new JObject { ["someData"] = result, ["nested"] = new JObject { ["x"] = "s" }, ["list"] = new JArray(new[] { 1, 2 }) };')).toBe(
      '{ someData: int, nested: { x: string }, list: int[] }',
    );
  });

  it('adds keys assigned later, and keeps a key whose value is null', () => {
    expect(shape('var o = new JObject(); o["a"] = 1; o["b"] = new JObject { ["c"] = true }; o["c"] = null; return o;')).toBe('{ a: int, b: { c: bool }, c: ? }');
  });

  it('follows Select into a JArray, and back out through foreach, OfType and indexing', () => {
    expect(shape('return new JArray(new[] { "x" }.Select(s => new JObject { ["name"] = s }));')).toBe('{ name: string }[]');
    expect(shape('var a = new JArray(new[] { "x" }.Select(s => new JObject { ["name"] = s })); foreach (var u in a) { return new JObject { ["n"] = u["name"] }; } return null;')).toBe('{ n: string }');
    expect(shape('var a = new JArray(new[] { "x" }.Select(s => new JObject { ["name"] = s })); return new JObject { ["first"] = a.OfType<JObject>().First() };')).toBe('{ first: { name: string } }');
  });

  it("isn't affected by what the engine saw before (the supertype cache ignores shapes)", () => {
    const fresh = CSharpEngine.load(JSON.parse(readFileSync(join(root, 'data/csharp-model.json'), 'utf8')) as RawModel, readFileSync(join(root, 'stubs/ApimContext.cs'), 'utf8'));
    fresh.diagnostics('new List<JObject>().Select(o => o).First()', 'expr');
    const s = fresh.resultShape('return new JArray(new List<string>().Select(x => new JObject { ["k"] = x }));', 'block', NO_SHAPES);
    expect(s && fresh.displayShape(s)).toBe('{ k: string }[]');
  });

  it("doesn't change what compiles", () => {
    expect(engine.diagnostics('var o = new JObject { ["a"] = 1 }; int? x = (int?)o["a"]; string s = (string)o["missing"]; return o;', 'block')).toEqual([]);
  });

  it('has nothing to say about values it can not see', () => {
    expect(shape('return JObject.Parse("{}");')).toBeUndefined();
    expect(shape('return "text";')).toBeUndefined();
  });
});

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

describe('declared types', () => {
  const d = (t: string, defs: Record<string, string> = {}) => {
    const type = declaredType(engine.model, t, new Map(Object.entries(defs)));
    return type && displayShaped(engine.model, type);
  };

  it('reads object types, arrays, nullables and typedefs', () => {
    expect(d('{ a: string, "b c"?: int?, d: { e: bool[] } }')).toBe('{ a: string, "b c"?: int?, d: { e: bool[] } }');
    expect(d('JArray<User>', { User: '{ id: string }' })).toBe('{ id: string }[]');
    expect(d('Loop', { Loop: 'Loop' })).toBeUndefined();
    expect(d('string')).toBe('string');
  });

  it('gives up on what it can not read', () => {
    expect(d('{ a: }')).toBeUndefined();
    expect(d('Map<string>')).toBeUndefined();
    expect(shapeOf(declaredType(engine.model, 'JObject')!)).toBeUndefined();
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

describe('building JSON for a declared shape', () => {
  const defs = new Map([
    ['UserRule', '{ field: string, equals?: string, min?: int }'],
    ['UserFilter', '{ match?: string, rules: UserRule[] }'],
  ]);
  const want = shapeOf(declaredType(engine.model, 'UserFilter', defs)!)!;
  const warnings = (code: string, kind: 'expr' | 'block' = 'expr') => engine.diagnostics(code, kind, undefined, NO_SHAPES, want).map((d) => [d.code, code.slice(d.start, d.end), d.message]);

  it('flags unknown keys, missing required keys and values of the wrong kind, through nested arrays', () => {
    const code = 'new JObject { ["bogus"] = 1, ["rules"] = new JArray(new JObject { ["field"] = "nat" }, new JObject { ["min"] = "60" }) }';
    expect(warnings(code)).toEqual([
      ['json-shape', '"bogus"', "'bogus' isn't a key of the shape this value should have (match?, rules)."],
      ['json-shape', 'JObject', "Missing required key 'field'."],
      ['json-shape', '"60"', "'min' should be int, not string."],
    ]);
    expect(warnings('new JObject { ["match"] = "any" }')).toEqual([['json-shape', 'JObject', "Missing required key 'rules'."]]);
    expect(warnings('new JObject { ["rules"] = "nope" }')).toEqual([['json-shape', '"nope"', "'rules' should be an array, not string."]]);
  });

  it('checks what a block returns, and accepts a JArray it can not see into', () => {
    expect(warnings('var rules = new JArray(); return new JObject { ["rules"] = rules };', 'block')).toEqual([]);
    expect(warnings('return new JObject { ["extra"] = 1, ["rules"] = new JArray() };', 'block').map((w) => w[1])).toEqual(['"extra"']);
  });

  it('completes the keys still to write, required first, and hovers them', () => {
    const typing = 'new JObject { ["match"] = "any", [""] }';
    expect(engine.complete(typing, 'expr', typing.indexOf('[""]') + 2, NO_SHAPES, want)?.entries.map((e) => e.label)).toEqual(['rules']);
    const nested = 'new JObject { ["rules"] = new JArray(new JObject { [""] = 1 }) }';
    expect(engine.complete(nested, 'expr', nested.indexOf('[""]') + 2, NO_SHAPES, want)?.entries.map((e) => e.detail)).toEqual(['field: string', 'equals?: string', 'min?: int']);
    expect(engine.hover(nested, 'expr', nested.indexOf('rules') + 1, NO_SHAPES, want)?.signature).toBe('(JSON key) rules: { field: string, equals?: string, min?: int }[]');
  });

  it('builds a fully populated example, as JSON and as C#', () => {
    const t = declaredType(engine.model, 'UserFilter', defs)!;
    expect(exampleJson(engine.model, t)).toEqual({ match: 'string', rules: [{ field: 'string', equals: 'string', min: 0 }] });
    expect(exampleCSharp(engine.model, t, { strings: 'empty' })).toBe(
      [
        'new JObject {',
        '    ["match"] = "", // optional',
        '    ["rules"] = new JArray {',
        '        new JObject {',
        '            ["field"] = "",',
        '            ["equals"] = "", // optional',
        '            ["min"] = 0, // optional',
        '        },',
        '    },',
        '}',
      ].join('\n'),
    );
    // The example is itself what the shape wants.
    expect(warnings(exampleCSharp(engine.model, t, { strings: 'empty' }))).toEqual([]);
  });

  it("says which declared shape each set-variable should build", () => {
    const frag = parse('<!--\n  @typedef {{ a: int }} A\n  @in {A} in-a\n  @out {A} out-a\n-->\n<fragment />');
    const caller = parse('<!--\n  @out {{ b: string }} mine\n-->\n<fragment><set-variable name="in-a" value="@(new JObject())" /><set-variable name="mine" value="@(new JObject())" /><set-variable name="other" value="@(1)" /></fragment>');
    const shapes = wantedShapes(engine.model, summarize(caller).header, [summarize(frag).header!]);
    expect([...shapes].map(([k, s]) => `${k}=${displayShape(engine.model, s)}`)).toEqual(['mine={ b: string }', 'in-a={ a: int }']);
    expect([...setVariableTargets(caller).values()]).toEqual(['in-a', 'mine', 'other']);
  });
});

describe('the JObject under the cursor', () => {
  it('gives the shape of the new JObject whose `new JObject` holds the position, nested ones included', () => {
    const code = 'return new JObject { ["type"] = "t", ["status"] = 400, ["inner"] = new JObject { ["k"] = true } }.ToString();';
    const outer = engine.createdShapeAt(code, 'block', code.indexOf('JObject') + 2);
    expect(outer && engine.displayShape(outer.shape)).toBe('{ type: string, status: int, inner: { k: bool } }');
    const inner = engine.createdShapeAt(code, 'block', code.lastIndexOf('new JObject') + 5);
    expect(inner && engine.displayShape(inner.shape)).toBe('{ k: bool }');
    expect(engine.createdShapeAt(code, 'block', code.indexOf('"t"'))).toBeUndefined();
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

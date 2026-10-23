import { describe, expect, it } from 'vitest';
import { declaredType, displayShaped, exampleCSharp, exampleJson, NO_SHAPES, shapeOf } from '../src/json';
import { loadEngine } from '../src/testing';

const engine = loadEngine();
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
    const fresh = loadEngine();
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

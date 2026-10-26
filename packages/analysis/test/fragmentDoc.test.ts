import { describe, expect, it } from 'vitest';
import { fixture } from '@charliethomson/apim-fixtures';
import { parse } from '@charliethomson/apim-document';
import { checkFragmentHeader, checkIncludes, checkInternalUse, declarationOf, fragmentDoc, inputUse, matchesPattern, propertiesOfTypeText, variableNameSuggestions, type FragmentDoc } from '../src/fragmentDoc';
import { knownVariables, summarize } from '../src/variables';

const FRAGMENT = `<!--
  Signs the outgoing request.

  @in  {string} sig-key            The HMAC key.
  @in  {int}    [sig-ttl=300]      Seconds the signature holds.
  @in  [sig-scope]
  @out {string} sig-header         The value for the Authorization header.
                                   Includes the scheme.
  @out sig-expires
-->
<fragment>
    <set-variable name="sig-header" value="@(context.Variables.GetValueOrDefault<string>(&quot;sig-key&quot;) + context.Variables[&quot;sig-ttl&quot;])" />
    <set-variable name="sig-expires" value="@(context.Variables.ContainsKey(&quot;sig-scope&quot;))" />
</fragment>`;

const header = (xml: string) => fragmentDoc(parse(xml));

describe('fragment headers', () => {
  it('reads @in and @out tags: types, optional inputs, defaults and continued descriptions', () => {
    const h = header(FRAGMENT)!;
    expect(h.summary).toBe('Signs the outgoing request.');
    expect(h.inputs.map((v) => [v.name, v.type, v.optional, v.default, v.description])).toEqual([
      ['sig-key', 'string', false, undefined, 'The HMAC key.'],
      ['sig-ttl', 'int', true, '300', 'Seconds the signature holds.'],
      ['sig-scope', undefined, true, undefined, ''],
    ]);
    expect(h.outputs.map((v) => [v.name, v.description])).toEqual([
      ['sig-header', 'The value for the Authorization header. Includes the scheme.'],
      ['sig-expires', ''],
    ]);
    expect(h.problems).toEqual([]);
  });

  it("points each variable's range at its name in the header", () => {
    const h = header(FRAGMENT)!;
    expect(h.inputs.map((v) => FRAGMENT.slice(v.range.start, v.range.end))).toEqual(['sig-key', 'sig-ttl', 'sig-scope']);
    expect(h.outputs.map((v) => FRAGMENT.slice(v.range.start, v.range.end))).toEqual(['sig-header', 'sig-expires']);
  });

  it('also reads a header that is the first thing inside <fragment>', () => {
    const h = header('<fragment>\n  <!-- @in a\n       @out b -->\n  <set-variable name="b" value="1" />\n</fragment>')!;
    expect([h.inputs.map((v) => v.name), h.outputs.map((v) => v.name)]).toEqual([['a'], ['b']]);
  });

  it('ignores comments without tags, comments elsewhere, and documents that are not fragments', () => {
    expect(header('<!-- just a note -->\n<fragment />')).toBeUndefined();
    expect(header('<fragment>\n  <base />\n  <!-- @in a -->\n</fragment>')).toBeUndefined();
    expect(header('<!-- @in a -->\n<policies />')).toBeUndefined();
  });

  it('reports malformed tags, optional outputs and duplicates', () => {
    const h = header('<!--\n  @in\n  @out [b]\n  @in a\n  @in a\n  @in [c\n-->\n<fragment />')!;
    expect(h.problems.map((p) => p.message)).toEqual([
      'Expected `@in`, `@out` or `@internal`, then `{type} name description`.',
      "Only an input can be optional; drop the brackets around 'b'.",
      "'a' is already documented as @in.",
      "Unbalanced brackets around 'c'.",
    ]);
  });

  it('reads the converted random-user fixture, which matches its body exactly', () => {
    const s = summarize(parse(fixture('apiops/policyFragments/random-user/policy.xml')));
    expect([s.header?.inputs.length, s.header?.outputs.length]).toEqual([17, 12]);
    expect(checkFragmentHeader(s.header!, s.variables, s.reads)).toEqual([]);
  });
});

describe('variable reads', () => {
  it('finds indexer and lookup reads by literal key, in both formats, with document ranges', () => {
    const s = summarize(parse(FRAGMENT));
    expect(s.reads.map((r) => [r.name, FRAGMENT.slice(r.range.start, r.range.end)])).toEqual([
      ['sig-key', 'sig-key'],
      ['sig-ttl', 'sig-ttl'],
      ['sig-scope', 'sig-scope'],
    ]);
    const raw = summarize(parse('<a b="@(context.Variables.TryGetValue("x", out var v) ? context.Variables["y"] : context.Request.Headers["z"])" />'));
    expect(raw.reads.map((r) => r.name)).toEqual(['x', 'y']);
  });

  it('finds reads inside interpolated strings', () => {
    expect(summarize(parse('<a b="@($&quot;{context.Variables[&quot;x&quot;]} and {(string)context.Variables[&quot;y&quot;]}&quot;)" />')).reads.map((r) => r.name)).toEqual(['x', 'y']);
  });

  it('skips computed keys', () => {
    expect(summarize(parse('<a b="@(context.Variables[&quot;a&quot; + 1])" />')).reads).toEqual([]);
    expect(summarize(parse('<a b="@(context.Variables[name])" />')).reads).toEqual([]);
  });
});

describe('checking a header against its fragment', () => {
  const check = (xml: string) => {
    const s = summarize(parse(xml));
    return checkFragmentHeader(s.header!, s.variables, s.reads).map((p) => [p.code, p.severity, xml.slice(p.range.start, p.range.end)]);
  };

  it('is quiet when the header matches', () => {
    expect(check(FRAGMENT)).toEqual([]);
  });

  it('flags outputs never set, inputs never read, and reads neither set nor documented', () => {
    const xml = `<!--\n  @in unused\n  @out never\n-->\n<fragment>\n  <set-variable name="x" value="@(context.Variables[&quot;undocumented&quot;] + context.Variables[&quot;undocumented&quot;])" />\n</fragment>`;
    expect(check(xml)).toEqual([
      ['fragment-out-unset', 'warning', 'never'],
      ['fragment-in-unused', 'warning', 'unused'],
      ['fragment-var-undeclared', 'information', 'x'],
      ['fragment-in-undocumented', 'information', 'undocumented'],
    ]);
  });

  it('accepts a variable declared @internal, by name or by pattern, and flags internals nothing sets', () => {
    const xml = `<!--\n  @out a\n  @internal {JObject} w-one  Typed.\n  @internal w-*\n  @internal gone\n  @internal z-*\n-->\n<fragment>\n  <set-variable name="a" value="1" />\n  <set-variable name="w-one" value="1" />\n  <set-variable name="w-two" value="1" />\n</fragment>`;
    expect(check(xml)).toEqual([
      ['fragment-internal-unset', 'information', 'gone'],
      ['fragment-internal-unset', 'information', 'z-*'],
    ]);
    expect(header(xml)!.internals.map((v) => [v.name, v.type])).toEqual([['w-one', 'JObject'], ['w-*', undefined], ['gone', undefined], ['z-*', undefined]]);
    expect(check(xml.replace('@internal w-*', '@internal *'))).toEqual([
      ['fragment-internal-unset', 'information', 'gone'],
      ['fragment-internal-unset', 'information', 'z-*'],
    ]);
  });

  it("only lets @internal take a pattern", () => {
    expect(header('<!--\n  @in b\n  @out a-*\n-->\n<fragment />')!.problems.map((p) => p.message)).toEqual(['Only @internal takes a pattern; name each @out in full.']);
  });
});

describe('checking includes', () => {
  const doc = header(FRAGMENT)!;
  const headers: Record<string, FragmentDoc | undefined> = {
    sign: doc,
    key: header('<!-- @out sig-key -->\n<fragment><set-variable name="sig-key" value="k" /></fragment>'),
  };
  const check = (xml: string, ownInputs: string[] = []) => {
    const s = summarize(parse(xml));
    return checkIncludes(s.includeSites, s.variables, ownInputs, (id) => headers[id]).map((p) => p.message);
  };

  it('reports required inputs nothing sets before the include', () => {
    expect(check('<policies><inbound><include-fragment fragment-id="sign" /></inbound></policies>')).toEqual([
      "Fragment 'sign' requires 'sig-key', which nothing earlier in this file sets.",
    ]);
  });

  it('accepts an input set earlier, by an earlier include, or by the including fragment’s own @in', () => {
    expect(check('<policies><inbound><set-variable name="sig-key" value="k" /><include-fragment fragment-id="sign" /></inbound></policies>')).toEqual([]);
    expect(check('<policies><inbound><include-fragment fragment-id="key" /><include-fragment fragment-id="sign" /></inbound></policies>')).toEqual([]);
    expect(check('<fragment><include-fragment fragment-id="sign" /></fragment>', ['sig-key'])).toEqual([]);
  });

  it('counts only what comes before the include, and ignores undocumented fragments', () => {
    expect(check('<policies><inbound><include-fragment fragment-id="sign" /><set-variable name="sig-key" value="k" /></inbound></policies>')).toHaveLength(1);
    expect(check('<policies><inbound><include-fragment fragment-id="nope" /></inbound></policies>')).toEqual([]);
  });
});

describe('known variables from headers', () => {
  it("offers a documented fragment's outputs, not its internals, with their docs", () => {
    const frag = summarize(parse(`<!-- @out {string} public  For callers. -->\n<fragment><set-variable name="public" value="1" /><set-variable name="internal" value="2" /></fragment>`));
    const caller = summarize(parse('<policies><inbound><include-fragment fragment-id="f" /></inbound></policies>'));
    const vars = knownVariables(caller, [], [{ label: 'f', fragmentIds: ['f'], summary: frag }]);
    expect(vars.map((v) => [v.name, v.type, v.description, v.origin])).toEqual([['public', 'string', 'For callers.', 'fragment f']]);
  });

  it("offers a fragment its own documented inputs", () => {
    const frag = summarize(parse(FRAGMENT));
    const vars = knownVariables(frag, ['sign'], []);
    expect(vars.find((v) => v.name === 'sig-key')).toMatchObject({ origin: 'documented @in', type: 'string', description: 'The HMAC key.' });
  });
});

describe('naming variables', () => {
  it("offers included fragments' inputs (required first), the fragment's own outputs, then known names, each once", () => {
    const sign = header(FRAGMENT)!;
    const own = header('<!-- @out {int} result  The answer. -->\n<fragment />');
    const suggestions = variableNameSuggestions([{ id: 'sign', header: sign }], own, [{ name: 'sig-key', origin: 'set in this file' }, { name: 'other', type: 'bool' }]);
    const ordered = [...suggestions].sort((a, b) => a.sortText.localeCompare(b.sortText));
    expect(ordered.map((s) => [s.name, s.detail])).toEqual([
      ['sig-key', '{string} @in of sign (required)'],
      ['sig-ttl', '{int} @in of sign (optional, default 300)'],
      ['sig-scope', '@in of sign (optional)'],
      ['result', '{int} @out of this fragment'],
      ['other', '{bool} set in this file'],
    ]);
    expect(suggestions.find((s) => s.name === 'sig-key')?.documentation).toBe('The HMAC key.');
  });
});

describe('callers and internals', () => {
  const frag = header('<!--\n  @in key\n  @out result\n  @internal tmp-*\n-->\n<fragment />')!;
  const fragmentOf = (id: string) => (id === 'f' ? { header: frag, sets: ['result', 'tmp-a', 'tmp-b'] } : undefined);
  const check = (xml: string) => {
    const s = summarize(parse(xml));
    return checkInternalUse(s.includeSites, s.variables, s.reads, fragmentOf).map((p) => [p.code, xml.slice(p.range.start, p.range.end)]);
  };
  const policy = (inbound: string) => `<policies><inbound>${inbound}</inbound></policies>`;

  it("warns on reading a fragment's internal, not its output or the caller's own variable", () => {
    expect(check(policy('<include-fragment fragment-id="f" /><set-header name="a"><value>@((string)context.Variables["tmp-a"] + context.Variables["result"])</value></set-header>'))).toEqual([['fragment-internal-read', 'tmp-a']]);
    expect(check(policy('<set-variable name="tmp-a" value="x" /><set-header name="a"><value>@((string)context.Variables["tmp-a"])</value></set-header>'))).toEqual([]);
  });

  it('warns at the include when an internal overwrites what the caller set before and reads after', () => {
    const xml = policy('<set-variable name="tmp-b" value="mine" /><include-fragment fragment-id="f" /><set-header name="a"><value>@((string)context.Variables["tmp-b"])</value></set-header>');
    expect(check(xml)).toEqual([['fragment-internal-overwrite', 'f']]);
    // Read before the include: nothing is overwritten that matters.
    expect(check(policy('<set-variable name="tmp-b" value="mine" /><set-header name="a"><value>@((string)context.Variables["tmp-b"])</value></set-header><include-fragment fragment-id="f" />'))).toEqual([]);
  });

  it('matches patterns and says how a header declares a name', () => {
    expect([matchesPattern('ru-int-*', 'ru-int-x'), matchesPattern('ru-int-*', 'ru-ret-x'), matchesPattern('*', 'a'), matchesPattern('a.b*', 'aXb')]).toEqual([true, false, true, false]);
    expect(['key', 'result', 'tmp-z', 'other'].map((n) => declarationOf(frag, n))).toEqual(['in', 'out', 'internal', undefined]);
  });
});

describe('what reads say about an input', () => {
  it('is optional with a default when every read is GetValueOrDefault with the same literal', () => {
    expect(inputUse('t', ['context.Variables.GetValueOrDefault<bool>("t", false)'])).toEqual({ type: 'bool', optional: true, default: 'false' });
    expect(inputUse('u', ['context.Variables.GetValueOrDefault<object>("u", "https://x/")', 'Convert.ToString(context.Variables.GetValueOrDefault<object>("u", "https://x/"))'])).toEqual({ type: undefined, optional: true, default: 'https://x/' });
  });

  it('has no default when the reads disagree or give none, or an empty string', () => {
    expect(inputUse('n', ['context.Variables.GetValueOrDefault<int>("n", 1)', 'context.Variables.GetValueOrDefault<int>("n", 2)']).default).toBeUndefined();
    expect(inputUse('n', ['context.Variables.GetValueOrDefault<string>("n")']).default).toBeUndefined();
    expect(inputUse('n', ['context.Variables.GetValueOrDefault<object>("n", "")']).default).toBeUndefined();
  });

  it('is required when an indexer read would throw, unless something checks first', () => {
    expect(inputUse('k', ['(int?)context.Variables["k"]'])).toEqual({ type: 'int', optional: false, default: undefined });
    expect(inputUse('k', ['context.Variables.ContainsKey("k") ? (string)context.Variables["k"] : ""']).optional).toBe(true);
  });
});

describe('@typedef and @property', () => {
  const doc = header(`<!--
  @typedef Address  Where they live.
  @property {string} city      The city.
  @property {string} [postcode]
  @typedef User
  @property {string} id
  @property {Address} [home]
  @property {string} work.city   Nested without its own typedef.
  @property {int} work.floor
  @typedef {{ a: int }} Old
  @in {User} u
-->
<fragment />`)!;

  it('builds each typedef from its @property lines, dotted names as nested objects', () => {
    expect(doc.typedefs.get('Address')).toBe('{ city: string, postcode?: string }');
    expect(doc.typedefs.get('User')).toBe('{ id: string, home?: Address, work: { city: string, floor: int } }');
    expect(doc.typedefs.get('Old')).toBe('{ a: int }');
    expect(doc.typedefDocs.get('Address')).toMatchObject({ description: 'Where they live.', properties: [{ name: 'city', description: 'The city.' }, { name: 'postcode', optional: true }] });
    expect(doc.typedefDocs.get('Old')?.legacy).toBe(true);
  });

  it('reports a stray @property, a duplicate, and a typedef with none', () => {
    const bad = header('<!--\n  @property {int} x\n  @typedef T\n  @property {int} a\n  @property {int} a\n  @typedef Empty\n  @in {T} t\n-->\n<fragment />')!;
    expect(bad.problems.map((p) => p.message)).toEqual([
      'A @property belongs under a `@typedef Name` line.',
      "'a' is already a @property of T.",
      '@typedef Empty has no @property lines.',
    ]);
  });
});

describe('propertiesOfTypeText', () => {
  it('keeps named types as written and dots nested objects', () => {
    expect(propertiesOfTypeText('{ match?: string, rules: UserRule[], at: { city: string, geo?: { lat: double } }, m: Dictionary<string, int> }')).toEqual([
      { name: 'match', type: 'string', optional: true },
      { name: 'rules', type: 'UserRule[]', optional: false },
      { name: 'at', type: 'JObject', optional: false },
      { name: 'at.city', type: 'string', optional: false },
      { name: 'at.geo', type: 'JObject', optional: true },
      { name: 'at.geo.lat', type: 'double', optional: false },
      { name: 'm', type: 'Dictionary<string, int>', optional: false },
    ]);
  });

  it('keeps an array of inline objects whole', () => {
    expect(propertiesOfTypeText('{ items: { name: string }[] }')).toEqual([{ name: 'items', type: '{ name: string }[]', optional: false }]);
  });

  it('gives up on what a property name cannot spell, or text that is not an object', () => {
    expect(propertiesOfTypeText('{ "odd key": int }')).toBeUndefined();
    expect(propertiesOfTypeText('string[]')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { parse } from '@apim-policy/document';
import { fragmentDiagnostics, includeHints, type Includes } from '../src/fragmentChecks';
import type { FragmentDoc } from '../src/fragmentDoc';
import { summarize } from '../src/variables';

/** Includes from fragment sources by id, read as the workspace would. */
const includesOf = (fragments: Record<string, string>): Includes => {
  const summaries = new Map(Object.entries(fragments).map(([id, src]) => [id, summarize(parse(src))]));
  return {
    header: (id) => summaries.get(id)?.header,
    sets: (id) => {
      const s = summaries.get(id);
      return s && (s.header ? s.header.outputs.map((v) => v.name) : s.variables.map((v) => v.name));
    },
    internals: (id) => {
      const s = summaries.get(id);
      return s?.header && { header: s.header, sets: s.variables.map((v) => v.name) };
    },
  };
};

const SIGN = `<!--
  Signs the request.

  @in key  The key.
  @in [ttl=300]  Seconds.
  @out sig  The signature.
  @internal sign-tmp
-->
<fragment><set-variable name="sign-tmp" value="1" /><set-variable name="sig" value="@((string)context.Variables[&quot;key&quot;])" /></fragment>
`;

const check = (src: string, options: Parameters<typeof fragmentDiagnostics>[4], outer: Parameters<typeof fragmentDiagnostics>[3] = []) => {
  const doc = parse(src);
  return fragmentDiagnostics(doc, summarize(doc), includesOf({ sign: SIGN }), outer, options).map((d) => [d.code, d.severity, src.slice(d.range.start, d.range.end), d.unnecessary ?? false]);
};

describe('fragment diagnostics', () => {
  const caller = '<policies><inbound><include-fragment fragment-id="sign" /><set-header name="x"><value>@((string)context.Variables["sign-tmp"])</value></set-header></inbound></policies>';

  it("reports an unset required input as the setting says, and a caller reading an include's internal", () => {
    expect(check(caller, { missingInput: 'warning' })).toEqual([
      ['fragment-internal-read', 'warning', 'sign-tmp', false],
      ['fragment-in-unset', 'warning', 'sign', false],
    ]);
    expect(check(caller, { missingInput: 'information' }).map((d) => d.slice(0, 2))).toContainEqual(['fragment-in-unset', 'information']);
    expect(check(caller, { missingInput: 'off' }).map((d) => d[0])).toEqual(['fragment-internal-read']);
  });

  it('counts an input a broader scope sets before the include as set', () => {
    const at = caller.indexOf('<include-fragment');
    expect(check(caller, { missingInput: 'warning' }, [{ name: 'key', at, scope: { kind: 'global' } }]).map((d) => d[0])).toEqual(['fragment-internal-read']);
  });

  it("checks a fragment's own header: an unused input faded, an output not set on every path", () => {
    const fragment = `<!--
  Does things.

  @in unused  Never read.
  @out maybe  Only sometimes.
-->
<fragment><choose><when condition="@(true)"><set-variable name="maybe" value="1" /></when></choose></fragment>
`;
    expect(check(fragment, { missingInput: 'warning' })).toEqual([
      ['fragment-in-unused', 'warning', 'unused', true],
      ['fragment-out-maybe-unset', 'warning', 'maybe', false],
    ]);
  });

  it('flags reads nothing guarantees only when that lint is on, at its severity', () => {
    const reads = '<policies><inbound><set-header name="x"><value>@((string)context.Variables["nowhere"])</value></set-header></inbound></policies>';
    expect(check(reads, { missingInput: 'warning' })).toEqual([]);
    expect(check(reads, { missingInput: 'warning', unguarded: 'information' })).toEqual([['unguarded-variable', 'information', 'nowhere', false]]);
  });
});

describe('include hints', () => {
  const hints = (src: string, fragments: Record<string, string>) => {
    const includes = includesOf(fragments);
    return includeHints(summarize(parse(src)), (id) => includes.header(id), []).map((h) => [h.id, h.parts.map((p) => p.text).join(''), h.parts.filter((p) => p.variable).map((p) => `${p.variable!.kind}:${p.variable!.v.name}`)]);
  };

  it('lead with the required inputs nothing sets, then what the fragment takes and sets', () => {
    expect(hints('<policies><inbound><include-fragment fragment-id="sign" /></inbound></policies>', { sign: SIGN })).toEqual([
      ['sign', 'missing: key · in: key, ttl? · out: sig', ['in:key', 'in:ttl', 'out:sig']],
    ]);
    expect(hints('<policies><inbound><set-variable name="key" value="k" /><include-fragment fragment-id="sign" /></inbound></policies>', { sign: SIGN })[0][1]).toBe('in: key, ttl? · out: sig');
  });

  it('list six names a side, then a count, with no separator before a lone side', () => {
    const many = (n: number) => `<!--\n  Sets.\n\n${Array.from({ length: n }, (_, i) => `  @out v${i}`).join('\n')}\n-->\n<fragment />\n`;
    expect(hints('<policies><inbound><include-fragment fragment-id="m" /></inbound></policies>', { m: many(8) })[0][1]).toBe('out: v0, v1, v2, v3, v4, v5, +2');
  });

  it('skip fragments without a header, and documents without includes', () => {
    expect(hints('<policies><inbound><include-fragment fragment-id="bare" /></inbound></policies>', { bare: '<fragment />' })).toEqual([]);
    expect(includeHints(summarize(parse('<policies />')), (): FragmentDoc | undefined => undefined, [])).toEqual([]);
  });
});

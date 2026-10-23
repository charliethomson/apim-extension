import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/scanner';
import { keyAccessAt, knownVariables, summarize } from '../../src/policy/variables';
import { escapeForDocument, isEscapedFormat } from '../../src/parser/escaping';

const fixture = (p: string) => readFileSync(join(__dirname, '..', 'fixtures', p), 'utf8');

describe('summarize', () => {
  it('collects variables, includes and named values', () => {
    const s = summarize(
      parse(`<policies><inbound>
  <set-variable name="a" value="@(1)" />
  <set-variable name="@(&quot;dyn&quot;)" value="x" />
  <send-request response-variable-name="resp" mode="new"><set-url>{{base}}/x</set-url></send-request>
  <validate-jwt header-name="Authorization" output-token-variable-name="jwt" />
  <include-fragment fragment-id="rate-limit" />
  <set-header name="k"><value>{{key}}</value></set-header>
</inbound></policies>`),
    );
    expect(s.root).toBe('policies');
    expect(s.variables.map((v) => [v.name, v.element])).toEqual([
      ['a', 'set-variable'],
      ['resp', 'send-request'],
      ['jwt', 'validate-jwt'],
    ]);
    expect(s.variables[0].value).toBe('@(1)');
    expect(s.includes).toEqual(['rate-limit']);
    expect(s.namedValues.sort()).toEqual(['base', 'key']);
  });

  it('summarises the random-user fragment and its caller', () => {
    const frag = summarize(parse(fixture('apiops/policyFragments/random-user/policy.xml')));
    const caller = summarize(parse(fixture('apiops/apis/random-users/policy.xml')));
    expect(frag.root).toBe('fragment');
    expect(frag.variables.some((v) => v.name.startsWith('ru-ret-'))).toBe(true);
    expect(caller.includes).toContain('random-user');
    expect(caller.variables.some((v) => v.name.startsWith('ru-arg-'))).toBe(true);
  });
});

describe('knownVariables', () => {
  const frag = summarize(parse(fixture('apiops/policyFragments/random-user/policy.xml')));
  const caller = summarize(parse(fixture('apiops/apis/random-users/policy.xml')));

  it('gives a caller the variables its included fragments set', () => {
    const vars = knownVariables(caller, [], [{ label: 'fragment', fragmentIds: ['random-user'], summary: frag }]);
    const ret = vars.find((v) => v.name.startsWith('ru-ret-'))!;
    expect(ret.origin).toBe('fragment random-user');
    expect(vars.find((v) => v.name.startsWith('ru-arg-'))?.origin).toBeUndefined();
  });

  it('gives a fragment the variables its callers set', () => {
    const vars = knownVariables(frag, ['random-user'], [{ label: 'apis/random-users/policy.xml', fragmentIds: [], summary: caller }]);
    expect(vars.find((v) => v.name.startsWith('ru-arg-'))?.origin).toBe('set by apis/random-users/policy.xml');
  });

  it('prefers the local definition and ignores unrelated files', () => {
    const self = summarize(parse('<policies><inbound><set-variable name="x" value="1"/></inbound></policies>'));
    const other = summarize(parse('<policies><inbound><set-variable name="x" value="2"/><set-variable name="y" value="2"/></inbound></policies>'));
    const vars = knownVariables(self, [], [{ label: 'o', fragmentIds: ['o'], summary: other }]);
    expect(vars.map((v) => [v.name, v.value])).toEqual([['x', '1']]);
  });
});

describe('keyAccessAt', () => {
  const at = (code: string) => {
    const i = code.indexOf('|');
    return keyAccessAt(code.slice(0, i) + code.slice(i + 1), i);
  };

  it.each([
    ['context.Variables["ab|c"]', 'variable', 'abc'],
    ['context.Variables["|', 'variable', ''],
    ['context.Variables.GetValueOrDefault<string>("x|")', 'variable', 'x'],
    ['context.Variables.GetValueOrDefault<Dictionary<string, int>>("|")', 'variable', ''],
    ['context.Variables.ContainsKey("|")', 'variable', ''],
    ['context.Request.Headers.GetValueOrDefault("Auth|", "")', 'header', 'Auth'],
    ['context.Response.Headers["|"]', 'header', ''],
  ])('%s', (code, kind, key) => {
    const r = at(code);
    expect(r?.kind).toBe(kind);
    expect(r?.key).toBe(key);
    expect(r?.quote).toBe(false);
  });

  it('wants quotes right after the bracket', () => {
    expect(at('context.Variables[|]')).toMatchObject({ kind: 'variable', quote: true });
    expect(at('context.Variables.GetValueOrDefault<int>(|)')).toMatchObject({ kind: 'variable', quote: true });
  });

  it.each(['context.Request.Url.Query["|"]', 'Foo("|")', 'context.Variables.Count(|)', 'x["a", "|"]', '"|"', 'context.Variables[@"|"]'])(
    'ignores %s',
    (code) => expect(at(code)).toBeUndefined(),
  );

  it('ignores positions in the middle of a later argument', () => {
    expect(at('context.Request.Headers.GetValueOrDefault("a", "|")')).toBeUndefined();
  });
});

describe('format helpers', () => {
  it('detects the escaped format', () => {
    expect(isEscapedFormat(parse(fixture('escaped/echo.policy.xml')))).toBe(true);
    expect(isEscapedFormat(parse(fixture('raw/echo.policy.xml')))).toBe(false);
  });

  it('escapes insertions only for escaped documents outside CDATA', () => {
    expect(escapeForDocument('"a" < b && c', true, false)).toBe('&quot;a&quot; &lt; b &amp;&amp; c');
    expect(escapeForDocument('"a"', true, true)).toBe('"a"');
    expect(escapeForDocument('"a"', false, false)).toBe('"a"');
  });
});

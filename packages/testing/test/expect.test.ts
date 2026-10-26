import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check, jsonMismatch } from '../src/expect';
import type { RunResult } from '../src/protocol';
import { parseTestFile } from '../src/testFile';

const file = join(__dirname, 'extract', 'apis', 'orders', 'tests', 'x.yaml');
const result = (over: Partial<RunResult> = {}): RunResult => ({
  response: { status: 200, reason: 'OK', headers: { 'Content-Type': ['application/json'] }, body: '{"a":1,"list":[1,2],"o":{"k":"v"}}' },
  variables: { s: { type: 'String', value: 'x' }, n: { type: 'Int32', value: 5 }, o: { type: 'JObject', value: { id: 1, extra: true } } },
  calls: [
    { kind: 'backend', method: 'GET', url: 'https://b/api/one?x=1', headers: { A: ['1'] }, body: '{"q":1}' },
    { kind: 'backend', method: 'POST', url: 'https://b/api/two', headers: {}, body: '' },
  ],
  trace: [{ source: 'users', severity: 'error', message: 'cache miss for 7', metadata: {} }],
  steps: [],
  ...over,
});
const messages = async (expectYaml: string, r = result()) => (await check(parseTestFile(file, `request: { url: /x }\nexpect:\n${expectYaml}`)[0], r)).map((m) => m.message);

describe('checking a run', () => {
  it('passes when everything expected holds', async () => {
    expect(
      await messages(`
  response:
    status: 200
    reason: OK
    headers: { content-type: application/json, X-None: null }
    body: { json: { a: 1, o: { k: v } } }
  variables: { s: x, n: 5, o: { id: 1 }, gone: null }
  calls:
    - { method: GET, url: "https://b/api/one*", headers: { a: "1" }, body: { json: { q: 1 } } }
    - { method: POST, body: { empty: true } }
  trace:
    - { source: users, severity: error, contains: miss }
  error: null
`),
    ).toEqual([]);
  });

  it('says what each part of the response got instead', async () => {
    expect(
      await messages(`
  response:
    status: 404
    reason: Not Found
    headers: { Content-Type: text/plain, X-Missing: a, content-type2: null }
    body: { contains: zzz }
`),
    ).toEqual([
      'Expected status 404, got 200.',
      'Expected reason "Not Found", got "OK".',
      'Expected response header Content-Type: text/plain, got application/json.',
      "Expected a X-Missing header on the response, but there's none.",
      expect.stringContaining('Response body: expected it to contain "zzz"'),
    ]);
    expect(await messages('  response: { headers: { Content-Type: null } }')).toEqual(['Expected no Content-Type header on the response, got application/json.']);
    expect(await messages('  response: { status: 200 }', result({ response: undefined }))).toEqual(['Expected a response, but the run produced none.']);
  });

  it('compares bodies as text, files, JSON and empty', async () => {
    const r = (body: string | undefined) => result({ response: { status: 200, headers: {}, body } });
    expect(await messages('  response: { body: exact }', r('exact'))).toEqual([]);
    expect(await messages('  response: { body: exact }', r('other'))).toEqual(['Response body: expected "exact", got "other".']);
    expect(await messages('  response: { body: { empty: true } }', r(undefined))).toEqual([]);
    expect(await messages('  response: { body: { empty: true } }', r('x'))).toEqual(['Response body: expected empty, got "x".']);
    expect(await messages('  response: { body: { file: data/order.json } }', r('{ "id": 42, "items": ["apple"] }'))).toEqual([]);
    expect(await messages('  response: { body: { file: data/order.json } }', r('{}'))).toEqual(['Response body: expected the text of data/order.json, got "{}".']);
    expect(await messages('  response: { body: { file: data/none.json } }', r('{}'))).toEqual(["Response body: the expected body file data/none.json isn't there."]);
    expect(await messages('  response: { body: { json: { a: 1 } } }', r('not json'))).toEqual(['Response body: expected JSON, got "not json".']);
    expect(await messages('  response: { body: { json: { a: 2 } } }', r('{"a":1}'))).toEqual(['Response body: a: expected 2, got 1.']);
    expect(await messages('  response: { body: { text: x } }', r('y'.repeat(300)))).toEqual([expect.stringMatching(/\.\.\."\.$/)]);
  });

  it('says how variables differ', async () => {
    expect(await messages('  variables: { s: y, n: "5", o: { id: 2 }, missing: 1, s2: null }', result({ variables: { ...result().variables, s2: { type: 'String', value: 'z' } } }))).toEqual([
      'Variable s: expected "y", got "x" (it\'s a String).',
      'Variable n: expected "5", got 5 (it\'s a Int32).',
      'Variable o.id: expected 2, got 1 (it\'s a JObject).',
      "Expected variable missing to be 1, but it isn't set.",
      'Expected variable s2 not to be set, but it\'s "z" (String).',
    ]);
  });

  it('finds calls in order and says which are missing', async () => {
    expect(await messages('  calls:\n    - { url: "https://b/api/two" }\n    - { url: "https://b/api/one*" }')).toEqual([
      'No call matching https://b/api/one* after the previous one. Calls made: GET https://b/api/one?x=1; POST https://b/api/two.',
    ]);
    expect(await messages('  calls: []')).toEqual(['Expected no calls out, got 2: GET https://b/api/one?x=1; POST https://b/api/two.']);
    expect(await messages('  calls: [ {} ]', result({ calls: [] }))).toEqual(['No call matching. Calls made: none.']);
    expect(await messages('  calls: [ { method: DELETE } ]')).toEqual([expect.stringContaining('No call matching DELETE')]);
    expect(await messages('  calls: [ { headers: { A: "2" } } ]')).toHaveLength(1);
    expect(await messages('  calls: [ { body: { text: x } } ]')).toHaveLength(1);
    expect(await messages('  calls: [ { body: { contains: q } } ]')).toEqual([]);
    expect(await messages('  calls: [ { url: "https://b/api/two", body: { json: {} } } ]')).toHaveLength(1);
    expect(await messages('  calls: [ { body: { file: x.json } } ]')).toHaveLength(1);
  });

  it('looks for trace entries', async () => {
    expect(await messages('  trace: [ { contains: hit } ]')).toEqual(['No trace entry with containing "hit". Traced: users: cache miss for 7.']);
    expect(await messages('  trace: [ {} ]', result({ trace: [] }))).toEqual(['No trace entry with anything. Traced: nothing.']);
  });

  it('checks the error that sent the run to on-error', async () => {
    const error = { source: 'set-body', reason: 'ExpressionValueEvaluationFailure', message: 'Expression evaluation failed. Boom', scope: 'api', section: 'outbound', path: 'outbound/set-body', line: 3 };
    expect(await messages('  error: null', result({ error }))).toEqual(['Expected no error, but set-body failed: Expression evaluation failed. Boom']);
    expect(await messages('  error: { reason: ExpressionValueEvaluationFailure, source: set-body, section: outbound, contains: Boom }', result({ error }))).toEqual([]);
    expect(await messages('  error: { reason: R, source: S, section: inbound, contains: Bang }', result({ error }))).toEqual([
      'The error has reason ExpressionValueEvaluationFailure, not R, source set-body, not S, section outbound, not inbound, message "Expression evaluation failed. Boom" without "Bang".',
    ]);
    expect(await messages('  error: {}')).toEqual(['Expected an error to send the run to on-error, but none did.']);
  });

  it('places each mismatch at its expectation', async () => {
    const t = parseTestFile(file, 'request: { url: /x }\nexpect:\n  response:\n    status: 1\n  variables:\n    s: y\n')[0];
    expect((await check(t, result())).map((m) => m.line)).toEqual([4, 6]);
  });
});

describe('JSON matching', () => {
  it('matches objects as subsets and lists exactly', () => {
    expect(jsonMismatch({ a: [1, { b: 2 }] }, { a: [1, { b: 2, c: 3 }], d: 4 }, '')).toBeUndefined();
    expect(jsonMismatch({ a: [1] }, { a: [1, 2] }, '')).toBe('a: expected 1 items, got 2');
    expect(jsonMismatch({ a: [1] }, { a: 'x' }, '')).toBe('a: expected a list, got "x"');
    expect(jsonMismatch({ a: [1, 2] }, { a: [1, 3] }, '')).toBe('a[1]: expected 2, got 3');
    expect(jsonMismatch({ a: 1 }, [1], '')).toBe('the body: expected an object, got [1]');
    expect(jsonMismatch({ a: 1 }, {}, '')).toBe('a: expected 1, but it\'s missing');
    expect(jsonMismatch(null, null, '')).toBeUndefined();
  });
});

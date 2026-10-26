import { describe, expect, it } from 'vitest';
import { merge, parseTestFile, TestFileError } from '../src/testFile';

const parse = (text: string) => parseTestFile('/r/apis/a/tests/t.yaml', text);
const errorOf = (text: string) => {
  try {
    parse(text);
  } catch (e) {
    if (e instanceof TestFileError) return { line: e.line, message: e.message };
    throw e;
  }
  throw new Error('expected a TestFileError');
};
/** Asserts the text fails with a message containing `message`, at `line` when given. */
const fails = (text: string, message: string, line?: number) => {
  const e = errorOf(text);
  expect(e.message).toContain(message);
  if (line !== undefined) expect(e.line).toBe(line);
};

describe('test files', () => {
  it('reads one test, with defaults filled in', () => {
    const [t] = parse('request:\n  url: /x\n');
    expect(t).toMatchObject({ name: 't', line: 1, section: 'inbound', namedValues: {}, variables: {}, context: {}, expect: {} });
    expect(t.request).toEqual({ method: 'GET', url: '/x', headers: {}, matchedParameters: {}, body: undefined, ipAddress: undefined });
  });

  it('reads every field', () => {
    const [t] = parse(`
name: everything
policy: operations/get
product: gold
section: outbound
namedValues: { a: 1, b: true }
variables: { v: { k: 1 } }
context: { api: { name: A } }
request:
  method: post
  url: https://h/x
  headers: { Accept: [a, b], X-N: 5 }
  body: { json: { a: 1 } }
  matchedParameters: { id: 7 }
  ipAddress: 10.0.0.1
backend:
  status: 201
  reason: Made
  headers: { Content-Type: text/plain }
  body: hi
expect:
  response:
    status: 201
    reason: Made
    headers: { X-A: a, X-Gone: null }
    body: { contains: hi }
  variables: { v: 1, gone: null }
  calls:
    - { method: post, url: "https://h/*", headers: { A: b }, body: { empty: true } }
  trace:
    - { source: s, severity: error, contains: c }
  error: { reason: R, source: S, section: inbound, contains: C }
`);
    expect(t).toMatchObject({ name: 'everything', policy: 'operations/get', product: 'gold', section: 'outbound', namedValues: { a: '1', b: 'true' }, variables: { v: { k: 1 } } });
    expect(t.request).toEqual({ method: 'POST', url: 'https://h/x', headers: { Accept: ['a', 'b'], 'X-N': ['5'] }, body: { json: { a: 1 } }, matchedParameters: { id: '7' }, ipAddress: '10.0.0.1' });
    expect(t.backend).toEqual({ status: 201, reason: 'Made', headers: { 'Content-Type': ['text/plain'] }, body: { text: 'hi' } });
    expect(t.expect.response).toEqual({ status: 201, reason: 'Made', headers: { 'X-A': ['a'], 'X-Gone': null }, body: { contains: 'hi' } });
    expect(t.expect.calls).toEqual([{ method: 'POST', url: 'https://h/*', headers: { A: ['b'] }, body: { empty: true } }]);
    expect(t.expect.error).toEqual({ reason: 'R', source: 'S', section: 'inbound', contains: 'C' });
    expect(t.lines).toMatchObject({ 'response.status': 23, 'response.headers.X-Gone': 25, 'variables.gone': 27, 'calls.0': 29, 'trace.0': 31, error: 32 });
  });

  it('runs each case with the fields above it merged in', () => {
    const tests = parse(`
product: gold
request: { url: /x, headers: { A: a } }
expect: { error: null }
cases:
  - name: one
  - name: two
    product: silver
    request: { headers: { B: b } }
`);
    expect(tests.map((t) => [t.name, t.product, t.line, t.request.headers, t.expect.error])).toEqual([
      ['one', 'gold', 6, { A: ['a'] }, null],
      ['two', 'silver', 7, { A: ['a'], B: ['b'] }, null],
    ]);
  });

  it('says where a file is wrong', () => {
    fails('request: [unclosed', 'Not valid YAML', 1);
    fails('- a\n- b', 'is a mapping');
    fails('request: { url: /x }\nreqest: {}', "Unknown field 'reqest'", 2);
    fails('request: { url: /x }\nmocks: []', "mocks isn't supported yet", 2);
    fails('name: x', 'needs a request');
    fails('request: { method: GET }', 'needs a url');
    fails('request: { url: /x }\nsection: middle', 'section is', 2);
    fails('request: { url: /x }\ncases: []', 'cases is a list');
    fails('request: { url: /x }\ncases: [1]', 'Each case is a mapping.');
    fails('request: { url: /x }\ncases:\n  - policy: p', 'Each case needs a name.', 3);
    fails('request: { url: /x, body: { text: 1 } }', 'text is a string.');
    fails('request: { url: /x, body: { html: x } }', 'A body is text');
    fails('request: { url: /x, headers: { A: { b: 1 } } }', 'Header A');
    fails('request: { url: /x }\nnamedValues: { a: [1] }', 'namedValues.a is a value.');
    fails('request: { url: /x }\nbackend: { status: ok }', 'status is a number.');
    fails('request: { url: /x }\nbackend: 3', 'backend is a mapping.');
    fails('request: { url: /x }\npolicy: [a]', 'policy is a string.');
    fails('request: { url: /x }\nexpect: { response: { status: x } }', 'status is a number.');
    fails('request: { url: /x }\nexpect: { response: { body: { empty: false } } }', 'empty is true.');
    fails('request: { url: /x }\nexpect: { response: { body: { contains: 1 } } }', 'contains is a string.');
    fails('request: { url: /x }\nexpect: { response: { body: { xml: a } } }', 'An expected body');
    fails('request: { url: /x }\nexpect: { calls: {} }', 'calls is a list.');
    fails('request: { url: /x }\nexpect: { trace: {} }', 'trace is a list.');
    fails('request: { url: /x }\nexpect: { calls: [ { uri: x } ] }', "Unknown field 'uri'");
  });

  it('reads bodies as text, files and the short form', () => {
    const [t] = parse('request: { url: /x, body: { file: data/a.json } }\nexpect: { response: { body: done }, calls: [ { body: { json: [1] } } ] }');
    expect(t.request.body).toEqual({ file: 'data/a.json' });
    expect(t.expect.response?.body).toEqual({ text: 'done' });
    expect(t.expect.calls?.[0].body).toEqual({ json: [1] });
  });
});

describe('merging', () => {
  it('merges mappings and replaces everything else', () => {
    expect(merge({ a: { b: 1, c: 2 }, l: [1], s: 'x' }, { a: { c: 3 }, l: [2], s: { y: 1 } })).toEqual({ a: { b: 1, c: 3 }, l: [2], s: { y: 1 } });
  });
});

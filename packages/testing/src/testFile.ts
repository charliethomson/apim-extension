/**
 * The test file format: YAML in a `tests/` folder beside the scope it tests. A file is one test, or
 * a list of `cases` that share the fields above them (objects merge, the case's own values win).
 * docs/testing.md has the reference.
 */

import { basename } from 'node:path';
import { LineCounter, parseDocument, type Document as YamlDocument } from 'yaml';

/** A body: text as written, or JSON (sent as its text), or a file beside the test. */
export type BodySpec = { text: string } | { json: unknown } | { file: string };

export interface RequestSpec {
  method: string;
  /** Absolute, or starting with `/`: under the API's path on a test host. */
  url: string;
  headers: Record<string, string[]>;
  body?: BodySpec;
  matchedParameters: Record<string, string>;
  ipAddress?: string;
}

export interface ResponseSpec {
  status: number;
  reason?: string;
  headers: Record<string, string[]>;
  body?: BodySpec;
}

/** What a body should be: exactly some text or file, containing some text, JSON containing some JSON, or empty. */
export type BodyExpect = { text: string } | { contains: string } | { json: unknown } | { file: string } | { empty: true };

export interface CallExpect {
  method?: string;
  /** `*` matches any run of characters. */
  url?: string;
  /** Each must be there with these values; null means the header must be absent. */
  headers?: Record<string, string[] | null>;
  body?: BodyExpect;
}

export interface Expect {
  response?: { status?: number; reason?: string; headers?: Record<string, string[] | null>; body?: BodyExpect };
  /** Values to compare (JSON objects as a subset); null means the variable must not be set. */
  variables?: Record<string, unknown>;
  /** In order, though other calls may come between; an empty list means no calls at all. */
  calls?: CallExpect[];
  /** Each must match some entry. */
  trace?: { source?: string; severity?: string; contains?: string }[];
  /** What sent the run to on-error; null means nothing should. */
  error?: { reason?: string; source?: string; section?: string; contains?: string } | null;
}

export interface TestCase {
  /** The test file, as given. */
  file: string;
  name: string;
  /** Where the test starts in its file, from 1. */
  line: number;
  /** The policy to test, relative to the scope folder holding `tests/` (e.g. `operations/get-users`). */
  policy?: string;
  /** Which product's chain, when the API is in more than one. */
  product?: string;
  /** For a fragment's tests: the section it runs in. */
  section: 'inbound' | 'backend' | 'outbound' | 'on-error';
  namedValues: Record<string, string>;
  /** Variables set before the run, as a fragment's inputs would be. */
  variables: Record<string, unknown>;
  request: RequestSpec;
  backend?: ResponseSpec;
  context: Record<string, unknown>;
  expect: Expect;
  /** The line of each expectation, by its path (`response.status`, `variables.x`, `calls.0`). */
  lines: Record<string, number>;
}

/** A test file that can't be read as tests, with the line to look at. */
export class TestFileError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

const TOP = ['name', 'policy', 'product', 'section', 'namedValues', 'variables', 'request', 'backend', 'context', 'expect', 'cases'];
const NOT_YET: Record<string, string> = {
  mocks: 'send-request mocks come in a later version',
  cache: 'cache seeding comes in a later version',
};

/** The tests in a file's text. Throws `TestFileError` for anything malformed. */
export function parseTestFile(file: string, text: string): TestCase[] {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, prettyErrors: false, uniqueKeys: true });
  const lineAt = (offset: number | undefined) => (offset === undefined ? 1 : counter.linePos(offset).line);
  if (doc.errors.length) throw new TestFileError(file, lineAt(doc.errors[0].pos[0]), `Not valid YAML: ${doc.errors[0].message.split('\n')[0]}`);
  const root: unknown = doc.toJS();
  const r = new Reader(file, doc, lineAt);
  if (!isObject(root)) throw new TestFileError(file, 1, 'A test file is a mapping: name, request, expect, and the rest.');
  r.keys(root, [], TOP);
  const { cases, ...defaults } = root;
  if (cases === undefined) return [r.testCase(defaults, [], typeof defaults.name === 'string' ? defaults.name : basename(file).replace(/\.ya?ml$/, ''))];
  if (!Array.isArray(cases) || !cases.length) throw r.error(['cases'], 'cases is a list of tests.');
  return cases.map((c, i) => {
    if (!isObject(c)) throw r.error(['cases', i], 'Each case is a mapping.');
    r.keys(c, ['cases', i], TOP.filter((k) => k !== 'cases'));
    if (typeof c.name !== 'string') throw r.error(['cases', i], 'Each case needs a name.');
    return r.testCase(merge(defaults, c), ['cases', i], c.name);
  });
}

type Path = (string | number)[];

class Reader {
  constructor(
    readonly file: string,
    readonly doc: YamlDocument,
    readonly lineAt: (offset: number | undefined) => number,
  ) {}

  /** The line of the YAML node at `path`, or of its nearest parent that exists. */
  line(path: Path): number {
    for (let p = path; ; p = p.slice(0, -1)) {
      const node = (p.length ? this.doc.getIn(p, true) : this.doc.contents) as { range?: [number, number, number] } | undefined;
      if (node?.range) return this.lineAt(node.range[0]);
      if (!p.length) return 1;
    }
  }

  error(path: Path, message: string): TestFileError {
    return new TestFileError(this.file, this.line(path), message);
  }

  keys(o: Record<string, unknown>, path: Path, allowed: string[]): void {
    for (const k of Object.keys(o)) {
      if (allowed.includes(k)) continue;
      throw this.error([...path, k], NOT_YET[k] ? `${k} isn't supported yet: ${NOT_YET[k]}.` : `Unknown field '${k}'. Expected one of: ${allowed.join(', ')}.`);
    }
  }

  /** A case's fields, read from `o` (the defaults merged in), whose own YAML is at `path`. */
  testCase(o: Record<string, unknown>, path: Path, name: string): TestCase {
    const at = (key: string) => (this.doc.hasIn([...path, key]) ? [...path, key] : [key]);
    const lines: Record<string, number> = {};
    const section = o.section ?? 'inbound';
    if (!['inbound', 'backend', 'outbound', 'on-error'].includes(section as string)) throw this.error(at('section'), 'section is inbound, backend, outbound or on-error.');
    if (o.request === undefined) throw this.error(path, 'A test needs a request (at least its url).');
    return {
      file: this.file,
      name,
      line: this.line(path),
      policy: this.optionalString(o.policy, at('policy'), 'policy'),
      product: this.optionalString(o.product, at('product'), 'product'),
      section: section as TestCase['section'],
      namedValues: this.stringMap(o.namedValues ?? {}, at('namedValues'), 'namedValues'),
      variables: o.variables === undefined ? {} : this.object(o.variables, at('variables'), 'variables'),
      request: this.request(o.request, at('request')),
      backend: o.backend === undefined ? undefined : this.response(o.backend, at('backend')),
      context: o.context === undefined ? {} : this.object(o.context, at('context'), 'context'),
      expect: this.expect(o.expect ?? {}, at('expect'), lines),
      lines,
    };
  }

  request(v: unknown, path: Path): RequestSpec {
    const o = this.object(v, path, 'request');
    this.keys(o, path, ['method', 'url', 'headers', 'body', 'matchedParameters', 'ipAddress']);
    if (typeof o.url !== 'string' || !o.url) throw this.error(path, 'request needs a url: absolute, or a path under the API like /users?nat=GB.');
    return {
      method: this.optionalString(o.method, [...path, 'method'], 'method')?.toUpperCase() ?? 'GET',
      url: o.url,
      headers: this.headers(o.headers ?? {}, [...path, 'headers']),
      body: o.body === undefined ? undefined : this.body(o.body, [...path, 'body']),
      matchedParameters: this.stringMap(o.matchedParameters ?? {}, [...path, 'matchedParameters'], 'matchedParameters'),
      ipAddress: this.optionalString(o.ipAddress, [...path, 'ipAddress'], 'ipAddress'),
    };
  }

  response(v: unknown, path: Path): ResponseSpec {
    const o = this.object(v, path, 'backend');
    this.keys(o, path, ['status', 'reason', 'headers', 'body']);
    const status = o.status ?? 200;
    if (!Number.isInteger(status)) throw this.error([...path, 'status'], 'status is a number.');
    return {
      status: status as number,
      reason: this.optionalString(o.reason, [...path, 'reason'], 'reason'),
      headers: this.headers(o.headers ?? {}, [...path, 'headers']),
      body: o.body === undefined ? undefined : this.body(o.body, [...path, 'body']),
    };
  }

  body(v: unknown, path: Path): BodySpec {
    if (typeof v === 'string') return { text: v };
    const o = this.object(v, path, 'body');
    const keys = Object.keys(o);
    if (keys.length !== 1 || !['text', 'json', 'file'].includes(keys[0])) throw this.error(path, 'A body is text, or one of text:, json: or file:.');
    if (keys[0] !== 'json' && typeof o[keys[0]] !== 'string') throw this.error(path, `${keys[0]} is a string.`);
    return o as BodySpec;
  }

  expect(v: unknown, path: Path, lines: Record<string, number>): Expect {
    const o = this.object(v, path, 'expect');
    this.keys(o, path, ['response', 'variables', 'calls', 'trace', 'error']);
    const out: Expect = {};
    const mark = (key: string, p: Path) => (lines[key] = this.line(p));
    if (o.response !== undefined) {
      const p = [...path, 'response'];
      const res = this.object(o.response, p, 'expect.response');
      this.keys(res, p, ['status', 'reason', 'headers', 'body']);
      out.response = {};
      if (res.status !== undefined) {
        if (!Number.isInteger(res.status)) throw this.error([...p, 'status'], 'status is a number.');
        out.response.status = res.status as number;
        mark('response.status', [...p, 'status']);
      }
      if (res.reason !== undefined) {
        out.response.reason = this.optionalString(res.reason, [...p, 'reason'], 'reason');
        mark('response.reason', [...p, 'reason']);
      }
      if (res.headers !== undefined) {
        out.response.headers = this.expectedHeaders(res.headers, [...p, 'headers'], 'response.headers', mark);
      }
      if (res.body !== undefined) {
        out.response.body = this.bodyExpect(res.body, [...p, 'body']);
        mark('response.body', [...p, 'body']);
      }
    }
    if (o.variables !== undefined) {
      const p = [...path, 'variables'];
      out.variables = this.object(o.variables, p, 'expect.variables');
      for (const k of Object.keys(out.variables)) mark(`variables.${k}`, [...p, k]);
    }
    if (o.calls !== undefined) {
      const p = [...path, 'calls'];
      if (!Array.isArray(o.calls)) throw this.error(p, 'calls is a list.');
      mark('calls', p);
      out.calls = o.calls.map((c, i) => {
        const cp = [...p, i];
        const call = this.object(c, cp, 'a call');
        this.keys(call, cp, ['method', 'url', 'headers', 'body']);
        mark(`calls.${i}`, cp);
        return {
          method: this.optionalString(call.method, [...cp, 'method'], 'method')?.toUpperCase(),
          url: this.optionalString(call.url, [...cp, 'url'], 'url'),
          headers: call.headers === undefined ? undefined : this.expectedHeaders(call.headers, [...cp, 'headers'], `calls.${i}.headers`, mark),
          body: call.body === undefined ? undefined : this.bodyExpect(call.body, [...cp, 'body']),
        };
      });
    }
    if (o.trace !== undefined) {
      const p = [...path, 'trace'];
      if (!Array.isArray(o.trace)) throw this.error(p, 'trace is a list.');
      out.trace = o.trace.map((t, i) => {
        const tp = [...p, i];
        const entry = this.object(t, tp, 'a trace entry');
        this.keys(entry, tp, ['source', 'severity', 'contains']);
        mark(`trace.${i}`, tp);
        return {
          source: this.optionalString(entry.source, [...tp, 'source'], 'source'),
          severity: this.optionalString(entry.severity, [...tp, 'severity'], 'severity'),
          contains: this.optionalString(entry.contains, [...tp, 'contains'], 'contains'),
        };
      });
    }
    if (o.error !== undefined) {
      const p = [...path, 'error'];
      mark('error', p);
      if (o.error === null) out.error = null;
      else {
        const e = this.object(o.error, p, 'expect.error');
        this.keys(e, p, ['reason', 'source', 'section', 'contains']);
        out.error = {
          reason: this.optionalString(e.reason, [...p, 'reason'], 'reason'),
          source: this.optionalString(e.source, [...p, 'source'], 'source'),
          section: this.optionalString(e.section, [...p, 'section'], 'section'),
          contains: this.optionalString(e.contains, [...p, 'contains'], 'contains'),
        };
      }
    }
    return out;
  }

  bodyExpect(v: unknown, path: Path): BodyExpect {
    if (typeof v === 'string') return { text: v };
    const o = this.object(v, path, 'body');
    const keys = Object.keys(o);
    if (keys.length !== 1 || !['text', 'contains', 'json', 'file', 'empty'].includes(keys[0])) throw this.error(path, 'An expected body is text, or one of text:, contains:, json:, file: or empty: true.');
    if (keys[0] === 'empty' && o.empty !== true) throw this.error(path, 'empty is true.');
    if (['text', 'contains', 'file'].includes(keys[0]) && typeof o[keys[0]] !== 'string') throw this.error(path, `${keys[0]} is a string.`);
    return o as BodyExpect;
  }

  headers(v: unknown, path: Path): Record<string, string[]> {
    const o = this.object(v, path, 'headers');
    const out: Record<string, string[]> = {};
    for (const [k, value] of Object.entries(o)) {
      const list = Array.isArray(value) ? value : [value];
      if (!list.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) throw this.error([...path, k], `Header ${k} is a value or a list of values.`);
      out[k] = list.map(String);
    }
    return out;
  }

  expectedHeaders(v: unknown, path: Path, key: string, mark: (key: string, p: Path) => void): Record<string, string[] | null> {
    const o = this.object(v, path, 'headers');
    const out: Record<string, string[] | null> = {};
    for (const k of Object.keys(o)) {
      out[k] = o[k] === null ? null : this.headers({ [k]: o[k] }, path)[k];
      mark(`${key}.${k}`, [...path, k]);
    }
    return out;
  }

  stringMap(v: unknown, path: Path, what: string): Record<string, string> {
    const o = this.object(v, path, what);
    const out: Record<string, string> = {};
    for (const [k, value] of Object.entries(o)) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) throw this.error([...path, k], `${what}.${k} is a value.`);
      out[k] = String(value);
    }
    return out;
  }

  object(v: unknown, path: Path, what: string): Record<string, unknown> {
    if (!isObject(v)) throw this.error(path, `${what} is a mapping.`);
    return v;
  }

  optionalString(v: unknown, path: Path, what: string): string | undefined {
    if (v === undefined) return undefined;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v !== 'string') throw this.error(path, `${what} is a string.`);
    return v;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `over` on top of `base`: mappings merge key by key, anything else is replaced. */
export function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : v;
  return out;
}

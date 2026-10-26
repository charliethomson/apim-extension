/**
 * A test's expectations against what its run did. Each mismatch says what was expected and what
 * happened, at the line of the expectation in the test file.
 */

import { dirname, join } from 'node:path';
import type { RunResult } from './protocol';
import { nodeFiles, type ProjectFiles } from './project';
import type { BodyExpect, CallExpect, TestCase } from './testFile';

export interface Mismatch {
  message: string;
  line: number;
}

export async function check(test: TestCase, result: RunResult, files: ProjectFiles = nodeFiles): Promise<Mismatch[]> {
  const out: Mismatch[] = [];
  const miss = (key: string, message: string) => out.push({ message, line: test.lines[key] ?? test.line });
  const e = test.expect;

  if (e.response) {
    const r = result.response;
    if (!r) miss('response.status', 'Expected a response, but the run produced none.');
    else {
      if (e.response.status !== undefined && r.status !== e.response.status) miss('response.status', `Expected status ${e.response.status}, got ${r.status}.`);
      if (e.response.reason !== undefined && r.reason !== e.response.reason) miss('response.reason', `Expected reason "${e.response.reason}", got "${r.reason ?? ''}".`);
      for (const m of headerMismatches(e.response.headers, r.headers, 'response')) miss(`response.headers.${m.name}`, m.message);
      if (e.response.body) {
        const m = await bodyMismatch(e.response.body, r.body, test, files);
        if (m) miss('response.body', `Response body: ${m}`);
      }
    }
  }

  for (const [name, expected] of Object.entries(e.variables ?? {})) {
    const actual = result.variables[name];
    if (expected === null) {
      if (actual) miss(`variables.${name}`, `Expected variable ${name} not to be set, but it's ${show(actual.value)} (${actual.type}).`);
    } else if (!actual) miss(`variables.${name}`, `Expected variable ${name} to be ${show(expected)}, but it isn't set.`);
    else {
      const m = jsonMismatch(expected, actual.value, name);
      if (m) miss(`variables.${name}`, `Variable ${m} (it's a ${actual.type}).`);
    }
  }

  if (e.calls) {
    if (!e.calls.length && result.calls.length) miss('calls', `Expected no calls out, got ${result.calls.length}: ${result.calls.map(describeCall).join('; ')}.`);
    let from = 0;
    for (const [i, call] of e.calls.entries()) {
      const at = result.calls.findIndex((c, j) => j >= from && callMatches(call, c));
      if (at < 0) {
        const seen = result.calls.length ? result.calls.map(describeCall).join('; ') : 'none';
        miss(`calls.${i}`, `No call ${describeExpected(call)}${i ? ' after the previous one' : ''}. Calls made: ${seen}.`);
        break;
      }
      from = at + 1;
    }
  }

  for (const [i, t] of (e.trace ?? []).entries()) {
    const found = result.trace.some((x) => (t.source === undefined || x.source === t.source) && (t.severity === undefined || x.severity === t.severity) && (t.contains === undefined || x.message.includes(t.contains)));
    if (!found) {
      const want = [t.source && `source ${t.source}`, t.severity && `severity ${t.severity}`, t.contains && `containing "${t.contains}"`].filter(Boolean).join(', ');
      miss(`trace.${i}`, `No trace entry with ${want || 'anything'}. Traced: ${result.trace.length ? result.trace.map((x) => `${x.source}: ${x.message}`).join('; ') : 'nothing'}.`);
    }
  }

  if (e.error === null && result.error) miss('error', `Expected no error, but ${result.error.source} failed: ${result.error.message}`);
  if (e.error) {
    const err = result.error;
    if (!err) miss('error', 'Expected an error to send the run to on-error, but none did.');
    else {
      const wrong = [
        e.error.reason !== undefined && err.reason !== e.error.reason && `reason ${err.reason}, not ${e.error.reason}`,
        e.error.source !== undefined && err.source !== e.error.source && `source ${err.source}, not ${e.error.source}`,
        e.error.section !== undefined && err.section !== e.error.section && `section ${err.section}, not ${e.error.section}`,
        e.error.contains !== undefined && !err.message.includes(e.error.contains) && `message "${err.message}" without "${e.error.contains}"`,
      ].filter(Boolean);
      if (wrong.length) miss('error', `The error has ${wrong.join(', ')}.`);
    }
  }
  return out;
}

function headerMismatches(expected: Record<string, string[] | null> | undefined, actual: Record<string, string[]>, what: string): { name: string; message: string }[] {
  const out: { name: string; message: string }[] = [];
  for (const [name, want] of Object.entries(expected ?? {})) {
    const got = Object.entries(actual).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    if (want === null) {
      if (got) out.push({ name, message: `Expected no ${name} header on the ${what}, got ${got.join(', ')}.` });
    } else if (!got) out.push({ name, message: `Expected a ${name} header on the ${what}, but there's none.` });
    else if (got.join('\u0000') !== want.join('\u0000')) out.push({ name, message: `Expected ${what} header ${name}: ${want.join(', ')}, got ${got.join(', ')}.` });
  }
  return out;
}

async function bodyMismatch(want: BodyExpect, got: string | undefined, test: TestCase, files: ProjectFiles): Promise<string | undefined> {
  const text = got ?? '';
  if ('empty' in want) return text === '' ? undefined : `expected empty, got ${quote(text)}.`;
  if ('text' in want) return text === want.text ? undefined : `expected ${quote(want.text)}, got ${quote(text)}.`;
  if ('contains' in want) return text.includes(want.contains) ? undefined : `expected it to contain ${quote(want.contains)}, got ${quote(text)}.`;
  if ('file' in want) {
    const expected = await files.read(join(dirname(test.file), want.file));
    if (expected === undefined) return `the expected body file ${want.file} isn't there.`;
    return text.trimEnd() === expected.trimEnd() ? undefined : `expected the text of ${want.file}, got ${quote(text)}.`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `expected JSON, got ${quote(text)}.`;
  }
  const m = jsonMismatch(want.json, parsed, '');
  return m && `${m}.`;
}

/**
 * Where `actual` doesn't hold `expected`, or undefined when it does. Objects match when every
 * expected key matches (others may be there); arrays need the same length, element by element.
 */
export function jsonMismatch(expected: unknown, actual: unknown, path: string): string | undefined {
  const at = path || 'the body';
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return `${at}: expected an object, got ${show(actual)}`;
    for (const [k, v] of Object.entries(expected)) {
      const child = path ? `${path}.${k}` : k;
      if (!(k in actual)) return `${child}: expected ${show(v)}, but it's missing`;
      const m = jsonMismatch(v, (actual as Record<string, unknown>)[k], child);
      if (m) return m;
    }
    return undefined;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${at}: expected a list, got ${show(actual)}`;
    if (actual.length !== expected.length) return `${at}: expected ${expected.length} items, got ${actual.length}`;
    for (let i = 0; i < expected.length; i++) {
      const m = jsonMismatch(expected[i], actual[i], `${path}[${i}]`);
      if (m) return m;
    }
    return undefined;
  }
  return expected === actual ? undefined : `${at}: expected ${show(expected)}, got ${show(actual)}`;
}

function callMatches(want: CallExpect, got: RunResult['calls'][number]): boolean {
  if (want.method && got.method.toUpperCase() !== want.method) return false;
  if (want.url && !glob(want.url).test(got.url)) return false;
  if (headerMismatches(want.headers, got.headers, 'call').length) return false;
  if (want.body) {
    const b = want.body;
    const text = got.body ?? '';
    if ('empty' in b) return text === '';
    if ('text' in b) return text === b.text;
    if ('contains' in b) return text.includes(b.contains);
    if ('json' in b) {
      try {
        return jsonMismatch(b.json, JSON.parse(text), '') === undefined;
      } catch {
        return false;
      }
    }
    return false;
  }
  return true;
}

function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

function describeCall(c: RunResult['calls'][number]): string {
  return `${c.method} ${c.url}`;
}

function describeExpected(c: CallExpect): string {
  const parts = [c.method, c.url].filter(Boolean).join(' ');
  return parts ? `matching ${parts}` : 'matching';
}

function show(v: unknown): string {
  const text = JSON.stringify(v) ?? String(v);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function quote(text: string): string {
  return text.length > 200 ? JSON.stringify(`${text.slice(0, 197)}...`) : JSON.stringify(text);
}

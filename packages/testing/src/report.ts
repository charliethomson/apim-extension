/**
 * Test results for people and for CI: a text summary, JUnit XML (which Azure DevOps'
 * PublishTestResults task reads), and Azure DevOps logging commands, which put each failure on the
 * build summary at its file and line.
 */

import { relative, sep } from 'node:path';
import type { TestResult } from './run';

/** A path for output: relative to `cwd` with forward slashes, when it's under it. */
export function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return (rel && !rel.startsWith('..') ? rel : path).split(sep).join('/');
}

/** One line per test, then each failure's messages, then the totals. */
export function textReport(results: readonly TestResult[], cwd: string): string {
  const lines: string[] = [];
  for (const r of results) {
    const mark = r.status === 'passed' ? 'ok  ' : r.status === 'failed' ? 'FAIL' : 'ERR ';
    lines.push(`${mark} ${displayPath(r.file, cwd)} > ${r.name} (${Math.round(r.durationMs)} ms)`);
    for (const m of r.messages) lines.push(`       ${displayPath(m.file, cwd)}:${m.line}${m.col ? `:${m.col}` : ''} ${m.message}`);
  }
  lines.push('', summary(results));
  return lines.join('\n');
}

export function summary(results: readonly TestResult[]): string {
  const count = (s: TestResult['status']) => results.filter((r) => r.status === s).length;
  const parts = [`${count('passed')} passed`];
  if (count('failed')) parts.push(`${count('failed')} failed`);
  if (count('error')) parts.push(`${count('error')} couldn't run`);
  return `${results.length} test${results.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

/** JUnit XML: a suite per test file, a case per test; a failed expectation is a failure, a test that couldn't run an error. */
export function junitReport(results: readonly TestResult[], cwd: string, name = 'APIM policy tests'): string {
  const byFile = new Map<string, TestResult[]>();
  for (const r of results) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  const seconds = (ms: number) => (ms / 1000).toFixed(3);
  const total = (rs: readonly TestResult[], s?: TestResult['status']) => rs.filter((r) => !s || r.status === s).length;
  const time = (rs: readonly TestResult[]) => seconds(rs.reduce((t, r) => t + r.durationMs, 0));
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${xml(name)}" tests="${total(results)}" failures="${total(results, 'failed')}" errors="${total(results, 'error')}" time="${time(results)}">`,
  ];
  for (const [file, rs] of byFile) {
    const path = displayPath(file, cwd);
    out.push(`  <testsuite name="${xml(path)}" tests="${total(rs)}" failures="${total(rs, 'failed')}" errors="${total(rs, 'error')}" time="${time(rs)}">`);
    for (const r of rs) {
      const open = `    <testcase name="${xml(r.name)}" classname="${xml(path)}" file="${xml(path)}" line="${r.line}" time="${seconds(r.durationMs)}"`;
      if (r.status === 'passed') {
        out.push(`${open} />`);
        continue;
      }
      const tag = r.status === 'failed' ? 'failure' : 'error';
      const detail = r.messages.map((m) => `${displayPath(m.file, cwd)}:${m.line} ${m.message}`).join('\n');
      out.push(`${open}>`, `      <${tag} message="${xml(r.messages[0]?.message ?? r.status)}">${xml(detail)}</${tag}>`, '    </testcase>');
    }
    out.push('  </testsuite>');
  }
  out.push('</testsuites>', '');
  return out.join('\n');
}

/** `##vso[task.logissue]` lines, one per message of each test that didn't pass. */
export function azureDevOpsLines(results: readonly TestResult[], cwd: string): string[] {
  return results.flatMap((r) =>
    r.status === 'passed'
      ? []
      : r.messages.map((m) => {
          const props = [`type=error`, `sourcepath=${vsoProp(displayPath(m.file, cwd))}`, `linenumber=${m.line}`, ...(m.col ? [`columnnumber=${m.col}`] : [])];
          return `##vso[task.logissue ${props.join(';')};]${vsoData(`${r.name}: ${m.message}`)}`;
        }),
  );
}

function xml(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escaping for a logging command's message, from the azure-pipelines-task-lib rules. */
function vsoData(text: string): string {
  return text.replace(/%/g, '%AZP25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escaping for a logging command's property value. */
function vsoProp(text: string): string {
  return vsoData(text).replace(/]/g, '%5D').replace(/;/g, '%3B');
}

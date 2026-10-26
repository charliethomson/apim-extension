/** Finding test files and running them: each case built into a run, run, and checked. */

import { readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { check } from './expect';
import { buildRun, locate, nodeFiles, Project, type ProjectFiles } from './project';
import type { RunResult } from './protocol';
import type { Runner } from './runner';
import { parseTestFile, type TestCase, TestFileError } from './testFile';

export interface TestMessage {
  message: string;
  file: string;
  line: number;
  col?: number;
}

export interface TestResult {
  /** The test file. */
  file: string;
  /** The case's name; for a file that couldn't be read, the file's name. */
  name: string;
  line: number;
  /** passed; failed (an expectation didn't hold); error (the test couldn't run). */
  status: 'passed' | 'failed' | 'error';
  messages: TestMessage[];
  durationMs: number;
  result?: RunResult;
}

/** Test files under `paths`: YAML files in a `tests/` folder, or the files given. Sorted, without node_modules or .git. */
export async function findTestFiles(paths: readonly string[]): Promise<string[]> {
  const out = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) await walk(full);
      } else if (/\.ya?ml$/i.test(e.name) && dir.split(sep).pop() === 'tests') out.add(full);
    }
  };
  for (const p of paths) {
    if ((await stat(p)).isDirectory()) await walk(p);
    else out.add(p);
  }
  return [...out].sort();
}

export interface RunOptions {
  /** Starts a runner, or returns the running one; called again after one stops. */
  runner: () => Promise<Runner>;
  /** Only cases whose name contains this text (ignoring case). */
  filter?: string;
  files?: ProjectFiles;
  /** Called after each case, for progress output. */
  onResult?: (result: TestResult) => void;
}

export async function runTests(testFiles: readonly string[], options: RunOptions): Promise<TestResult[]> {
  const files = options.files ?? nodeFiles;
  const projects = new Map<string, Project>();
  const results: TestResult[] = [];
  const report = (r: TestResult) => {
    results.push(r);
    options.onResult?.(r);
  };
  for (const file of testFiles) {
    const started = performance.now();
    let cases: TestCase[];
    try {
      const text = await files.read(file);
      if (text === undefined) throw new TestFileError(file, 1, "The test file isn't there.");
      cases = parseTestFile(file, text);
    } catch (e) {
      report(errorResult(file, file.split(/[\\/]/).pop()!, 1, e, started));
      continue;
    }
    const filter = options.filter?.toLowerCase();
    for (const test of cases) {
      if (filter && !test.name.toLowerCase().includes(filter)) continue;
      report(await runCase(test, options, files, projects));
    }
  }
  return results;
}

async function runCase(test: TestCase, options: RunOptions, files: ProjectFiles, projects: Map<string, Project>): Promise<TestResult> {
  const started = performance.now();
  const base = { file: test.file, name: test.name, line: test.line };
  try {
    const located = await locate(test, files);
    let project = projects.get(located.root);
    if (!project) projects.set(located.root, (project = new Project(located.root, files)));
    const input = await buildRun(test, project, located);
    const result = await (await options.runner()).run(input);
    const durationMs = performance.now() - started;
    if (result.failure) {
      const f = result.failure;
      const messages: TestMessage[] = f.diagnostics.length
        ? f.diagnostics.map((d) => ({ message: `${d.code}: ${d.message}`, file: d.file ?? test.file, line: d.line, col: d.col }))
        : [{ message: f.message, file: f.file ?? test.file, line: f.file ? f.line : test.line, ...(f.col ? { col: f.col } : {}) }];
      return { ...base, status: 'error', messages, durationMs, result };
    }
    const mismatches = await check(test, result, files);
    return {
      ...base,
      status: mismatches.length ? 'failed' : 'passed',
      messages: mismatches.map((m) => ({ message: m.message, file: test.file, line: m.line })),
      durationMs,
      result,
    };
  } catch (e) {
    return errorResult(test.file, test.name, test.line, e, started);
  }
}

function errorResult(file: string, name: string, line: number, e: unknown, started: number): TestResult {
  const message = e instanceof Error ? e.message : String(e);
  return { file, name, line, status: 'error', messages: [{ message, file: e instanceof TestFileError ? e.file : file, line: e instanceof TestFileError ? e.line : line }], durationMs: performance.now() - started };
}

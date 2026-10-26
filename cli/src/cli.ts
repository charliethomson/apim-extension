/** `apim-policy`: finds the policy tests, runs them through the runner, and reports. */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  azureDevOpsLines,
  displayPath,
  findTestFiles,
  junitReport,
  ProcessRunner,
  type Runner,
  runnerCommand,
  runTests,
  summary,
  type TestResult,
} from '@charliethomson/apim-testing';
import { type Args, parseArgs, type TestArgs, USAGE, UsageError } from './args';

/** What the command works with, so tests can give their own. */
export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  version: string;
  /** The runner shipped beside the bundle; undefined in a dev checkout without one built. */
  bundledRunner?: string;
  /** Starts the runner; the default spawns it. */
  startRunner?: (command: { command: string; args: string[] }, timeoutMs: number) => Promise<Runner>;
}

/** Runs the command line and returns the exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(e.message);
    return 2;
  }
  switch (args.command) {
    case 'help':
      io.out(USAGE);
      return 0;
    case 'version':
      io.out(`apim-policy ${io.version}`);
      return 0;
    case 'test':
      return test(args, io);
  }
}

async function test(args: TestArgs, io: Io): Promise<number> {
  const paths = (args.paths.length ? args.paths : ['.']).map((p) => resolve(io.cwd, p));
  const missing = paths.find((p) => !existsSync(p));
  if (missing) {
    io.err(`${displayPath(missing, io.cwd)} isn't there.`);
    return 2;
  }
  const files = await findTestFiles(paths);
  if (!files.length) {
    io.err(`No tests found under ${paths.map((p) => displayPath(p, io.cwd) || '.').join(', ')}: tests are YAML files in a tests/ folder beside a policy.`);
    return 2;
  }

  const runnerPath = args.runner ? resolve(io.cwd, args.runner) : (io.env.APIM_POLICY_RUNNER ?? io.bundledRunner);
  if (!runnerPath) {
    io.err('No policy runner: this build has none bundled. Give one with --runner or APIM_POLICY_RUNNER.');
    return 2;
  }
  const cache = args.cache ? resolve(io.cwd, args.cache) : join(io.env.AGENT_TEMPDIRECTORY ?? tmpdir(), 'apim-policy-runner-cache');
  const startRunner = io.startRunner ?? ((command, timeoutMs) => ProcessRunner.start(command, timeoutMs));
  const start = () => startRunner(runnerCommand(runnerPath, cache), args.timeout * 1000);
  // Started once up front, so a missing runtime is one message rather than one per test.
  let current: Runner;
  try {
    current = await start();
  } catch (e) {
    io.err(explainStart(e, runnerPath));
    return 2;
  }
  const ado = args.azureDevOps ?? io.env.TF_BUILD?.toLowerCase() === 'true';

  const results = await runTests(files, {
    // A test that ran past the timeout stopped the runner; the next one gets a new one.
    runner: async () => ((current as { stopped?: boolean }).stopped ? (current = await start()) : current),
    filter: args.filter,
    onResult: (r) => print(r, io),
  });
  await current.close();

  io.out('');
  io.out(summary(results));
  if (ado) for (const line of azureDevOpsLines(results, io.cwd)) io.out(line);
  if (args.junit) await write(resolve(io.cwd, args.junit), junitReport(results, io.cwd));
  if (args.trace) await writeTraces(resolve(io.cwd, args.trace), results, io.cwd);

  if (!results.length) {
    io.err(`No test's name contains '${args.filter}'.`);
    return 2;
  }
  if (results.some((r) => r.status === 'error')) return 2;
  return results.some((r) => r.status === 'failed') ? 1 : 0;
}

function print(r: TestResult, io: Io): void {
  const mark = r.status === 'passed' ? 'ok  ' : r.status === 'failed' ? 'FAIL' : 'ERR ';
  io.out(`${mark} ${displayPath(r.file, io.cwd)} > ${r.name} (${Math.round(r.durationMs)} ms)`);
  for (const m of r.messages) io.out(`       ${displayPath(m.file, io.cwd)}:${m.line}${m.col ? `:${m.col}` : ''} ${m.message}`);
}

/** Why the runner didn't start, with what to do about it. */
function explainStart(e: unknown, runnerPath: string): string {
  const message = e instanceof Error ? e.message : String(e);
  if (runnerPath.toLowerCase().endsWith('.dll') && /ENOENT|didn't start/.test(message)) {
    return `${message}\nThe policy runner needs the .NET 10 runtime ('dotnet' on PATH). In Azure Pipelines, add a UseDotNet@2 step with packageType: runtime and version: 10.x.`;
  }
  return message;
}

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** One JSON file per test that ran, named for its file and case. */
async function writeTraces(dir: string, results: readonly TestResult[], cwd: string): Promise<void> {
  const used = new Set<string>();
  for (const r of results) {
    if (!r.result) continue;
    const base = `${displayPath(r.file, cwd)}--${r.name}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
    used.add(name);
    await write(join(dir, `${name}.json`), `${JSON.stringify({ file: displayPath(r.file, cwd), name: r.name, status: r.status, messages: r.messages, ...r.result }, null, 2)}\n`);
  }
}

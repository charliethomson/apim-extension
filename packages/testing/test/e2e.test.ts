/**
 * The test extract's tests against the real runner. They need a built runner, so they're skipped
 * without one: build it with `dotnet build runner/PolicyRunner`, or point APIM_POLICY_RUNNER at one.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findTestFiles, runTests } from '../src/run';
import { ProcessRunner, runnerCommand } from '../src/runner';
import { textReport } from '../src/report';
import { fixturesDir } from '@apim-policy/fixtures';

const built = join(__dirname, '..', '..', '..', 'runner', 'PolicyRunner', 'bin', 'Debug', 'net10.0', 'apim-policy-runner.dll');
const runnerPath = process.env.APIM_POLICY_RUNNER ?? (existsSync(built) ? built : undefined);
const extract = join(__dirname, 'extract');

describe.skipIf(!runnerPath)('against the real runner', () => {
  let runner: Promise<ProcessRunner> | undefined;
  afterAll(async () => (await runner)?.close());

  it("passes the test extract's tests", async () => {
    const files = await findTestFiles([extract]);
    const results = await runTests(files, { runner: () => (runner ??= ProcessRunner.start(runnerCommand(runnerPath!))) });
    const report = textReport(results, extract);
    expect(results.every((r) => r.status === 'passed'), report).toBe(true);
    expect(results.map((r) => r.name).sort()).toEqual([
      'answers an error from the backend body with on-error',
      'forwards stamped and decorates the response',
      'has no tier through silver',
      'rejects when asked to',
      'sends the order on with its id',
      'sets the tenant from its named value',
      'stamps with no tier',
    ]);
  }, 60_000);

  it("passes the shared APIOps fixture's tests", async () => {
    const apiops = join(fixturesDir, 'apiops');
    const results = await runTests(await findTestFiles([apiops]), { runner: () => (runner ??= ProcessRunner.start(runnerCommand(runnerPath!))) });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.status === 'passed'), textReport(results, apiops)).toBe(true);
  }, 60_000);
});

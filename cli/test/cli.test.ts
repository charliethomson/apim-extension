import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunInput, Runner, RunResult } from '@apim-policy/testing';
import { type Io, main } from '../src/cli';

const extract = join(__dirname, 'extract');
const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A runner answering 200, or a compile failure when the request has X-Break; `stopAfter` runs stop it. */
function fakeRunner(stopAfter = Infinity) {
  const started: { command: string; args: string[]; timeoutMs: number }[] = [];
  let closed = 0;
  const start = (command: { command: string; args: string[] }, timeoutMs: number): Promise<Runner> => {
    started.push({ ...command, timeoutMs });
    let runs = 0;
    const runner: Runner & { stopped: boolean } = {
      stopped: false,
      run: (input: RunInput): Promise<RunResult> => {
        if (++runs >= stopAfter) runner.stopped = true;
        const ok: RunResult = { response: { status: 200, headers: {} }, variables: {}, calls: [], trace: [], steps: [{ policy: 'base', scope: 'API echo', section: 'inbound', line: 3 }] };
        if (input.request.headers?.['X-Break']) return Promise.resolve({ ...ok, failure: { kind: 'compile', message: 'x', line: 0, col: 0, diagnostics: [{ code: 'CS1002', message: '; expected', file: join(extract, 'apis/echo/policy.xml'), line: 3, col: 9 }] } });
        return Promise.resolve(ok);
      },
      close: () => (closed++, Promise.resolve()),
    };
    return Promise.resolve(runner);
  };
  return { start, started, closed: () => closed };
}

function io(over: Partial<Io> = {}): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { cwd: extract, env: {}, out: (l) => stdout.push(l), err: (l) => stderr.push(l), version: '1.2.3 (abc)', bundledRunner: '/b/apim-policy-runner.dll', stdout, stderr, ...over };
}

const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'apim-cli-test-'));
  temps.push(d);
  return d;
};

describe('apim-policy', () => {
  it('shows help and the version', async () => {
    const a = io();
    expect(await main(['--help'], a)).toBe(0);
    expect(a.stdout[0]).toContain('Usage: apim-policy test');
    const b = io();
    expect(await main(['--version'], b)).toBe(0);
    expect(b.stdout).toEqual(['apim-policy 1.2.3 (abc)']);
  });

  it('says how it was called wrong, with exit code 2', async () => {
    const a = io();
    expect(await main(['tset'], a)).toBe(2);
    expect(a.stderr[0]).toContain("Unknown command 'tset'");
  });

  it('runs the tests, reports each, and exits 2 when one could not run', async () => {
    const runner = fakeRunner();
    const a = io({ startRunner: runner.start });
    expect(await main(['test'], a)).toBe(2);
    expect(a.stdout).toEqual([
      expect.stringMatching(/^ok {3}apis\/echo\/tests\/echo\.yaml > passes \(\d+ ms\)$/),
      expect.stringMatching(/^FAIL apis\/echo\/tests\/echo\.yaml > fails/),
      '       apis/echo/tests/echo.yaml:11 Expected status 201, got 200.',
      expect.stringMatching(/^ERR {2}apis\/echo\/tests\/echo\.yaml > breaks/),
      '       apis/echo/policy.xml:3:9 CS1002: ; expected',
      '',
      "3 tests: 1 passed, 1 failed, 1 couldn't run",
    ]);
    expect(runner.started).toEqual([{ command: 'dotnet', args: ['/b/apim-policy-runner.dll', '--cache', join(tmpdir(), 'apim-policy-runner-cache')], timeoutMs: 60_000 }]);
    expect(runner.closed()).toBe(1);
  });

  it('exits 1 when a test failed and 0 when all passed', async () => {
    expect(await main(['test', '--filter', 'fails'], io({ startRunner: fakeRunner().start }))).toBe(1);
    expect(await main(['test', '--filter', 'passes'], io({ startRunner: fakeRunner().start }))).toBe(0);
  });

  it('writes JUnit, traces and Azure DevOps issues', async () => {
    const out = temp();
    const a = io({ startRunner: fakeRunner().start, env: { TF_BUILD: 'True', AGENT_TEMPDIRECTORY: '/agent/tmp' } });
    await main(['test', 'apis', '--junit', join(out, 'r', 'junit.xml'), '--trace', join(out, 'trace'), '--timeout', '5'], a);
    expect(readFileSync(join(out, 'r', 'junit.xml'), 'utf8')).toContain('<testsuite name="apis/echo/tests/echo.yaml" tests="3" failures="1" errors="1"');
    expect(readdirSync(join(out, 'trace')).sort()).toEqual(['apis-echo-tests-echo.yaml--breaks.json', 'apis-echo-tests-echo.yaml--fails.json', 'apis-echo-tests-echo.yaml--passes.json']);
    expect(JSON.parse(readFileSync(join(out, 'trace', 'apis-echo-tests-echo.yaml--passes.json'), 'utf8'))).toMatchObject({ file: 'apis/echo/tests/echo.yaml', name: 'passes', status: 'passed', steps: [{ policy: 'base' }] });
    expect(a.stdout.filter((l) => l.startsWith('##vso'))).toEqual([
      '##vso[task.logissue type=error;sourcepath=apis/echo/tests/echo.yaml;linenumber=11;]fails: Expected status 201, got 200.',
      '##vso[task.logissue type=error;sourcepath=apis/echo/policy.xml;linenumber=3;columnnumber=9;]breaks: CS1002: ; expected',
    ]);
    const b = io({ startRunner: fakeRunner().start, env: { TF_BUILD: 'True' } });
    await main(['test', '--no-azure-devops', '--filter', 'fails'], b);
    expect(b.stdout.some((l) => l.startsWith('##vso'))).toBe(false);
  });

  it('starts a new runner after one stops, and takes the runner and cache it is given', async () => {
    const runner = fakeRunner(1);
    const a = io({ startRunner: runner.start, env: { APIM_POLICY_RUNNER: '/env/runner' } });
    await main(['test', '--cache', 'c', '--timeout', '2'], a);
    expect(runner.started.map((s) => [s.command, s.args, s.timeoutMs])).toEqual([
      ['/env/runner', ['--cache', join(extract, 'c')], 2000],
      ['/env/runner', ['--cache', join(extract, 'c')], 2000],
      ['/env/runner', ['--cache', join(extract, 'c')], 2000],
    ]);
    const b = fakeRunner();
    await main(['test', '--runner', 'mine.dll'], io({ startRunner: b.start, env: { APIM_POLICY_RUNNER: '/env/runner' } }));
    expect(b.started[0].args[0]).toBe(join(extract, 'mine.dll'));
  });

  it('exits 2 for a missing path, no tests, a filter that matches nothing, and no runner', async () => {
    const cases: [string[], Partial<Io>, string][] = [
      [['test', 'nowhere'], {}, "nowhere isn't there."],
      [['test', 'empty'], {}, 'No tests found under empty'],
      [['test', '--filter', 'zzz'], {}, "No test's name contains 'zzz'."],
      [['test'], { bundledRunner: undefined }, 'No policy runner'],
    ];
    for (const [argv, over, message] of cases) {
      const a = io({ startRunner: fakeRunner().start, ...over });
      expect(await main(argv, a)).toBe(2);
      expect(a.stderr.join('\n')).toContain(message);
    }
  });

  it("says what to install when the runner can't start", async () => {
    const fail = (message: string) => () => Promise.reject(new Error(message));
    const a = io({ startRunner: fail("The policy runner didn't start: spawn dotnet ENOENT") });
    expect(await main(['test'], a)).toBe(2);
    expect(a.stderr.join('\n')).toContain('UseDotNet@2');
    const b = io({ startRunner: fail('no such file'), bundledRunner: '/b/runner' });
    expect(await main(['test'], b)).toBe(2);
    expect(b.stderr).toEqual(['no such file']);
    expect(existsSync(join(extract, 'c'))).toBe(false);
  });
});

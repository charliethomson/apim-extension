import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunInput } from '../src/protocol';
import { ProcessRunner, runnerCommand } from '../src/runner';

const fake = { command: process.execPath, args: [join(__dirname, 'fake-runner.mjs')] };
const input = (url: string): RunInput => ({ scopes: [], fragments: {}, namedValues: {}, variables: {}, request: { url } });
const started: ProcessRunner[] = [];
const start = async (timeoutMs?: number) => {
  const r = await ProcessRunner.start(fake, timeoutMs);
  started.push(r);
  return r;
};

afterEach(async () => {
  await Promise.all(started.splice(0).map((r) => r.close()));
});

describe('the runner process', () => {
  it('answers runs in order', async () => {
    const runner = await start();
    const [a, b] = await Promise.all([runner.run(input('a')), runner.run(input('b'))]);
    expect([a.variables.url.value, b.variables.url.value]).toEqual(['a', 'b']);
    await runner.close();
    expect(runner.stopped).toBe(true);
    await runner.close();
  });

  it("passes on a run it couldn't read, and what isn't JSON", async () => {
    const runner = await start();
    await expect(runner.run(input('bad'))).rejects.toThrow("couldn't read the run: unreadable");
    await expect(runner.run(input('garbage'))).rejects.toThrow("isn't JSON: not json");
    expect((await runner.run(input('ok'))).variables.url.value).toBe('ok');
  });

  it('fails what was waiting when it stops, with what it said', async () => {
    const runner = await start();
    await expect(runner.run(input('crash'))).rejects.toThrow(/stopped \(exit code 3\)\.\nboom/);
    await expect(runner.run(input('after'))).rejects.toThrow('stopped');
  });

  it('stops a run that takes too long', async () => {
    const runner = await start(300);
    await expect(runner.run(input('loop'))).rejects.toThrow('took longer than 0.3s');
    expect(runner.stopped).toBe(true);
  });

  it("says when it can't start", async () => {
    await expect(ProcessRunner.start({ command: join(__dirname, 'no-such-runner'), args: [] })).rejects.toThrow("didn't start");
  });

  it('runs a dll under dotnet and anything else as it is', () => {
    expect(runnerCommand('/r/apim-policy-runner.dll', '/c')).toEqual({ command: 'dotnet', args: ['/r/apim-policy-runner.dll', '--cache', '/c'] });
    expect(runnerCommand('/r/apim-policy-runner')).toEqual({ command: '/r/apim-policy-runner', args: [] });
  });
});

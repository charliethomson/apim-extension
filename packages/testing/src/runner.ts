/**
 * The policy runner as a child process: one per test run, spoken to in JSON lines (Program.cs in
 * runner/). Requests are answered in order, so each reply settles the oldest waiting request.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RunInput, RunResult } from './protocol';

/** Something that runs tests' requests through their policies. */
export interface Runner {
  run(input: RunInput): Promise<RunResult>;
  close(): Promise<void>;
}

/** How to start the runner: a `.dll` runs under `dotnet`, anything else is executed. */
export function runnerCommand(path: string, cacheDir?: string): { command: string; args: string[] } {
  const cache = cacheDir ? ['--cache', cacheDir] : [];
  return path.toLowerCase().endsWith('.dll') ? { command: 'dotnet', args: [path, ...cache] } : { command: path, args: cache };
}

export class ProcessRunner implements Runner {
  private readonly waiting: { id: number; resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }[] = [];
  private nextId = 1;
  private stderr = '';
  private exited?: Error;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-4000)));
    createInterface({ input: child.stdout }).on('line', (line) => this.reply(line));
    child.on('error', (e) => this.stop(new Error(`The policy runner didn't start: ${e.message}`)));
    child.on('exit', (code, signal) => this.stop(new Error(`The policy runner stopped (${signal ?? `exit code ${code}`}).${this.stderr.trim() ? `\n${this.stderr.trim()}` : ''}`)));
  }

  /** Starts the runner and waits until it answers. `timeoutMs` caps each request: an expression that loops forever stops the runner. */
  static async start(command: { command: string; args: string[] }, timeoutMs = 60_000): Promise<ProcessRunner> {
    const runner = new ProcessRunner(spawn(command.command, command.args, { stdio: 'pipe', windowsHide: true }), timeoutMs);
    await runner.send({ hello: true });
    return runner;
  }

  get stopped(): boolean {
    return this.exited !== undefined;
  }

  async run(input: RunInput): Promise<RunResult> {
    const reply = await this.send({ run: input });
    if (typeof reply.error === 'string') throw new Error(`The policy runner couldn't read the run: ${reply.error}`);
    return reply.result as RunResult;
  }

  close(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.stdin.end();
    });
  }

  private send(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: (typeof this.waiting)[number] = { id, resolve, reject };
      entry.timer = setTimeout(() => {
        this.child.kill();
        this.stop(new Error(`The policy runner took longer than ${this.timeoutMs / 1000}s on one test and was stopped. Look for a loop in an expression.`));
      }, this.timeoutMs);
      this.waiting.push(entry);
      this.child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    });
  }

  private reply(line: string): void {
    const entry = this.waiting.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    try {
      entry.resolve(JSON.parse(line) as Record<string, unknown>);
    } catch {
      entry.reject(new Error(`The policy runner sent something that isn't JSON: ${line.slice(0, 200)}`));
    }
  }

  private stop(error: Error): void {
    this.exited ??= error;
    for (const entry of this.waiting.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(this.exited);
    }
  }
}

#!/usr/bin/env node
// The bin. Everything it does is in cli.ts; this only wires it to the process.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { main } from './cli';

declare const __APIM_POLICY_VERSION__: string;

const bundled = join(__dirname, 'runner', 'apim-policy-runner.dll');

main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  version: typeof __APIM_POLICY_VERSION__ === 'string' ? __APIM_POLICY_VERSION__ : 'dev',
  bundledRunner: existsSync(bundled) ? bundled : undefined,
}).then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 2;
  },
);

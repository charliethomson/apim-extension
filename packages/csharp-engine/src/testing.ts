/**
 * The engine and the allowlist built from the shipped assets, read from disk. For tests and the
 * bench in node; the extension reads the same files through VS Code instead.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Allowlist, type AllowlistData } from './allowedTypes';
import type { RawModel } from './model';
import { CSharpEngine } from './service';
import { readStubs } from './stubs';

/** Where `name` (e.g. `csharp-model.json`) is in the package's assets. */
export function assetPath(name: string): string {
  return join(__dirname, '..', 'assets', name);
}

export function readAsset(name: string): string {
  return readFileSync(assetPath(name), 'utf8');
}

export function rawModel(): RawModel {
  return JSON.parse(readAsset('csharp-model.json')) as RawModel;
}

export function stubSource(): string {
  return readAsset('ApimContext.cs');
}

/** A fresh engine over the shipped model and stubs. */
export function loadEngine(): CSharpEngine {
  return CSharpEngine.load(rawModel(), stubSource());
}

/** The allowlist as the extension builds it. */
export function loadAllowlist(): Allowlist {
  const data = JSON.parse(readAsset('allowed-types.json')) as AllowlistData;
  const bcl = JSON.parse(readAsset('bcl-types.json')) as ConstructorParameters<typeof Allowlist>[1];
  return new Allowlist(data, bcl, new Set(readStubs(stubSource(), { types: {} }).map((d) => d.name)));
}

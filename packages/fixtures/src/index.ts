/** Policy files the test suites share: APIOps extracts, raw and escaped policies, fragments. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the fixture files are, for suites that walk them or copy them into a workspace. */
export const fixturesDir = join(__dirname, '..', 'files');

/** A fixture's text, by its path under `files/`. */
export function fixture(path: string): string {
  return readFileSync(join(fixturesDir, path), 'utf8');
}

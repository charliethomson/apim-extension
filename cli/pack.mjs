// Packs the built CLI and runner as an npm tarball at the derived version, without touching
// package.json: a copy with the version set goes to a staging folder, and npm packs that.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const version = process.env.RELEASE_VERSION;
if (!version) throw new Error('RELEASE_VERSION is unset: run this through `npm run package`.');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const stage = mkdtempSync(join(tmpdir(), 'apim-policy-pack-'));
try {
  // What's published: no dev dependencies, scripts or private flag, at the derived version.
  const published = { ...pkg, version };
  for (const key of ['devDependencies', 'scripts', 'private']) delete published[key];
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);
  cpSync('dist', join(stage, 'dist'), { recursive: true });
  cpSync('README.md', join(stage, 'README.md'));
  execFileSync('npm', ['pack', '--pack-destination', process.cwd()], { cwd: stage, stdio: 'inherit' });
} finally {
  rmSync(stage, { recursive: true, force: true });
}

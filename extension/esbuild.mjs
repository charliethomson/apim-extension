import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Test harnesses: runners run in node, suites run inside the VS Code extension host. */
const harness = (entryPoints, outdir, outbase) =>
  esbuild.build({
    entryPoints,
    outdir,
    outbase,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode', '@vscode/test-electron', 'mocha'],
    sourcemap: true,
    logLevel: 'warning',
  });

if (process.argv.includes('--tests')) {
  await harness(['test/integration/runTest.ts', 'test/integration/suite/index.ts', 'test/integration/suite/extension.test.ts'], 'out/test/integration', 'test/integration');
} else {
  copyAssets();
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    // The commit the bundle was built from, logged on startup. `npm run package` passes what
    // scripts/ci/version.sh derived; a dev build asks git.
    define: { __APIM_BUILD__: JSON.stringify(buildInfo()) },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'warning',
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

/**
 * What the extension reads at run time instead of bundling: the type model, which loads on the
 * engine's first use, and the stubs, which go-to-definition opens.
 */
function copyAssets() {
  mkdirSync('dist/assets', { recursive: true });
  for (const name of ['csharp-model.json', 'ApimContext.cs']) copyFileSync(`../packages/csharp-engine/assets/${name}`, `dist/assets/${name}`);
}

function buildInfo() {
  const git = (cmd) => {
    try {
      return execSync(`git ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const commit = process.env.COMMIT || git('rev-parse --short=7 HEAD') || 'unknown';
  const dirty = process.env.DIRTY ? process.env.DIRTY === 'true' : git('status --porcelain --untracked-files=no') !== '';
  return { commit, dirty };
}

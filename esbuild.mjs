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
} else if (process.argv.includes('--spike')) {
  await harness(['test/spike/run.ts', 'test/spike/suite.ts'], 'out/spike', 'test/spike');
} else {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
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

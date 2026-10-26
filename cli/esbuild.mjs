// Bundles the CLI into one file, dist/apim-policy.js, with the version it reports baked in:
// RELEASE_VERSION and COMMIT from scripts/ci/version.sh under `npm run package`, else "dev".
import * as esbuild from 'esbuild';

const version = process.env.RELEASE_VERSION ? `${process.env.RELEASE_VERSION} (${process.env.COMMIT ?? 'unknown'}${process.env.DIRTY === 'true' ? ', dirty' : ''})` : 'dev';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/apim-policy.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  define: { __APIM_POLICY_VERSION__: JSON.stringify(version) },
  minify: true,
  sourcemap: false,
  logLevel: 'warning',
});

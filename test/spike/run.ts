// Spike runner: downloads VS Code, installs the C# extension into an isolated profile,
// and runs suite.ts inside it. Results land in out/spike/results.json.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

async function main() {
  const root = resolve(__dirname, '..', '..');
  // test-electron's CLI helper installs into .vscode-test/extensions and user-data (it ignores
  // custom dirs), so launch with the same ones.
  const extensionsDir = join(root, '.vscode-test', 'extensions');
  const userDataDir = join(root, '.vscode-test', 'user-data');
  mkdirSync(extensionsDir, { recursive: true });
  const workspace = mkdtempSync(join(tmpdir(), 'apim-spike-ws-'));

  const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  const ext = process.env.CSHARP_EXT ?? 'ms-dotnettools.csharp';
  const r = spawnSync(cli, [...cliArgs, '--install-extension', ext], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`installing ${ext} failed`);

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out', 'spike', 'suite.js'),
    launchArgs: [workspace, '--extensions-dir', extensionsDir, '--user-data-dir', userDataDir, '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: {
      APIM_SPIKE_ROOT: root,
      APIM_SPIKE_VARIANTS: process.env.APIM_SPIKE_VARIANTS ?? '',
      ...(process.env.NUGET_PACKAGES ? { NUGET_PACKAGES: process.env.NUGET_PACKAGES } : {}),
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

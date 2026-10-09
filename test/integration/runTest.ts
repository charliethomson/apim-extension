// Runs the integration suite in a downloaded VS Code with the C# extension installed, on a
// temporary copy of test/fixtures (the tests edit documents).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

async function main() {
  const root = resolve(__dirname, '..', '..', '..');
  const workspace = mkdtempSync(join(tmpdir(), 'apim-it-'));
  cpSync(join(root, 'test', 'fixtures'), workspace, { recursive: true });
  // A plain XML file that must stay XML.
  writeFileSync(join(workspace, 'not-a-policy.xml'), '<project><item a="@(x)" /></project>\n');
  mkdirSync(join(workspace, '.vscode'), { recursive: true });

  const vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? 'stable');
  const withCSharp = process.env.APIM_IT_NO_CSHARP !== '1';
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  if (withCSharp) {
    const root = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
    const r = spawnSync(cli, [...cliArgs, ...root, '--install-extension', 'ms-dotnettools.csharp'], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error('installing the C# extension failed');
  }

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(__dirname, 'suite', 'index.js'),
    launchArgs: [
      workspace,
      ...cliArgs.filter((a) => a.startsWith('--extensions-dir') || a.startsWith('--user-data-dir')),
      '--skip-welcome',
      '--skip-release-notes',
      // Containers run as root, where Electron refuses to start without these.
      ...(process.getuid?.() === 0 ? ['--no-sandbox', '--disable-gpu'] : []),
      ...(withCSharp ? [] : ['--disable-extensions']),
    ],
    extensionTestsEnv: { APIM_IT_WITH_CSHARP: withCSharp ? '1' : '0', ...(process.env.APIM_DEBUG ? { APIM_DEBUG: '1' } : {}) },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

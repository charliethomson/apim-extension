// Runs the integration suite in a downloaded VS Code, with every other extension disabled, on a
// temporary copy of test/fixtures (the tests edit documents).
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
  const [, ...resolvedArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  // VS Code listens on a socket inside the user data dir, and macOS caps socket paths at 103
  // bytes, so a deep checkout (a git worktree, say) needs a shorter one.
  const cliArgs = resolvedArgs.map((a) => (a.startsWith('--user-data-dir=') && a.length > 80 ? `--user-data-dir=${mkdtempSync(join(tmpdir(), 'apim-ud-'))}` : a));

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
      '--disable-extensions',
    ],
    extensionTestsEnv: process.env.APIM_DEBUG ? { APIM_DEBUG: '1' } : {},
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

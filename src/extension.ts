import * as vscode from 'vscode';
import { ShadowBackend } from './csharp/backend';
import { parseStubs } from './csharp/stubModel';
import { DocumentCache, LANGUAGE_ID } from './documents';
import { registerCSharpDiagnostics } from './features/csharpDiagnostics';
import { registerStructuralDiagnostics } from './features/diagnostics';
import { registerFragmentNavigation } from './features/fragments';
import { registerPolicyHover } from './features/hover';
import { registerIntellisense } from './features/intellisense';
import { registerLanguageDetection } from './features/languageDetection';
import { PolicyIndex } from './features/policyIndex';
import { registerStatus } from './features/status';
import { log } from './log';
import { catalog } from './policy/catalog';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cache = new DocumentCache();
  const index = new PolicyIndex(cache);
  const stubsUri = vscode.Uri.joinPath(context.extensionUri, 'stubs', 'ApimContext.cs');
  const stubs = parseStubs(new TextDecoder().decode(await vscode.workspace.fs.readFile(stubsUri)));

  const config = vscode.workspace.getConfiguration('apimPolicy.csharp');
  const enabled = config.get<boolean>('enabled', true);
  const mode = config.get<'auto' | 'file' | 'virtual'>('mode', 'auto');

  // The C# backend activates the C# extension, so create it only once a policy needs it.
  let backendPromise: Promise<ShadowBackend | undefined> | undefined;
  const backend = () => {
    if (!enabled) return Promise.resolve(undefined);
    backendPromise ??= ShadowBackend.create(context, catalog, mode).then(
      (b) => {
        if (b) context.subscriptions.push(b);
        log().info(b ? `C# backend: ${b.mode} mode, diagnostics ${b.canPullDiagnostics ? 'available' : 'unavailable'}` : 'C# backend: C# extension not installed');
        return b;
      },
      (e) => {
        log().error(`C# backend failed to start: ${(e as Error).message}`);
        return undefined;
      },
    );
    return backendPromise;
  };

  context.subscriptions.push(
    cache,
    index,
    registerLanguageDetection(),
    registerStructuralDiagnostics(cache, catalog),
    registerPolicyHover(cache, catalog),
    registerFragmentNavigation(cache, index),
    registerIntellisense({ cache, catalog, index, stubs, stubsUri, backend }),
    registerCSharpDiagnostics(cache, () => (vscode.workspace.textDocuments.some((d) => d.languageId === LANGUAGE_ID) ? backend() : Promise.resolve(undefined))),
    registerStatus(backend, enabled),
  );
}

export function deactivate(): void {}

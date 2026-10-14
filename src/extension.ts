import * as vscode from 'vscode';
import { Allowlist, type AllowlistData, type BclIndex } from './csharp/allowedTypes';
import { ShadowBackend } from './csharp/backend';
import { TypeModel, type RawModel } from './csharp/lang/model';
import { CSharpEngine, type UsageFilter } from './csharp/lang/service';
import { readStubs } from './csharp/lang/stubs';
import { DocumentCache, LANGUAGE_ID } from './documents';
import { registerAllowlistLint } from './features/allowlist';
import { registerCSharpDiagnostics } from './features/csharpDiagnostics';
import { registerStructuralDiagnostics } from './features/diagnostics';
import { registerEngineDiagnostics } from './features/engineDiagnostics';
import { registerFragmentNavigation } from './features/fragments';
import { registerPolicyHover } from './features/hover';
import { registerIntellisense } from './features/intellisense';
import { registerLanguageDetection } from './features/languageDetection';
import { PolicyIndex } from './features/policyIndex';
import { registerStatus } from './features/status';
import { log } from './log';
import { catalog } from './policy/catalog';
import allowedTypes from '../data/allowed-types.json';
import bclTypes from '../data/bcl-types.json';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cache = new DocumentCache();
  const index = new PolicyIndex(cache);
  const stubsUri = vscode.Uri.joinPath(context.extensionUri, 'stubs', 'ApimContext.cs');
  const stubSource = new TextDecoder().decode(await vscode.workspace.fs.readFile(stubsUri));

  const allow = new Allowlist(allowedTypes as unknown as AllowlistData, bclTypes as BclIndex, new Set(readStubs(stubSource, { types: {} }).map((d) => d.name)));
  const config = vscode.workspace.getConfiguration('apimPolicy.csharp');
  const enabled = config.get<boolean>('enabled', true);
  const mode = config.get<'auto' | 'file' | 'virtual' | 'builtin'>('mode', 'auto');

  // The built-in engine needs nothing but the type model shipped in data/, so it works without the
  // C# extension and in untrusted workspaces. It loads on first use.
  let enginePromise: Promise<CSharpEngine | undefined> | undefined;
  const engine = () => {
    if (!enabled) return Promise.resolve(undefined);
    enginePromise ??= (async () => {
      const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'data', 'csharp-model.json')))) as RawModel;
      const filter: UsageFilter = {
        type: (def) => def.origin === 'stub' || allow.isTypeAllowed(def.key.replace(/`\d+/g, '').replace(/\+/g, '.')),
        member: (def, m) => def.origin === 'stub' || !allow.memberProblem(def.key.replace(/`\d+/g, '').replace(/\+/g, '.'), m.kind === 'ctor' ? '(Constructor)' : m.name),
      };
      return new CSharpEngine(new TypeModel(raw, readStubs(stubSource, raw)), filter);
    })().catch((e) => {
      log().error(`built-in C# engine failed to load: ${(e as Error).message}`);
      return undefined;
    });
    return enginePromise;
  };

  // The C# backend activates the C# extension, so create it only once a policy needs it. It
  // writes a .NET project to global storage and the C# server restores it from NuGet, so it stays
  // off in untrusted workspaces until trust is granted.
  let backendPromise: Promise<ShadowBackend | undefined> | undefined;
  const backend = () => {
    if (!enabled || mode === 'builtin' || !vscode.workspace.isTrusted) return Promise.resolve(undefined);
    backendPromise ??= ShadowBackend.create(context, catalog, mode, (d) => cache.get(d)).then(
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
    registerIntellisense({ cache, catalog, index, stubsUri, backend, engine }),
    registerCSharpDiagnostics(cache, vscode.workspace.onDidGrantWorkspaceTrust, () => (vscode.workspace.textDocuments.some((d) => d.languageId === LANGUAGE_ID) ? backend() : Promise.resolve(undefined))),
    registerEngineDiagnostics(cache, engine, async () => !!(await backend())?.canPullDiagnostics, vscode.workspace.onDidGrantWorkspaceTrust),
    registerStatus(backend, enabled, mode),

    registerAllowlistLint(cache, allow, vscode.workspace.onDidGrantWorkspaceTrust, () => (vscode.workspace.textDocuments.some((d) => d.languageId === LANGUAGE_ID) ? backend() : Promise.resolve(undefined)), engine),
  );
}

export function deactivate(): void {}

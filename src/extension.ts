import * as vscode from 'vscode';
import { Allowlist, type AllowlistData } from './csharp/allowedTypes';
import { TypeModel, type RawModel } from './csharp/lang/model';
import { CSharpEngine, type UsageFilter } from './csharp/lang/service';
import { readStubs } from './csharp/lang/stubs';
import { DocumentCache, LANGUAGE_ID } from './documents';
import { registerAllowlistLint } from './features/allowlist';
import { registerCompatibility } from './features/compatibility';
import { registerStructuralDiagnostics } from './features/diagnostics';
import { registerEngineDiagnostics } from './features/engineDiagnostics';
import { docCommands } from './features/docs';
import { registerFormatting } from './features/formatting';
import { registerFragmentDocs } from './features/fragmentDocs';
import { registerFragmentNavigation } from './features/fragments';
import { registerPolicyHover } from './features/hover';
import { InstanceConnection, registerUnknownNamedValues } from './features/instance';
import { registerInstanceTree } from './features/instanceTree';
import { registerInstanceFileSystem } from './features/instanceFs';
import { pushCommand, PushSupport } from './features/push';
import { registerIntellisense } from './features/intellisense';
import { registerLanguageDetection } from './features/languageDetection';
import { PolicyIndex } from './features/policyIndex';
import { ShapeService } from './features/shapes';
import { log } from './log';
import { catalog } from './policy/catalog';
import allowedTypes from '../data/allowed-types.json';
import bclTypes from '../data/bcl-types.json';

/**
 * The extension activates for every XML file (`onLanguage:xml`), so that language detection can
 * switch policies over. Everything else (reading the stubs, the workspace watcher, the providers)
 * waits for the first apim-policy document, so a .csproj or web.config costs nothing more.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(registerLanguageDetection());
  let started: Promise<Started> | undefined;
  const startOnce = () => {
    if (!started) {
      opened.dispose();
      started = start(context).then((s) => {
        // A pushed editable copy refreshes its read-only twin.
        s.support.onPushed = (uri) => files.pushed(uri);
        return s;
      });
      started.catch((e) => log().error(`activation failed: ${(e as Error).message}`));
    }
    return started;
  };
  const consider = (d: vscode.TextDocument) => {
    if (d.languageId === LANGUAGE_ID) void startOnce();
  };
  const opened = vscode.workspace.onDidOpenTextDocument(consider);
  context.subscriptions.push(opened);
  // The instance commands work before any policy is open: running one starts the rest.
  for (const id of ['apimPolicy.selectInstance', 'apimPolicy.refreshInstance', 'apimPolicy.signIn', 'apimPolicy.openInstancePolicy', 'apimPolicy.setPolicyScope', 'apimPolicy.pushPolicy', 'apimPolicy.generateDocs', 'apimPolicy.writeDocs']) {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => (await startOnce()).connection.commands[id]?.(...args)));
  }
  // So are the explorer and the instance's documents (which a restored editor may ask for first);
  // using either starts the rest.
  const files = registerInstanceFileSystem(startOnce);
  context.subscriptions.push(
    registerInstanceTree(() => startOnce().then((s) => s.connection)),
    files.disposable,
    vscode.commands.registerCommand('apimPolicy.openEditable', files.openEditable),
    vscode.commands.registerCommand('apimPolicy.reloadFromInstance', files.reload),
    vscode.commands.registerCommand('apimPolicy.confirmPush', async (arg?: unknown) => (await startOnce()).support.confirm(arg)),
    vscode.commands.registerCommand('apimPolicy.cancelPush', async (arg?: unknown) => (await startOnce()).support.cancel(arg)),
  );
  vscode.workspace.textDocuments.forEach(consider);
}

/** Injected by esbuild.mjs. */
declare const __APIM_BUILD__: { commit: string; dirty: boolean };

interface Started {
  connection: InstanceConnection;
  support: PushSupport;
}

async function start(context: vscode.ExtensionContext): Promise<Started> {
  const version = (context.extension.packageJSON as { version: string }).version;
  log().info(`apim-policy ${version} (${__APIM_BUILD__.commit}${__APIM_BUILD__.dirty ? ', dirty' : ''})`);
  const cache = new DocumentCache();
  const index = new PolicyIndex(cache);
  const connection = new InstanceConnection(context, (dir) => index.isExtractRoot(dir));
  index.attach(connection);
  const pushSupport = new PushSupport(connection);
  connection.commands['apimPolicy.pushPolicy'] = pushCommand(cache, connection, pushSupport);
  const stubsUri = vscode.Uri.joinPath(context.extensionUri, 'stubs', 'ApimContext.cs');
  const stubSource = new TextDecoder().decode(await vscode.workspace.fs.readFile(stubsUri));

  const allow = new Allowlist(allowedTypes as unknown as AllowlistData, bclTypes, new Set(readStubs(stubSource, { types: {} }).map((d) => d.name)));
  const enabled = vscode.workspace.getConfiguration('apimPolicy.csharp').get<boolean>('enabled', true);

  // The C# engine needs nothing but the type model shipped in data/, so it works offline and in
  // untrusted workspaces. It loads on first use.
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

  const shapes = new ShapeService(index, engine, (doc) => cache.uriOf(doc));
  Object.assign(connection.commands, docCommands(cache, index, shapes, connection));
  context.subscriptions.push(
    cache,
    index,
    connection,
    pushSupport,
    registerUnknownNamedValues(cache, connection),
    registerStructuralDiagnostics(cache, catalog),
    registerFormatting(cache),
    registerPolicyHover(cache, catalog, index),
    registerFragmentNavigation(cache, index),
    registerFragmentDocs(cache, index, shapes),
    registerIntellisense({ cache, catalog, index, stubsUri, engine, shapes }),
    registerEngineDiagnostics(cache, catalog, engine, shapes),
    registerCompatibility(cache, engine),
    registerAllowlistLint(cache, allow, engine),
  );
  return { connection, support: pushSupport };
}

export function deactivate(): void {}

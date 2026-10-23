import * as vscode from 'vscode';
import { ApimInstance, ArmClient, type Backend, describeError, isAllowedInstance, type NamedValue, parseServiceId } from '@apim-policy/azure';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import { log } from '../log';
import type { Document } from '@apim-policy/document';
import type { IncludeSets, OuterSet } from '@apim-policy/analysis';
import { instancePath, scopeLabel, type Scope } from '@apim-policy/core';
import { documentScope, INSTANCE_SCHEME, InstanceReader, type InstanceSource, type RemoteFragment, unknownNamedValues } from '@apim-policy/workspace';

const SCOPES_KEY = 'apimPolicy.scopes';

/** Thrown by the token provider when there's no Microsoft session and asking would prompt. */
class NotSignedIn extends Error {}

/**
 * The connection to one APIM instance (`apimPolicy.instance`), for what the workspace can't tell
 * the extension: fragments and named values that only exist on the instance, and the broader
 * scopes' policies around the one being edited. Opt-in, read-only, and in memory only.
 *
 * Every read fails soft: a feature asking for instance data gets nothing back while signed out or
 * offline, and the status item says why.
 */
export class InstanceConnection implements vscode.Disposable, InstanceSource<vscode.Uri> {
  private instance?: ApimInstance;
  /** What's read from `instance`, parsed and cached. */
  private reader?: InstanceReader<vscode.Uri>;
  private client?: ArmClient;
  /** Bumped whenever what the instance says may have changed, to invalidate derived caches. */
  private generation = 0;
  private state: { kind: 'none' } | { kind: 'signedOut' } | { kind: 'ok'; at: Date } | { kind: 'error'; message: string } = { kind: 'none' };
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly stateChanged = new vscode.EventEmitter<void>();
  /** Fires when the connection goes between none, signed out, ok and error. */
  readonly onDidChangeState = this.stateChanged.event;
  private readonly status = vscode.languages.createLanguageStatusItem('apimPolicy.instance', LANGUAGE_ID);
  private readonly scopeStatus = vscode.languages.createLanguageStatusItem('apimPolicy.scope', LANGUAGE_ID);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** Whether a folder is an APIOps extract's root, so its policy.xml is the global policy. */
    private readonly isExtractRoot: (dir: string) => boolean,
  ) {
    this.status.name = 'APIM instance';
    this.scopeStatus.name = 'APIM policy scope';
    this.disposables.push(
      this.status,
      this.scopeStatus,
      this.changed,
      this.stateChanged,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('apimPolicy.instance') || e.affectsConfiguration('apimPolicy.armEndpoint') || e.affectsConfiguration('apimPolicy.tenant') || e.affectsConfiguration('apimPolicy.instanceCacheMinutes')) this.configure();
        else if (e.affectsConfiguration('apimPolicy.publish')) this.updatePushContext();
      }),
      vscode.authentication.onDidChangeSessions((e) => {
        if (e.provider.id === this.authProvider()) this.refresh();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateScopeStatus()),
    );
    this.configure();
  }

  // ---- what the features ask for -----------------------------------------------------------------

  get connected(): boolean {
    return !!this.instance;
  }

  /** The instance, for the explorer; read through `read` so failures show in the status. */
  get current(): ApimInstance | undefined {
    return this.instance;
  }

  get stateKind(): 'none' | 'signedOut' | 'ok' | 'error' {
    return this.state.kind;
  }

  /** Whether the user has allowed pushing to the connected instance (`apimPolicy.publish.allowedInstances`). */
  get pushAllowed(): boolean {
    const id = this.instance?.id;
    return !!id && isAllowedInstance(vscode.workspace.getConfiguration('apimPolicy').get<string[]>('publish.allowedInstances', []), id);
  }

  /** Adds the connected instance to the workspace's allowed list. */
  async allowPush(): Promise<void> {
    const id = this.instance?.id;
    if (!id) return;
    const config = vscode.workspace.getConfiguration('apimPolicy');
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('publish.allowedInstances', [...config.get<string[]>('publish.allowedInstances', []), id], target);
    this.updatePushContext();
  }

  private updatePushContext(): void {
    void vscode.commands.executeCommand('setContext', 'apimPolicy.canPush', this.pushAllowed);
  }

  /** After a push: drop what was read, so every feature sees the new policy. */
  pushed(): void {
    this.refresh();
  }

  /** An instance read that fails soft: `fallback` on error, with the status item saying why. */
  read<T>(p: Promise<T>, fallback: T): Promise<T> {
    return this.guard(p, fallback);
  }

  fragments(): Promise<RemoteFragment<vscode.Uri>[]> {
    return this.reader ? this.reader.fragments() : Promise.resolve([]);
  }

  async namedValues(): Promise<NamedValue[]> {
    return this.reader ? this.reader.namedValues() : [];
  }

  async backends(): Promise<Backend[]> {
    return this.reader ? this.reader.backends() : [];
  }

  /** The scope a document's policy applies at: set by hand, or from its path. */
  scopeOf(uri: vscode.Uri): Scope | undefined {
    const manual = this.context.workspaceState.get<Record<string, Scope>>(SCOPES_KEY, {})[vscode.workspace.asRelativePath(uri)];
    return documentScope(uri.scheme, uri.path, manual, this.isExtractRoot);
  }

  /** What the broader scopes set before each point of `doc`, the policy at `uri`. */
  outerVariables(uri: vscode.Uri, doc: Document, includeSets: IncludeSets): Promise<OuterSet[]> {
    const scope = this.scopeOf(uri);
    return this.reader && scope ? this.reader.outerVariables(uri.toString(), scope, doc, includeSets) : Promise.resolve([]);
  }

  /** The read-only document for a scope's policy on the instance. */
  policyUri(scope: Scope): vscode.Uri {
    const name = this.instance?.name ?? 'instance';
    return vscode.Uri.from({ scheme: INSTANCE_SCHEME, authority: name, path: instancePath(scope, name) });
  }

  // ---- connection ---------------------------------------------------------------------------------

  private configure(): void {
    const config = vscode.workspace.getConfiguration('apimPolicy');
    const raw = config.get<string>('instance', '').trim();
    const service = raw ? parseServiceId(raw) : undefined;
    this.instance = undefined;
    this.reader = undefined;
    this.client = undefined;
    if (raw && !service) {
      this.setState({ kind: 'error', message: `apimPolicy.instance isn't an API Management resource ID: ${raw}` });
    } else if (service) {
      this.client = new ArmClient({
        endpoint: this.endpoint(),
        tenant: config.get<string>('tenant', '').trim() || undefined,
        token: (tenant) => this.token(tenant, false),
        fetch: globalThis.fetch,
      });
      this.instance = new ApimInstance(this.client, service.id, Math.max(1, config.get<number>('instanceCacheMinutes', 10)) * 60_000);
      this.reader = new InstanceReader(this.instance, (p, fallback) => this.guard(p, fallback), (scope) => this.policyUri(scope));
      this.setState({ kind: 'ok', at: new Date() });
      // Check the connection now, so the status item is right before anything asks.
      void this.guard(this.instance.namedValues(), []);
    } else {
      this.setState({ kind: 'none' });
    }
    this.updatePushContext();
    this.invalidate();
  }

  /** The commands, which extension.ts registers at activation. */
  readonly commands: Record<string, (...args: unknown[]) => unknown> = {
    'apimPolicy.selectInstance': () => this.selectInstance(),
    'apimPolicy.refreshInstance': () => this.refresh(),
    'apimPolicy.signIn': () => this.signIn(),
    'apimPolicy.openInstancePolicy': () => this.openInstancePolicy(),
    'apimPolicy.setPolicyScope': (uri?: unknown) => this.setPolicyScope(uri instanceof vscode.Uri ? uri : undefined),
  };

  private refresh(): void {
    this.instance?.refresh();
    if (this.instance) void this.guard(this.instance.namedValues(), []);
    this.invalidate();
  }

  private invalidate(): void {
    this.generation++;
    this.reader?.invalidate();
    this.changed.fire();
  }

  private endpoint(): string {
    return vscode.workspace.getConfiguration('apimPolicy').get<string>('armEndpoint', 'https://management.azure.com').replace(/\/+$/, '');
  }

  /** Sovereign clouds sign in through VS Code's sovereign-cloud provider. */
  private authProvider(): string {
    return /^https:\/\/management\.azure\.com$/i.test(this.endpoint()) ? 'microsoft' : 'microsoft-sovereign-cloud';
  }

  private async token(tenant: string | undefined, prompt: boolean): Promise<string> {
    const scopes = [`${this.endpoint()}/.default`];
    if (tenant) scopes.push(`VSCODE_TENANT:${tenant}`);
    const session = prompt
      ? await vscode.authentication.getSession(this.authProvider(), scopes, { createIfNone: true })
      : await vscode.authentication.getSession(this.authProvider(), scopes, { silent: true });
    if (!session) throw new NotSignedIn('Not signed in to Azure.');
    return session.accessToken;
  }

  private async signIn(): Promise<void> {
    try {
      await this.token(this.client?.currentTenant ?? (vscode.workspace.getConfiguration('apimPolicy').get<string>('tenant', '').trim() || undefined), true);
      this.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(`Azure sign-in failed: ${(e as Error).message}`);
    }
  }

  /** Runs an instance read for a feature: on failure, logs, updates the status item and returns `fallback`. */
  private async guard<T>(p: Promise<T>, fallback: T): Promise<T> {
    const generation = this.generation;
    try {
      const v = await p;
      if (generation === this.generation && this.state.kind !== 'ok') this.setState({ kind: 'ok', at: new Date() });
      return v;
    } catch (e) {
      if (generation === this.generation) {
        if (e instanceof NotSignedIn) this.setState({ kind: 'signedOut' });
        else {
          const message = describeError(e);
          if (this.state.kind !== 'error' || this.state.message !== message) log().warn(`APIM instance: ${message}`);
          this.setState({ kind: 'error', message });
        }
      }
      return fallback;
    }
  }

  private setState(state: InstanceConnection['state']): void {
    const changed = this.state.kind !== state.kind;
    this.state = state;
    void vscode.commands.executeCommand('setContext', 'apimPolicy.instanceState', state.kind);
    if (changed) this.stateChanged.fire();
    const name = this.instance?.name;
    const s = this.status;
    s.severity = vscode.LanguageStatusSeverity.Information;
    s.busy = false;
    switch (state.kind) {
      case 'none':
        s.text = 'No APIM instance';
        s.detail = 'Connect one for its fragments, named values and outer-scope variables';
        s.command = { title: 'Connect', command: 'apimPolicy.selectInstance' };
        break;
      case 'signedOut':
        s.text = `$(azure) ${name}`;
        s.detail = 'Signed out of Azure';
        s.severity = vscode.LanguageStatusSeverity.Warning;
        s.command = { title: 'Sign in', command: 'apimPolicy.signIn' };
        break;
      case 'ok':
        s.text = `$(azure) ${name}`;
        s.detail = `APIM instance, read at ${state.at.toLocaleTimeString()}`;
        s.command = { title: 'Refresh', command: 'apimPolicy.refreshInstance' };
        break;
      case 'error':
        s.text = name ? `$(azure) ${name}` : 'APIM instance';
        s.detail = state.message;
        s.severity = vscode.LanguageStatusSeverity.Error;
        s.command = { title: name ? 'Retry' : 'Choose', command: name ? 'apimPolicy.refreshInstance' : 'apimPolicy.selectInstance' };
        break;
    }
    this.updateScopeStatus();
  }

  private updateScopeStatus(): void {
    const editor = vscode.window.activeTextEditor;
    const scope = editor && this.scopeOf(editor.document.uri);
    this.scopeStatus.text = scope ? `Scope: ${scopeLabel(scope)}` : 'Scope: unknown';
    this.scopeStatus.detail = scope ? undefined : 'Set it to see what broader scopes set';
    this.scopeStatus.command = { title: 'Set scope', command: 'apimPolicy.setPolicyScope' };
  }

  // ---- commands ---------------------------------------------------------------------------------------

  /** A client whose tokens are for `tenant`; `prompt` lets it ask the user to sign in. */
  private clientFor(tenant: string | undefined, prompt: boolean): ArmClient {
    return new ArmClient({ endpoint: this.endpoint(), tenant, token: (t) => this.token(t, prompt), fetch: globalThis.fetch });
  }

  /**
   * Lists the subscriptions in every directory the account can see, then the APIM services in the
   * chosen one. A plain sign-in only covers the account's home directory, and subscriptions are
   * often elsewhere (a guest account, a separate production tenant).
   */
  private async selectInstance(): Promise<void> {
    const config = vscode.workspace.getConfiguration('apimPolicy');
    const fixed = config.get<string>('tenant', '').trim() || undefined;
    type Sub = { subscriptionId: string; displayName: string };
    type Tenant = { tenantId: string; displayName?: string; defaultDomain?: string };
    type Item = vscode.QuickPickItem & { tenant: Tenant; sub?: Sub };
    const tenantName = (t: Tenant) => t.displayName || t.defaultDomain || t.tenantId;
    const listSubs = (client: ArmClient) => client.list<Sub>('/subscriptions', { 'api-version': '2022-12-01' });
    try {
      const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Finding your Azure subscriptions…' }, async () => {
        const tenants: Tenant[] = fixed ? [{ tenantId: fixed }] : await this.clientFor(undefined, true).list<Tenant>('/tenants', { 'api-version': '2022-12-01' });
        return Promise.all(
          tenants.map(async (tenant) => {
            try {
              return { tenant, subs: await listSubs(this.clientFor(tenant.tenantId, false)) };
            } catch (e) {
              log().info(`APIM instance: couldn't list subscriptions in ${tenantName(tenant)} without signing in again: ${describeError(e)}`);
              return { tenant, subs: undefined };
            }
          }),
        );
      });
      const items: Item[] = [];
      for (const { tenant, subs } of found) {
        if (subs) items.push(...subs.map((sub) => ({ label: sub.displayName, description: sub.subscriptionId, detail: found.length > 1 ? tenantName(tenant) : undefined, tenant, sub })));
        else items.push({ label: `$(sign-in) Sign in to ${tenantName(tenant)}…`, description: tenant.tenantId, tenant });
      }
      if (!items.length) {
        void vscode.window.showWarningMessage(`No Azure subscriptions found in ${found.length === 1 ? 'the directory' : `any of the ${found.length} directories`} this account can see.`);
        return;
      }
      let picked = await vscode.window.showQuickPick(items, { title: 'Subscription', matchOnDescription: true, matchOnDetail: true });
      if (!picked) return;
      const tenant = picked.tenant;
      const client = this.clientFor(tenant.tenantId, true);
      if (!picked.sub) {
        // A directory that needs an interactive sign-in (MFA, consent): sign in, then pick there.
        const subs = await listSubs(client);
        if (!subs.length) {
          void vscode.window.showWarningMessage(`No subscriptions in ${tenantName(tenant)}.`);
          return;
        }
        picked = await vscode.window.showQuickPick(subs.map((sub) => ({ label: sub.displayName, description: sub.subscriptionId, tenant, sub })), { title: `Subscription in ${tenantName(tenant)}` });
        if (!picked?.sub) return;
      }
      const sub = picked.sub;
      const services = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Listing API Management services…' }, () =>
        client.list<{ id: string; name: string; location: string; sku?: { name: string } }>(`/subscriptions/${sub.subscriptionId}/providers/Microsoft.ApiManagement/service`),
      );
      if (!services.length) {
        void vscode.window.showWarningMessage(`No API Management services in ${sub.displayName}.`);
        return;
      }
      const svc = await vscode.window.showQuickPick(services.map((s) => ({ label: s.name, description: [s.location, s.sku?.name].filter(Boolean).join(' · '), id: s.id })), { title: 'API Management service' });
      if (!svc) return;
      const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config.update('tenant', client.currentTenant ?? tenant.tenantId, target);
      await config.update('instance', svc.id, target);
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't list API Management services: ${describeError(e)}`);
    }
  }

  /** Picks a scope on the instance, or undefined when cancelled. */
  async pickScope(title: string, extra: (vscode.QuickPickItem & { scope?: Scope | null })[] = []): Promise<Scope | null | undefined> {
    const i = this.instance;
    type Item = vscode.QuickPickItem & { scope?: Scope | null; next?: 'products' | 'apis' | 'fragments' };
    const top: Item[] = [...extra, { label: 'Global', scope: { kind: 'global' } }, { label: 'Product…', next: 'products' }, { label: 'API or operation…', next: 'apis' }];
    if (title.startsWith('Open')) top.push({ label: 'Fragment…', next: 'fragments' });
    const first = await vscode.window.showQuickPick<Item>(top, { title });
    if (!first) return undefined;
    if (first.scope !== undefined) return first.scope;
    if (!i) {
      void vscode.window.showWarningMessage('Connect an APIM instance first (APIM: Connect to an Instance).');
      return undefined;
    }
    try {
      if (first.next === 'products') {
        const p = await vscode.window.showQuickPick((await i.products()).map((x) => ({ label: x.displayName, description: x.id, id: x.id })), { title: 'Product' });
        return p && { kind: 'product', product: p.id };
      }
      if (first.next === 'fragments') {
        const f = await vscode.window.showQuickPick((await i.fragments()).map((x) => ({ label: x.id, description: x.description })), { title: 'Fragment' });
        return f && { kind: 'fragment', fragment: f.label };
      }
      const api = await vscode.window.showQuickPick((await i.apis()).map((x) => ({ label: x.displayName, description: `/${x.path}`, id: x.id })), { title: 'API' });
      if (!api) return undefined;
      const ops = await i.operations(api.id);
      const op = await vscode.window.showQuickPick(
        [{ label: 'The whole API', id: undefined as string | undefined }, ...ops.map((o) => ({ label: o.displayName, description: `${o.method} ${o.urlTemplate}`, id: o.id }))],
        { title: `${api.label}: API or operation` },
      );
      if (!op) return undefined;
      return op.id ? { kind: 'operation', api: api.id, operation: op.id } : { kind: 'api', api: api.id };
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't read from ${i.name}: ${describeError(e)}`);
      return undefined;
    }
  }

  private async openInstancePolicy(): Promise<void> {
    const scope = await this.pickScope('Open a policy from the instance');
    if (!scope) return;
    const doc = await vscode.workspace.openTextDocument(this.policyUri(scope));
    await vscode.languages.setTextDocumentLanguage(doc, LANGUAGE_ID);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private async setPolicyScope(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file') return;
    const scope = await this.pickScope(`Scope of ${vscode.workspace.asRelativePath(target)}`, [{ label: 'From the file’s path', description: 'APIOps layout', scope: null }]);
    if (scope === undefined) return;
    await this.setScope(target, scope);
  }

  /** Records which scope `uri`'s policy is; null goes back to reading it from the path. */
  async setScope(uri: vscode.Uri, scope: Scope | null): Promise<void> {
    const all = { ...this.context.workspaceState.get<Record<string, Scope>>(SCOPES_KEY, {}) };
    const key = vscode.workspace.asRelativePath(uri);
    if (scope) all[key] = scope;
    else delete all[key];
    await this.context.workspaceState.update(SCOPES_KEY, all);
    this.updateScopeStatus();
    this.invalidate();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** Named values a document uses that the instance doesn't have, as information diagnostics. */
export function registerUnknownNamedValues(cache: DocumentCache, connection: InstanceConnection): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('apim-instance');
  const timers = new Map<string, NodeJS.Timeout>();
  const refresh = async (document: vscode.TextDocument) => {
    if (document.languageId !== LANGUAGE_ID || document.isClosed || !connection.connected) {
      collection.delete(document.uri);
      return;
    }
    const version = document.version;
    const known = await connection.namedValues();
    if (document.isClosed || document.version !== version) return;
    const unknown = unknownNamedValues(cache.get(document), known);
    // Nothing read (signed out, offline): say nothing rather than flag every name.
    if (!unknown) {
      collection.delete(document.uri);
      return;
    }
    collection.set(
      document.uri,
      unknown.map((nv) => {
        const d = new vscode.Diagnostic(toRange(document, nv.range), `No named value '${nv.name}' on the connected instance.`, vscode.DiagnosticSeverity.Information);
        d.source = 'apim';
        d.code = 'unknown-named-value';
        return d;
      }),
    );
  };
  const schedule = (document: vscode.TextDocument, delay = 500) => {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      void refresh(document);
    }, delay));
  };
  const all = () => vscode.workspace.textDocuments.forEach((d) => schedule(d, 0));
  all();
  return vscode.Disposable.from(
    collection,
    connection.onDidChange(all),
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 0)),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
    { dispose: () => timers.forEach(clearTimeout) },
  );
}

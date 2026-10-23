import * as vscode from 'vscode';
import { ArmError } from '../apim/arm';
import type { ApimInstance } from '../apim/instance';
import { gatewayErrors, pushFormat, samePolicy } from '../apim/push';
import { LANGUAGE_ID, type DocumentCache } from '../documents';
import { fragmentIdsFor } from '../parser/fragmentIds';
import { parse } from '../parser/scanner';
import { scopeFromInstancePath, scopeLabel, type Scope } from '../scope';
import { summarize } from '../policy/variables';
import type { InstanceConnection } from './instance';

/** Read-only snapshots of what's live, for the left side of the review diff. */
const SNAPSHOT_SCHEME = 'apim-live';

/** A push waiting on the user: the diff is open, and nothing has been written yet. */
interface Review {
  document: vscode.TextDocument;
  scope: Scope;
  instance: ApimInstance;
  /** From the fresh pull the diff shows; the write fails if the instance changes after it. */
  etag?: string;
  description?: string;
  exists: boolean;
  where: string;
  left: vscode.Uri;
}

/**
 * Pushing to the instance, in two explicit steps. **Push to Instance** pulls what's live now and
 * opens it in a diff against your version; nothing is written. The diff's **Push These Changes**
 * button then writes your version, with the ETag from that pull, so a change made on the instance
 * while you were looking makes the push fail instead of being overwritten. Pushing is opt-in per
 * instance (`apimPolicy.publish.allowedInstances`).
 */
export class PushSupport implements vscode.Disposable {
  private readonly errors = vscode.languages.createDiagnosticCollection('apim-push');
  private readonly snapshots = new Map<string, string>();
  private readonly reviews = new Map<string, Review>();
  private counter = 0;
  private readonly disposables: vscode.Disposable[];
  /** Called after a successful push, with the pushed document's URI. */
  onPushed: (uri: vscode.Uri) => void = () => undefined;

  constructor(private readonly connection: InstanceConnection) {
    this.disposables = [
      this.errors,
      vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, { provideTextDocumentContent: (uri) => this.snapshots.get(uri.path) ?? '' }),
      // The gateway's errors describe the text that was pushed; an edit makes them stale.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.errors.delete(e.document.uri);
      }),
      // Closing the diff abandons the push.
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of e.closed) {
          const input = tab.input;
          if (input instanceof vscode.TabInputTextDiff && input.original.scheme === SNAPSHOT_SCHEME) this.forget(input.modified);
        }
      }),
    ];
  }

  /** True once pushing to the connected instance is allowed, asking the user (once) if it isn't yet. */
  async ensureAllowed(): Promise<boolean> {
    const name = this.connection.current?.name;
    if (!name) {
      const go = await vscode.window.showInformationMessage('Connect an APIM instance first.', 'Connect');
      if (go) await vscode.commands.executeCommand('apimPolicy.selectInstance');
      return false;
    }
    if (this.connection.pushAllowed) return true;
    const allow = `Allow changes to ${name}`;
    const answer = await vscode.window.showWarningMessage(
      `Changing policies on ${name} is off.`,
      { modal: true, detail: 'Pushing replaces policies on the instance. Allow it only for an instance you change by hand, not one deployed by a pipeline. This is saved in the workspace settings (apimPolicy.publish.allowedInstances).' },
      allow,
    );
    if (answer !== allow) return false;
    await this.connection.allowPush();
    return true;
  }

  /** Step one: pull what's live and open the diff. Writes nothing. */
  async review(document: vscode.TextDocument, scope: Scope): Promise<void> {
    const instance = this.connection.current;
    if (!instance) return;
    const where = `${scopeLabel(scope)} on ${instance.name}`;
    const format = pushFormat(parse(document.getText()));
    let live: { xml?: string; etag?: string; description?: string };
    try {
      live = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Pulling ${where}` }, () =>
        scope.kind === 'fragment' ? instance.liveFragment(scope.fragment, format) : instance.livePolicy(scope, format),
      );
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't read ${where}: ${(e as Error).message}`);
      return;
    }
    if (samePolicy(live.xml, document.getText())) {
      this.forget(document.uri);
      void vscode.window.showInformationMessage(`${where} already matches.`);
      return;
    }
    const key = `/${++this.counter}/${scope.kind}.xml`;
    this.snapshots.set(key, live.xml ?? '');
    while (this.snapshots.size > 20) this.snapshots.delete(this.snapshots.keys().next().value!);
    const left = vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: key });
    this.reviews.set(document.uri.toString(), { document, scope, instance, etag: live.etag, description: live.description, exists: live.xml !== undefined, where, left });
    this.updateContext();
    const label = document.uri.scheme === 'file' ? vscode.workspace.asRelativePath(document.uri) : 'your edits';
    await vscode.commands.executeCommand('vscode.diff', left, document.uri, `${live.xml === undefined ? 'New: ' : ''}${where} ↔ ${label}`, { preview: false });
  }

  /** Step two, from the diff's button: write the reviewed document. */
  async confirm(arg?: unknown): Promise<void> {
    const r = this.reviewFor(arg);
    if (!r) {
      void vscode.window.showInformationMessage('Nothing is waiting to be pushed here. Use Push to Instance to review a change first.');
      return;
    }
    if (r.instance !== this.connection.current) {
      this.forget(r.document.uri);
      void vscode.window.showErrorMessage(`The connected instance changed since this diff was opened, so nothing was pushed.`);
      return;
    }
    const { document, scope, instance, where } = r;
    const text = document.getText();
    const format = pushFormat(parse(document.getText()));
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pushing to ${where}…` }, () =>
        scope.kind === 'fragment' ? instance.pushFragment(scope.fragment, text, format, r.description, r.etag) : instance.pushPolicy(scope, text, format, r.etag),
      );
    } catch (e) {
      if (e instanceof ArmError && e.status === 412) {
        void vscode.window.showWarningMessage(`${where} changed while you were reviewing, so nothing was pushed. The diff now shows the new version.`);
        await this.closeDiff(document.uri);
        await this.review(document, scope);
        return;
      }
      // Stay in the diff: the right side is editable, so a rejected policy can be fixed there.
      void vscode.window.showErrorMessage(this.explain(document, e, where));
      return;
    }
    await this.closeDiff(document.uri);
    this.errors.delete(document.uri);
    this.connection.pushed();
    this.onPushed(document.uri);
    vscode.window.setStatusBarMessage(`$(cloud-upload) Pushed to ${where}`, 5000);
  }

  /** The diff's other button: abandon the push. */
  async cancel(arg?: unknown): Promise<void> {
    const r = this.reviewFor(arg);
    if (r) await this.closeDiff(r.document.uri);
  }

  /** The review a button or command means: its URI, or the active editor (either side of the diff). */
  private reviewFor(arg?: unknown): Review | undefined {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri) return undefined;
    return this.reviews.get(uri.toString()) ?? [...this.reviews.values()].find((r) => r.left.toString() === uri.toString());
  }

  private async closeDiff(uri: vscode.Uri): Promise<void> {
    this.forget(uri);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === SNAPSHOT_SCHEME && t.input.modified.toString() === uri.toString());
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
  }

  private forget(uri: vscode.Uri): void {
    if (this.reviews.delete(uri.toString())) this.updateContext();
  }

  private updateContext(): void {
    void vscode.commands.executeCommand('setContext', 'apimPolicy.reviewingPush', this.reviews.size > 0);
  }

  /**
   * Why a write failed, in one sentence; a policy the gateway rejected also gets its errors as
   * diagnostics on the lines they name.
   */
  explain(document: vscode.TextDocument, e: unknown, where: string): string {
    if (e instanceof ArmError && e.status === 403) return `Not allowed to change ${where}: ${e.message} (it needs a role that can write policies, such as API Management Service Contributor).`;
    if (e instanceof ArmError && e.status === 400) {
      const found = gatewayErrors(e.details.length ? e.details : [e.message]);
      this.errors.set(
        document.uri,
        found.map((g) => {
          const line = Math.min(Math.max(g.line - 1, 0), document.lineCount - 1);
          const start = new vscode.Position(line, g.line ? Math.max(g.column - 1, 0) : 0);
          const word = document.getWordRangeAtPosition(start, /[\w.:-]+/);
          const range = g.line ? (word ?? new vscode.Range(start, start.translate(0, 1))) : document.lineAt(0).range;
          const d = new vscode.Diagnostic(range, g.message, vscode.DiagnosticSeverity.Error);
          d.source = 'apim (gateway)';
          d.code = 'gateway-rejected';
          return d;
        }),
      );
      return `${where} rejected the policy: ${found[0]?.message ?? e.message}`;
    }
    return `Couldn't push to ${where}: ${(e as Error).message}`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/**
 * **APIM: Push to Instance**, for a policy file in the workspace or an editable copy from the
 * instance: works out which policy it is, then opens the review diff.
 */
export function pushCommand(cache: DocumentCache, connection: InstanceConnection, support: PushSupport): (uri?: unknown) => Promise<void> {
  return async (arg?: unknown) => {
    const document = arg instanceof vscode.Uri ? await vscode.workspace.openTextDocument(arg) : vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== LANGUAGE_ID || (document.uri.scheme !== 'file' && document.uri.scheme !== 'apim-edit')) {
      void vscode.window.showInformationMessage('Open the policy to push first. To change one that only exists on the instance, use Open as Editable.');
      return;
    }
    if (!(await support.ensureAllowed())) return;

    let target: Scope | undefined;
    if (document.uri.scheme === 'apim-edit') {
      target = scopeFromInstancePath(document.uri.path);
    } else {
      const root = summarize(cache.get(document)).root;
      if (!root) {
        void vscode.window.showErrorMessage('This file has no <policies> or <fragment> root, so there is nothing to push.');
        return;
      }
      target = connection.scopeOf(document.uri);
      if (root === 'fragment' && target?.kind !== 'fragment') {
        const id = await vscode.window.showInputBox({
          title: 'Fragment id on the instance',
          value: fragmentIdsFor(document.uri.path)[0] ?? '',
          validateInput: (v) => (/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v.trim()) ? undefined : 'Letters, digits, - and _, up to 80 characters.'),
        });
        if (!id) return;
        target = { kind: 'fragment', fragment: id.trim() };
        await connection.setScope(document.uri, target);
      } else if (root === 'policies' && (!target || target.kind === 'fragment')) {
        const picked = await connection.pickScope(`Which policy does ${vscode.workspace.asRelativePath(document.uri)} replace?`);
        if (!picked) return;
        target = picked;
        await connection.setScope(document.uri, target);
      }
    }
    if (target) await support.review(document, target);
  };
}


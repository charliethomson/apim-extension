import * as vscode from 'vscode';
import { CSHARP_EXTENSION_ID, type ShadowBackend } from '../csharp/backend';
import { LANGUAGE_ID } from '../documents';

/** A language status item saying which C# mode expressions get. */
export function registerStatus(backend: () => Promise<ShadowBackend | undefined>, enabled: boolean): vscode.Disposable {
  const item = vscode.languages.createLanguageStatusItem('apimPolicy.csharp', LANGUAGE_ID);
  item.name = 'APIM C# expressions';

  const update = () => {
    item.command = undefined;
    item.severity = vscode.LanguageStatusSeverity.Information;
    if (!enabled) {
      item.text = 'C# expressions: off';
      item.detail = 'apimPolicy.csharp.enabled';
      return;
    }
    if (!vscode.workspace.isTrusted) {
      item.text = 'C# expressions: Restricted Mode';
      item.detail = 'Trust the workspace to enable C# IntelliSense';
      item.command = { title: 'Manage Trust', command: 'workbench.trust.manage' };
      return;
    }
    item.text = 'C# expressions';
    item.detail = undefined;
    item.busy = true;
    void backend().then((b) => {
      item.busy = false;
      if (!b) {
        const installed = !!vscode.extensions.getExtension(CSHARP_EXTENSION_ID);
        item.severity = vscode.LanguageStatusSeverity.Warning;
        item.detail = installed ? 'C# extension unavailable' : 'Install the C# extension for full IntelliSense';
        if (!installed) item.command = { title: 'Install', command: 'workbench.extensions.installExtension', arguments: [CSHARP_EXTENSION_ID] };
        return;
      }
      item.detail = b.mode === 'file' ? 'full (shadow file-based app)' : 'completion only (needs .NET 10 SDK for type checking)';
    });
  };

  update();
  return vscode.Disposable.from(item, vscode.workspace.onDidGrantWorkspaceTrust(update));
}

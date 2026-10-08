import * as vscode from 'vscode';
import { DocumentCache } from './documents';
import { registerStructuralDiagnostics } from './features/diagnostics';
import { FragmentIndex, registerFragmentNavigation } from './features/fragments';
import { registerPolicyHover } from './features/hover';
import { registerLanguageDetection } from './features/languageDetection';
import { catalog } from './policy/catalog';

export function activate(context: vscode.ExtensionContext): void {
  const cache = new DocumentCache();
  const fragments = new FragmentIndex();
  context.subscriptions.push(
    cache,
    fragments,
    registerLanguageDetection(),
    registerStructuralDiagnostics(cache, catalog),
    registerPolicyHover(cache, catalog),
    registerFragmentNavigation(cache, fragments),
  );
}

export function deactivate(): void {}

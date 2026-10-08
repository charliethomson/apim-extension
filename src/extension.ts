import * as vscode from 'vscode';
import { DocumentCache } from './documents';
import { registerStructuralDiagnostics } from './features/diagnostics';
import { registerLanguageDetection } from './features/languageDetection';
import { catalog } from './policy/catalog';

export function activate(context: vscode.ExtensionContext): void {
  const cache = new DocumentCache();
  context.subscriptions.push(cache, registerLanguageDetection(), registerStructuralDiagnostics(cache, catalog));
}

export function deactivate(): void {}

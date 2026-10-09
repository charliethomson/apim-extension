import * as vscode from 'vscode';
import { LANGUAGE_ID } from '../documents';
import { looksLikePolicy } from '../parser/detect';

/**
 * Switches XML documents to apim-policy when they match `apimPolicy.files.include` or, with
 * `apimPolicy.files.detectByContent`, when their root element is <policies> or <fragment>.
 */
export function registerLanguageDetection(): vscode.Disposable {
  const consider = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'xml') return;
    const config = vscode.workspace.getConfiguration('apimPolicy', doc);
    const globs = config.get<string[]>('files.include', []);
    const byGlob = globs.some((pattern) => vscode.languages.match({ pattern }, doc) > 0);
    const byContent = config.get<boolean>('files.detectByContent', true) && looksLikePolicy(doc.getText());
    if (byGlob || byContent) void vscode.languages.setTextDocumentLanguage(doc, LANGUAGE_ID);
  };
  vscode.workspace.textDocuments.forEach(consider);
  return vscode.Disposable.from(
    vscode.workspace.onDidOpenTextDocument(consider),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('apimPolicy.files')) vscode.workspace.textDocuments.forEach(consider);
    }),
  );
}

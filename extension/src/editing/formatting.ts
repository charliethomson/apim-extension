import * as vscode from 'vscode';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import { formatPolicy } from '@charliethomson/apim-analysis';

/**
 * Format Document and Format Selection for policies: indentation and line breaks only (see
 * `formatPolicy` in @charliethomson/apim-analysis). A selection (or format-on-save's modified lines) gets every edit of each
 * element that starts inside it, and none of the others: applying half of an element's edits
 * would move its content without moving the element.
 */
export function registerFormatting(cache: DocumentCache): vscode.Disposable {
  const edits = (document: vscode.TextDocument, options: vscode.FormattingOptions, within?: vscode.Range) => {
    const doc = cache.get(document);
    const out: vscode.TextEdit[] = [];
    for (const e of formatPolicy(doc, { tabSize: options.tabSize, insertSpaces: options.insertSpaces })) {
      if (within && !within.contains(document.positionAt(e.group))) continue;
      out.push(vscode.TextEdit.replace(toRange(document, e), e.text));
    }
    if (!out.length && doc.diagnostics.length && !within) {
      vscode.window.setStatusBarMessage('$(warning) Not formatted: fix the XML errors first, so it knows where each element ends.', 4000);
    }
    return out;
  };
  return vscode.Disposable.from(
    vscode.languages.registerDocumentFormattingEditProvider(LANGUAGE_ID, { provideDocumentFormattingEdits: (d, o) => edits(d, o) }),
    vscode.languages.registerDocumentRangeFormattingEditProvider(LANGUAGE_ID, { provideDocumentRangeFormattingEdits: (d, r, o) => edits(d, o, r) }),
  );
}

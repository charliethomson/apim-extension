import { posix } from 'node:path';
import * as vscode from 'vscode';
import { LANGUAGE_ID, type DocumentCache } from '../documents';
import { fragmentIdsFor, scopeFromInstancePath, scopeLabel } from '@apim-policy/core';
import { type DocContext, fragmentMarkdown, GENERATED_MARKER, policyMarkdown, summarize } from '@apim-policy/analysis';
import type { InstanceConnection } from '../instance/connection';
import type { PolicyIndex } from '../workspace/policyIndex';
import type { ShapeService } from '../workspace/shapes';

/**
 * Markdown docs for policies and fragments (`fragmentMarkdown` and `policyMarkdown` in @apim-policy/analysis):
 *
 * - **APIM: Generate Docs** previews the doc for the open policy or fragment, writing nothing;
 * - **APIM: Write Fragment Docs** writes one beside each fragment in the workspace (`README.md` in
 *   an APIOps fragment folder, else `<name>.md`), replacing only files it wrote before.
 */
export function docCommands(cache: DocumentCache, index: PolicyIndex, shapes: ShapeService, connection: InstanceConnection): Record<string, (...args: unknown[]) => unknown> {
  const preview = async (arg?: unknown) => {
    const document = arg instanceof vscode.Uri ? await vscode.workspace.openTextDocument(arg) : vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== LANGUAGE_ID) {
      void vscode.window.showInformationMessage('Open a policy or fragment to document.');
      return;
    }
    const doc = cache.get(document);
    const shapeText = await shapes.typeTexts(doc);
    const fileHref = (uri: vscode.Uri) => uri.toString();
    let markdown: string;
    if (summarize(doc).root === 'fragment') {
      const id = fragmentIdOf(document.uri);
      const callers = (await index.callers([id])).map((c) => ({ label: vscode.workspace.asRelativePath(c.uri), href: fileHref(c.uri) }));
      const fragmentHref = await hrefsTo(index, (uri) => fileHref(uri));
      markdown = fragmentMarkdown(id, doc, { callers, shapeText, fragmentHref });
    } else {
      const scope = connection.scopeOf(document.uri);
      const fragmentHref = await hrefsTo(index, (uri) => fileHref(uri));
      markdown = policyMarkdown(scope ? `The ${scopeLabel(scope)} policy` : vscode.workspace.asRelativePath(document.uri), doc, { shapeText, fragmentHref, scope: scope && scopeLabel(scope) });
    }
    const md = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
    try {
      await vscode.commands.executeCommand('markdown.showPreviewToSide', md.uri);
    } catch {
      await vscode.window.showTextDocument(md, vscode.ViewColumn.Beside);
    }
  };

  const write = async () => {
    const fragments = await index.localFragments();
    if (!fragments.length) {
      void vscode.window.showInformationMessage('No fragments in this workspace to document.');
      return;
    }
    // Where each fragment's doc goes, so docs can link to each other.
    const target = new Map(fragments.map((f) => [f.uri.toString(), docUri(f.uri)]));
    const byId = new Map<string, vscode.Uri>();
    for (const f of fragments) for (const id of f.ids) if (!byId.has(id)) byId.set(id, target.get(f.uri.toString())!);
    let written = 0;
    const kept: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Writing fragment docs…' }, async () => {
      for (const f of fragments) {
        const out = target.get(f.uri.toString())!;
        // Never replace a file this didn't write.
        const existing = await readText(out);
        if (existing !== undefined && !existing.startsWith(GENERATED_MARKER)) {
          kept.push(vscode.workspace.asRelativePath(out));
          continue;
        }
        const relative = (to: vscode.Uri) => posix.relative(posix.dirname(out.path), to.path) || posix.basename(to.path);
        const ctx: DocContext = {
          callers: (await index.callers(f.ids)).map((c) => ({ label: vscode.workspace.asRelativePath(c.uri), href: encodeURI(relative(c.uri)) })),
          fragmentHref: (id) => {
            const doc = byId.get(id);
            return doc && encodeURI(relative(doc));
          },
          shapeText: await shapes.typeTexts(f.doc),
        };
        const markdown = fragmentMarkdown(f.ids[0], f.doc, ctx);
        if (markdown === existing) continue;
        await vscode.workspace.fs.writeFile(out, new TextEncoder().encode(markdown));
        written++;
      }
    });
    const note = kept.length ? ` Left ${kept.length} hand-written file${kept.length === 1 ? '' : 's'} alone: ${kept.slice(0, 3).join(', ')}${kept.length > 3 ? ', …' : ''}.` : '';
    void vscode.window.showInformationMessage(`Wrote ${written} fragment doc${written === 1 ? '' : 's'} (${fragments.length - written - kept.length} already up to date).${note}`);
  };

  return { 'apimPolicy.generateDocs': preview, 'apimPolicy.writeDocs': write };
}

/** The fragment id a document provides: from an instance path, or the file's name or folder. */
function fragmentIdOf(uri: vscode.Uri): string {
  const scope = uri.scheme === 'file' ? undefined : scopeFromInstancePath(uri.path);
  return scope?.kind === 'fragment' ? scope.fragment : (fragmentIdsFor(uri.path)[0] ?? posix.basename(uri.path));
}

/** Where a fragment's doc goes: `README.md` beside an APIOps `policy.xml`, else `<name>.md`. */
function docUri(uri: vscode.Uri): vscode.Uri {
  const base = posix.basename(uri.path);
  const name = base === 'policy.xml' ? 'README.md' : `${base.replace(/(\.policy)?\.xml$/i, '')}.md`;
  return uri.with({ path: posix.join(posix.dirname(uri.path), name) });
}

/** Links to the workspace's fragment files by id, for a preview. */
async function hrefsTo(index: PolicyIndex, href: (uri: vscode.Uri) => string): Promise<(id: string) => string | undefined> {
  const byId = new Map<string, vscode.Uri>();
  for (const f of await index.localFragments()) for (const id of f.ids) if (!byId.has(id)) byId.set(id, f.uri);
  return (id) => {
    const uri = byId.get(id);
    return uri && href(uri);
  };
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

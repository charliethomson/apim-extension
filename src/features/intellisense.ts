/**
 * Completion, hover, signature help and go-to-definition for policy documents: the XML side from
 * the catalog, known variables and headers in dictionary lookups, and everything else inside
 * expressions forwarded to the C# extension through the shadow document. Without the C#
 * extension, `context.` member chains still complete from the stubs.
 */

import * as vscode from 'vscode';
import type { ShadowBackend, SyncedShadow } from '../csharp/backend';
import { classifyShadowLocation } from '../csharp/mapping';
import { membersAfter, type StubModel } from '../csharp/stubModel';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import type { Document, Expression } from '../parser/ast';
import { xmlCompletions, type XmlItem, type XmlItemKind } from '../policy/completion';
import type { Catalog } from '../policy/schema';
import { COMMON_HEADERS, escapeForDocument, expressionAt, isEscapedFormat, keyAccessAt } from '../policy/variables';
import type { PolicyIndex } from './policyIndex';

export interface IntellisenseDeps {
  cache: DocumentCache;
  catalog: Catalog;
  index: PolicyIndex;
  stubs: StubModel;
  stubsUri: vscode.Uri;
  /** Resolves to the C# backend, or undefined when C# features are unavailable. */
  backend: () => Promise<ShadowBackend | undefined>;
}

const XML_KIND: Record<XmlItemKind, vscode.CompletionItemKind> = {
  element: vscode.CompletionItemKind.Class,
  closeTag: vscode.CompletionItemKind.Class,
  attribute: vscode.CompletionItemKind.Property,
  value: vscode.CompletionItemKind.EnumMember,
  snippet: vscode.CompletionItemKind.Snippet,
  namedValue: vscode.CompletionItemKind.Constant,
  fragment: vscode.CompletionItemKind.Reference,
};

export function registerIntellisense(deps: IntellisenseDeps): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.languages.registerCompletionItemProvider(LANGUAGE_ID, completionProvider(deps), '<', '/', ' ', '"', "'", '=', '{', '@', '.', '[', '('),
    vscode.languages.registerHoverProvider(LANGUAGE_ID, hoverProvider(deps)),
    vscode.languages.registerSignatureHelpProvider(LANGUAGE_ID, signatureProvider(deps), { triggerCharacters: ['(', ','], retriggerCharacters: [','] }),
    vscode.languages.registerDefinitionProvider(LANGUAGE_ID, definitionProvider(deps)),
  );
}

// ---- completion ---------------------------------------------------------------------------

function completionProvider(deps: IntellisenseDeps): vscode.CompletionItemProvider {
  return {
    async provideCompletionItems(document, position, token, context) {
      const doc = deps.cache.get(document);
      const offset = document.offsetAt(position);

      const xml = xmlCompletions(doc, offset, {
        catalog: deps.catalog,
        fragmentIds: await deps.index.fragmentIds(),
        namedValues: await deps.index.namedValues(),
      });
      if (xml) return xml.map((i) => toXmlItem(document, i));

      const expr = expressionAt(doc, offset);
      if (!expr) return undefined;
      const code = expr.map.toGenerated(offset);
      if (code === undefined) return undefined;

      const keys = await keyItems(deps, document, doc, expr, code);
      if (keys) return keys;

      const backend = await deps.backend();
      if (backend) {
        const forwarded = await forwardCompletion(backend, document, doc, offset, context, token);
        if (forwarded) return forwarded;
      }
      return stubCompletion(deps.stubs, document, expr, code);
    },
  };
}

function toXmlItem(document: vscode.TextDocument, i: XmlItem): vscode.CompletionItem {
  const item = new vscode.CompletionItem(i.label, XML_KIND[i.kind]);
  item.insertText = new vscode.SnippetString(i.insert);
  item.range = toRange(document, i.range);
  item.detail = i.detail;
  item.sortText = i.sortText;
  if (i.documentation) item.documentation = new vscode.MarkdownString(i.documentation);
  if (i.kind === 'element' && /\$\d|\$\{\d/.test(i.insert)) {
    item.command = { title: 'Suggest', command: 'editor.action.triggerSuggest' };
  }
  return item;
}

async function keyItems(deps: IntellisenseDeps, document: vscode.TextDocument, doc: Document, expr: Expression, code: number): Promise<vscode.CompletionItem[] | undefined> {
  const access = keyAccessAt(expr.code, code);
  if (!access) return undefined;
  const range = expr.map.rangeToSource(access.range);
  if (!range) return undefined;
  const escaped = isEscapedFormat(doc) && !inCData(doc, expr);
  const make = (name: string, kind: vscode.CompletionItemKind, detail?: string, docs?: string) => {
    const item = new vscode.CompletionItem(name, kind);
    item.insertText = escapeForDocument(access.quote ? `"${name}"` : name, escaped, false);
    item.range = toRange(document, range);
    item.detail = detail;
    if (docs) item.documentation = new vscode.MarkdownString(docs);
    item.sortText = `0${name}`;
    return item;
  };
  if (access.kind === 'header') return COMMON_HEADERS.map((h) => make(h, vscode.CompletionItemKind.Value, 'header'));
  const vars = await deps.index.variables(document);
  return vars.map((v) =>
    make(v.name, vscode.CompletionItemKind.Variable, v.origin ?? `${v.element} in this file`, v.value ? `Value: \`${v.value}\`` : undefined),
  );
}

async function forwardCompletion(
  backend: ShadowBackend,
  document: vscode.TextDocument,
  doc: Document,
  offset: number,
  context: vscode.CompletionContext,
  token: vscode.CancellationToken,
): Promise<vscode.CompletionList | undefined> {
  const synced = await backend.sync(document, doc);
  if (!synced || token.isCancellationRequested) return undefined;
  const gen = synced.shadow.map.toGenerated(offset);
  if (gen === undefined) return undefined;
  const trigger = context.triggerCharacter === '.' ? '.' : undefined;
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider',
    synced.csDoc.uri,
    synced.csDoc.positionAt(gen),
    trigger,
    30,
  );
  if (!list) return undefined;
  const expr = expressionAt(doc, offset)!;
  const escaped = isEscapedFormat(doc) && !inCData(doc, expr);
  const items: vscode.CompletionItem[] = [];
  for (const item of list.items) {
    const mapped = mapCompletion(item, synced, document, escaped);
    if (mapped) items.push(mapped);
  }
  return new vscode.CompletionList(items, list.isIncomplete);
}

/**
 * Copies a C# completion item with its ranges mapped into the policy. Items are copied, not
 * mutated: the ones the C# provider hands back don't reliably take new property values.
 */
function mapCompletion(item: vscode.CompletionItem, synced: SyncedShadow, document: vscode.TextDocument, escaped: boolean): vscode.CompletionItem | undefined {
  const mapRange = (r: vscode.Range) => {
    const range = synced.shadow.map.rangeToSource({ start: synced.csDoc.offsetAt(r.start), end: synced.csDoc.offsetAt(r.end) });
    return range ? toRange(document, range) : undefined;
  };
  const out = new vscode.CompletionItem(item.label, item.kind);
  if (item.range) {
    if (item.range instanceof vscode.Range) {
      const r = mapRange(item.range);
      if (!r) return undefined;
      out.range = r;
    } else {
      const inserting = mapRange(item.range.inserting);
      const replacing = mapRange(item.range.replacing);
      if (!inserting || !replacing) return undefined;
      out.range = { inserting, replacing };
    }
  }
  let insert = item.insertText;
  if (escaped) {
    if (typeof insert === 'string') insert = escapeForDocument(insert, true, false);
    else if (insert instanceof vscode.SnippetString) insert = new vscode.SnippetString(escapeForDocument(insert.value, true, false));
  }
  out.insertText = insert;
  out.detail = item.detail;
  out.documentation = item.documentation;
  out.sortText = item.sortText;
  out.filterText = item.filterText;
  out.preselect = item.preselect;
  out.commitCharacters = item.commitCharacters;
  out.keepWhitespace = item.keepWhitespace;
  out.tags = item.tags;
  out.command = item.command;
  return out;
}

function stubCompletion(model: StubModel, document: vscode.TextDocument, expr: Expression, code: number): vscode.CompletionItem[] | undefined {
  const before = expr.code.slice(0, code);
  const hit = membersAfter(model, before);
  if (!hit) {
    // Not after a member access: offer `context` itself.
    const word = /(^|[^\w.])(\w*)$/.exec(before);
    if (word) {
      const typed = word[2];
      const start = expr.map.toSource(code - typed.length);
      if (start === undefined) return undefined;
      const item = new vscode.CompletionItem('context', vscode.CompletionItemKind.Variable);
      item.detail = 'IProxyRequestContext';
      item.documentation = new vscode.MarkdownString(model.get('IProxyRequestContext')?.doc ?? '');
      item.range = toRange(document, { start, end: expr.map.toSource(code)! });
      return [item];
    }
    return undefined;
  }
  const start = expr.map.toSource(code - hit.typed.length);
  const end = expr.map.toSource(code);
  if (start === undefined || end === undefined) return undefined;
  return hit.type.members.map((m) => {
    const kind = m.kind === 'method' ? vscode.CompletionItemKind.Method : m.kind === 'enumMember' ? vscode.CompletionItemKind.EnumMember : vscode.CompletionItemKind.Property;
    const item = new vscode.CompletionItem(m.name, kind);
    item.detail = m.kind === 'method' ? `${m.type} ${m.name}(${m.params ?? ''})` : `${m.type} ${m.name}`;
    if (m.doc) item.documentation = new vscode.MarkdownString(m.doc);
    item.range = toRange(document, { start, end });
    return item;
  });
}

// ---- hover --------------------------------------------------------------------------------

function hoverProvider(deps: IntellisenseDeps): vscode.HoverProvider {
  return {
    async provideHover(document, position, token) {
      const doc = deps.cache.get(document);
      const offset = document.offsetAt(position);
      const expr = expressionAt(doc, offset);
      if (!expr) return undefined;
      const code = expr.map.toGenerated(offset);
      if (code === undefined) return undefined;

      const access = keyAccessAt(expr.code, code);
      if (access?.kind === 'variable' && access.key) {
        const v = (await deps.index.variables(document)).find((x) => x.name === access.key);
        const range = expr.map.rangeToSource(access.range);
        const md = new vscode.MarkdownString(
          v
            ? `**Variable** \`${v.name}\`\n\nSet by \`<${v.element}>\` ${v.origin ? `(${v.origin})` : 'in this file'}${v.value ? `\n\nValue: \`${v.value}\`` : ''}`
            : `**Variable** \`${access.key}\`\n\nNot set in this file or a related fragment.`,
        );
        return new vscode.Hover(md, range ? toRange(document, range) : undefined);
      }

      const backend = await deps.backend();
      if (backend) {
        const synced = await backend.sync(document, doc);
        const gen = synced?.shadow.map.toGenerated(offset);
        if (synced && gen !== undefined && !token.isCancellationRequested) {
          const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', synced.csDoc.uri, synced.csDoc.positionAt(gen));
          const h = hovers?.[0];
          if (h) {
            const r = h.range && synced.shadow.map.rangeToSource({ start: synced.csDoc.offsetAt(h.range.start), end: synced.csDoc.offsetAt(h.range.end) });
            return new vscode.Hover(hovers.flatMap((x) => x.contents), r ? toRange(document, r) : undefined);
          }
          return undefined;
        }
      }

      // Fallback: hover on a context member chain from the stubs.
      const word = /\w*$/.exec(expr.code.slice(0, code))![0] + /^\w*/.exec(expr.code.slice(code))![0];
      const start = code - /\w*$/.exec(expr.code.slice(0, code))![0].length;
      const hit = membersAfter(deps.stubs, expr.code.slice(0, start) + word);
      const member = hit?.type.members.find((m) => m.name === word);
      if (!member) return undefined;
      const sig = member.kind === 'method' ? `${member.type} ${hit!.type.name}.${member.name}(${member.params ?? ''})` : `${member.type} ${hit!.type.name}.${member.name}`;
      const md = new vscode.MarkdownString().appendCodeblock(sig, 'csharp');
      if (member.doc) md.appendMarkdown(member.doc);
      return new vscode.Hover(md);
    },
  };
}

// ---- signature help -------------------------------------------------------------------------

function signatureProvider(deps: IntellisenseDeps): vscode.SignatureHelpProvider {
  return {
    async provideSignatureHelp(document, position, token, context) {
      const doc = deps.cache.get(document);
      const offset = document.offsetAt(position);
      if (!expressionAt(doc, offset)) return undefined;
      const backend = await deps.backend();
      const synced = backend && (await backend.sync(document, doc));
      const gen = synced?.shadow.map.toGenerated(offset);
      if (!synced || gen === undefined || token.isCancellationRequested) return undefined;
      return vscode.commands.executeCommand<vscode.SignatureHelp>(
        'vscode.executeSignatureHelpProvider',
        synced.csDoc.uri,
        synced.csDoc.positionAt(gen),
        context.triggerCharacter,
      );
    },
  };
}

// ---- definition ---------------------------------------------------------------------------

function definitionProvider(deps: IntellisenseDeps): vscode.DefinitionProvider {
  return {
    async provideDefinition(document, position, token) {
      const doc = deps.cache.get(document);
      const offset = document.offsetAt(position);
      const expr = expressionAt(doc, offset);
      if (!expr) return undefined;
      const code = expr.map.toGenerated(offset);
      if (code === undefined) return undefined;

      const access = keyAccessAt(expr.code, code);
      if (access?.kind === 'variable' && access.key) {
        const v = (await deps.index.variables(document)).find((x) => x.name === access.key);
        if (!v) return undefined;
        const target = await vscode.workspace.openTextDocument(v.uri);
        const origin = expr.map.rangeToSource(access.range);
        return [
          {
            originSelectionRange: origin ? toRange(document, origin) : undefined,
            targetUri: v.uri,
            targetRange: toRange(target, v.range),
          } satisfies vscode.LocationLink,
        ];
      }

      const backend = await deps.backend();
      const synced = backend && (await backend.sync(document, doc));
      const gen = synced?.shadow.map.toGenerated(offset);
      if (!synced || gen === undefined || token.isCancellationRequested) return undefined;
      const results = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        'vscode.executeDefinitionProvider',
        synced.csDoc.uri,
        synced.csDoc.positionAt(gen),
      );
      const out: vscode.Location[] = [];
      for (const r of results ?? []) {
        const uri = 'targetUri' in r ? r.targetUri : r.uri;
        const range = 'targetUri' in r ? (r.targetSelectionRange ?? r.targetRange) : r.range;
        if (uri.toString() !== synced.csDoc.uri.toString()) {
          out.push(new vscode.Location(uri, range)); // metadata-as-source and the like
          continue;
        }
        const t = classifyShadowLocation(synced.shadow, synced.index, synced.footerStart, { line: range.start.line, character: range.start.character });
        if (t.kind === 'policy') out.push(new vscode.Location(document.uri, toRange(document, t.range)));
        else if (t.kind === 'stubs') out.push(new vscode.Location(deps.stubsUri, new vscode.Position(t.line, t.character)));
      }
      return out;
    },
  };
}

function inCData(doc: Document, expr: Expression): boolean {
  return doc.source.lastIndexOf('<![CDATA[', expr.range.start) > doc.source.lastIndexOf(']]>', expr.range.start);
}


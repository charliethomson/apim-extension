/**
 * Completion, hover, signature help and go-to-definition for policy documents: the XML side from
 * the catalog, known variables and headers in dictionary lookups, and everything else inside
 * expressions either forwarded to the C# extension through the shadow document or, without it
 * (or in `builtin` mode), answered by the built-in C# engine.
 */

import * as vscode from 'vscode';
import type { ShadowBackend, SyncedShadow } from '../csharp/backend';
import { classifyShadowLocation } from '../csharp/mapping';
import type { CSharpEngine, EntryKind } from '../csharp/lang/service';
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
  stubsUri: vscode.Uri;
  /** Resolves to the built-in engine, or undefined when C# features are off. */
  engine: () => Promise<CSharpEngine | undefined>;
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

const ENTRY_KIND: Record<EntryKind, vscode.CompletionItemKind> = {
  method: vscode.CompletionItemKind.Method,
  property: vscode.CompletionItemKind.Property,
  field: vscode.CompletionItemKind.Field,
  constant: vscode.CompletionItemKind.Constant,
  enumMember: vscode.CompletionItemKind.EnumMember,
  class: vscode.CompletionItemKind.Class,
  interface: vscode.CompletionItemKind.Interface,
  struct: vscode.CompletionItemKind.Struct,
  enum: vscode.CompletionItemKind.Enum,
  delegate: vscode.CompletionItemKind.Function,
  namespace: vscode.CompletionItemKind.Module,
  local: vscode.CompletionItemKind.Variable,
  parameter: vscode.CompletionItemKind.Variable,
  keyword: vscode.CompletionItemKind.Keyword,
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
      if (xml) return xml.map((i) => toXmlItem(document, i, position));

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
      const engine = await deps.engine();
      return engine && engineCompletion(engine, document, expr, code, position);
    },
  };
}

function toXmlItem(document: vscode.TextDocument, i: XmlItem, position: vscode.Position): vscode.CompletionItem {
  const item = new vscode.CompletionItem(i.label, XML_KIND[i.kind]);
  item.insertText = new vscode.SnippetString(i.insert);
  item.range = onCursorLine(toRange(document, i.range), position);
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
  const make = (name: string, kind: vscode.CompletionItemKind, detail?: string, docs?: vscode.MarkdownString) => {
    const item = new vscode.CompletionItem(name, kind);
    item.insertText = escapeForDocument(access.quote ? `"${name}"` : name, escaped, false);
    item.range = toRange(document, range);
    item.detail = detail;
    if (docs) item.documentation = docs;
    item.sortText = `0${name}`;
    return item;
  };
  if (access.kind === 'header') return COMMON_HEADERS.map((h) => make(h, vscode.CompletionItemKind.Value, 'header'));
  const vars = await deps.index.variables(document);
  return vars.map((v) =>
    make(v.name, vscode.CompletionItemKind.Variable, v.origin ?? `${v.element} in this file`, v.value ? valueMarkdown(v.value) : undefined),
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
  const synced = await syncCurrent(backend, document);
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
    // Roslyn's complex edits (indexers, conversions, operators) run a command that opens and
    // edits the shadow file itself, which would show it to the user and leave the policy alone.
    if (item.command?.command === 'roslyn.client.completionComplexEdit') continue;
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

function engineCompletion(engine: CSharpEngine, document: vscode.TextDocument, expr: Expression, code: number, position: vscode.Position): vscode.CompletionItem[] | undefined {
  const result = engine.complete(expr.code, expr.kind, code);
  if (!result) return undefined;
  const range = expr.map.rangeToSource(result.span);
  if (!range) return undefined;
  const r = onCursorLine(toRange(document, range), position);
  return result.entries.map((e) => {
    const item = new vscode.CompletionItem(e.label, ENTRY_KIND[e.kind]);
    item.detail = e.detail;
    if (e.documentation) item.documentation = new vscode.MarkdownString(e.documentation);
    if (e.insertText) item.insertText = e.insertText;
    item.sortText = e.sortText;
    item.range = r;
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
        // Names and values come from workspace files, so they go in as text, never as Markdown.
        const md = new vscode.MarkdownString().appendMarkdown('**Variable** ').appendText(access.key);
        if (v) {
          md.appendMarkdown('\n\nSet by ').appendText(`<${v.element}> ${v.origin ? `(${v.origin})` : 'in this file'}`);
          if (v.value) md.appendMarkdown('\n\n').appendMarkdown(valueMarkdown(v.value).value);
        } else {
          md.appendMarkdown('\n\nNot set in this file or a related fragment.');
        }
        return new vscode.Hover(md, range ? toRange(document, range) : undefined);
      }

      const backend = await deps.backend();
      if (backend) {
        const synced = await syncCurrent(backend, document);
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

      const engine = await deps.engine();
      const h = engine?.hover(expr.code, expr.kind, code);
      if (!h) return undefined;
      const md = new vscode.MarkdownString().appendCodeblock(h.signature, 'csharp');
      if (h.documentation) md.appendMarkdown(h.documentation);
      const range = expr.map.rangeToSource(h.span);
      return new vscode.Hover(md, range ? toRange(document, range) : undefined);
    },
  };
}

// ---- signature help -------------------------------------------------------------------------

function signatureProvider(deps: IntellisenseDeps): vscode.SignatureHelpProvider {
  return {
    async provideSignatureHelp(document, position, token, context) {
      const doc = deps.cache.get(document);
      const offset = document.offsetAt(position);
      const expr = expressionAt(doc, offset);
      if (!expr) return undefined;
      const backend = await deps.backend();
      if (!backend) {
        const code = expr.map.toGenerated(offset);
        const engine = await deps.engine();
        return engine && code !== undefined ? engineSignatures(engine, expr, code) : undefined;
      }
      const synced = await syncCurrent(backend, document);
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

function engineSignatures(engine: CSharpEngine, expr: Expression, code: number): vscode.SignatureHelp | undefined {
  const r = engine.signatureHelp(expr.code, expr.kind, code);
  if (!r) return undefined;
  const help = new vscode.SignatureHelp();
  help.signatures = r.signatures.map((s) => {
    const info = new vscode.SignatureInformation(s.label, s.documentation ? new vscode.MarkdownString(s.documentation) : undefined);
    info.parameters = s.parameters.map((p) => new vscode.ParameterInformation(p.label));
    return info;
  });
  help.activeSignature = r.activeSignature;
  help.activeParameter = r.activeParameter;
  return help;
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
      if (!backend) {
        const engine = await deps.engine();
        const def = engine?.definition(expr.code, expr.kind, code);
        if (!def) return undefined;
        if (def.kind === 'stub') return [new vscode.Location(deps.stubsUri, new vscode.Position(def.location.line, def.location.character))];
        const range = expr.map.rangeToSource(def.span);
        return range ? [new vscode.Location(document.uri, toRange(document, range))] : undefined;
      }
      const synced = await syncCurrent(backend, document);
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

/**
 * VS Code drops completion items whose range spans lines or doesn't contain the cursor. Ranges
 * from a half-typed document can (an unclosed attribute value runs to the next quote), so clamp
 * them to the cursor's line.
 */
function onCursorLine(range: vscode.Range, position: vscode.Position): vscode.Range {
  const start = range.start.line === position.line && range.start.isBeforeOrEqual(position) ? range.start : position.with({ character: 0 });
  const end = range.end.line === position.line && range.end.isAfterOrEqual(position) ? range.end : position;
  return new vscode.Range(start, end);
}

/** A set-variable value as a code block, so workspace text can't render as Markdown. */
function valueMarkdown(value: string): vscode.MarkdownString {
  return new vscode.MarkdownString().appendText('Value:').appendCodeblock(value, 'csharp');
}

/** The shadow for the document's current version, or undefined if it moved on meanwhile. */
async function syncCurrent(backend: ShadowBackend, document: vscode.TextDocument): Promise<SyncedShadow | undefined> {
  const version = document.version;
  const synced = await backend.sync(document);
  return synced && synced.version === version && document.version === version ? synced : undefined;
}

function inCData(doc: Document, expr: Expression): boolean {
  return doc.source.lastIndexOf('<![CDATA[', expr.range.start) > doc.source.lastIndexOf(']]>', expr.range.start);
}


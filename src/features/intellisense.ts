/**
 * Completion, hover, signature help and go-to-definition for policy documents: the XML side from
 * the catalog, known variables and headers in dictionary lookups, and everything else inside
 * expressions from the built-in C# engine.
 */

import * as vscode from 'vscode';
import type { CSharpEngine, EntryKind } from '../csharp/lang/service';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import type { Document, Expression } from '../parser/ast';
import { namesVariable, xmlCompletions, type XmlItem, type XmlItemKind } from '../policy/completion';
import { variableNameSuggestions, type FragmentDoc } from '../policy/fragmentDoc';
import { nodeAt } from '../parser/query';
import type { Catalog } from '../policy/schema';
import { COMMON_HEADERS, escapeForDocument, expressionAt, isEscapedFormat, keyAccessAt, summarize } from '../policy/variables';
import { within, type PolicyIndex } from './policyIndex';
import { NO_SHAPES, type JsonShape, type ShapeEnv } from '../csharp/lang/json';
import type { ShapeService } from './shapes';

export interface IntellisenseDeps {
  cache: DocumentCache;
  catalog: Catalog;
  index: PolicyIndex;
  stubsUri: vscode.Uri;
  /** Resolves to the built-in engine, or undefined when C# features are off. */
  engine: () => Promise<CSharpEngine | undefined>;
  shapes: ShapeService;
}

const XML_KIND: Record<XmlItemKind, vscode.CompletionItemKind> = {
  element: vscode.CompletionItemKind.Class,
  closeTag: vscode.CompletionItemKind.Class,
  attribute: vscode.CompletionItemKind.Property,
  value: vscode.CompletionItemKind.EnumMember,
  snippet: vscode.CompletionItemKind.Snippet,
  namedValue: vscode.CompletionItemKind.Constant,
  fragment: vscode.CompletionItemKind.Reference,
  variable: vscode.CompletionItemKind.Variable,
  backend: vscode.CompletionItemKind.Value,
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
    async provideCompletionItems(document, position) {
      const doc = deps.cache.get(document);
      const offset = document.offsetAt(position);

      const xml = xmlCompletions(doc, offset, {
        catalog: deps.catalog,
        fragmentIds: await deps.index.fragmentIds({ remoteWithin: 300 }),
        namedValues: await within(deps.index.namedValues(), [], 300),
        backends: await within(deps.index.backends(), [], 300),
        variables: await variableNames(deps, document, doc, offset),
      });
      if (xml) return xml.map((i) => toXmlItem(document, i, position));

      const expr = expressionAt(doc, offset);
      if (!expr) return undefined;
      const code = expr.map.toGenerated(offset);
      if (code === undefined) return undefined;

      const keys = await keyItems(deps, document, doc, expr, code);
      if (keys) return keys;

      const engine = await deps.engine();
      return engine && engineCompletion(engine, document, expr, code, position, await shapesFor(deps, doc), (await deps.shapes.wanted(doc)).get(expr));
    },
  };
}

/** The JSON shapes of the variables `doc` can read (see ShapeService); none without the engine. */
async function shapesFor(deps: IntellisenseDeps, doc: Document): Promise<ShapeEnv> {
  return (await deps.shapes.forDocument(doc)) ?? NO_SHAPES;
}

/** Names to offer when the cursor is in an attribute that names a variable; otherwise none. */
async function variableNames(deps: IntellisenseDeps, document: vscode.TextDocument, doc: Document, offset: number) {
  const hit = nodeAt(doc, offset);
  if (!hit.element || !hit.attribute || !hit.onAttributeValue || !namesVariable(hit.element, hit.attribute)) return undefined;
  const summary = summarize(doc);
  const includes: { id: string; header: FragmentDoc }[] = [];
  for (const id of new Set(summary.includes)) {
    const header = (await deps.index.fragment(id, document.uri))?.summary.header;
    if (header) includes.push({ id, header });
  }
  return variableNameSuggestions(includes, summary.header, await deps.index.variables(document));
}

function toXmlItem(document: vscode.TextDocument, i: XmlItem, position: vscode.Position): vscode.CompletionItem {
  const item = new vscode.CompletionItem(i.label, XML_KIND[i.kind]);
  item.insertText = new vscode.SnippetString(i.insert);
  item.range = onCursorLine(toRange(document, i.range), position);
  item.detail = i.detail;
  item.sortText = i.sortText;
  // A variable's description comes from a fragment header in the workspace: text, not Markdown.
  if (i.documentation) item.documentation = i.kind === 'variable' ? new vscode.MarkdownString().appendText(i.documentation) : new vscode.MarkdownString(i.documentation);
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
    make(v.name, vscode.CompletionItemKind.Variable, `${v.type ? `${v.type} · ` : ''}${v.origin ?? `${v.element} in this file`}`, variableDocs(v)),
  );
}


function engineCompletion(engine: CSharpEngine, document: vscode.TextDocument, expr: Expression, code: number, position: vscode.Position, shapes: ShapeEnv, wanted?: JsonShape): vscode.CompletionItem[] | undefined {
  const result = engine.complete(expr.code, expr.kind, code, shapes, wanted);
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
    async provideHover(document, position) {
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
        const engine = await deps.engine();
        const shape = engine && (await shapesFor(deps, doc)).get(access.key);
        if (shape && engine) md.appendCodeblock(engine.displayShape(shape), 'typescript');
        if (v) {
          if (v.type && !shape) md.appendMarkdown(' *').appendText(v.type).appendMarkdown('*');
          if (v.description) md.appendMarkdown('\n\n').appendText(v.description);
          if (v.element === '@in') md.appendMarkdown('\n\nAn @in of this fragment: whoever includes it sets it.');
          else if (v.element === '@out') md.appendMarkdown('\n\nAn @out of ').appendText(v.origin ?? 'a fragment');
          else md.appendMarkdown('\n\nSet by ').appendText(`<${v.element}> ${v.origin ? `(${v.origin})` : 'in this file'}`);
          if (v.value) md.appendMarkdown('\n\n').appendMarkdown(valueMarkdown(v.value).value);
        } else {
          md.appendMarkdown('\n\nNot set in this file or a related fragment.');
        }
        return new vscode.Hover(md, range ? toRange(document, range) : undefined);
      }


      const engine = await deps.engine();
      const h = engine?.hover(expr.code, expr.kind, code, await shapesFor(deps, doc), (await deps.shapes.wanted(doc)).get(expr));
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
    async provideSignatureHelp(document, position) {
      const doc = deps.cache.get(document);
      const offset = document.offsetAt(position);
      const expr = expressionAt(doc, offset);
      if (!expr) return undefined;
      const code = expr.map.toGenerated(offset);
      const engine = await deps.engine();
      return engine && code !== undefined ? engineSignatures(engine, expr, code) : undefined;
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
    async provideDefinition(document, position) {
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

      const engine = await deps.engine();
      const def = engine?.definition(expr.code, expr.kind, code);
      if (!def) return undefined;
      if (def.kind === 'stub') return [new vscode.Location(deps.stubsUri, new vscode.Position(def.location.line, def.location.character))];
      const range = expr.map.rangeToSource(def.span);
      return range ? [new vscode.Location(document.uri, toRange(document, range))] : undefined;
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

/** A variable's header description and set-variable value, as text. */
function variableDocs(v: { description?: string; value?: string }): vscode.MarkdownString | undefined {
  if (!v.description && !v.value) return undefined;
  const md = new vscode.MarkdownString();
  if (v.description) md.appendText(v.description);
  if (v.value) md.appendMarkdown(v.description ? '\n\n' : '').appendMarkdown(valueMarkdown(v.value).value);
  return md;
}

/** A set-variable value as a code block, so workspace text can't render as Markdown. */
function valueMarkdown(value: string): vscode.MarkdownString {
  return new vscode.MarkdownString().appendText('Value:').appendCodeblock(value, 'csharp');
}


function inCData(doc: Document, expr: Expression): boolean {
  return doc.source.lastIndexOf('<![CDATA[', expr.range.start) > doc.source.lastIndexOf(']]>', expr.range.start);
}


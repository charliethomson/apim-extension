/**
 * Completion for the XML side of a policy: element names, attributes, attribute values and
 * named values. Pure, so it can be tested without VS Code; the provider adapts the items.
 *
 * Context comes mostly from the raw text before the cursor, because the document being typed
 * is usually incomplete, and the parse supplies the enclosing elements.
 */

import type { Attribute, Document, Element, Node } from '../parser/ast';
import type { OffsetRange } from '../sourceMap';
import { resolveDef, sectionOf } from './defs';
import { SECTIONS, type AttributeDef, type Catalog, type ElementDef } from './schema';

export type XmlItemKind = 'element' | 'closeTag' | 'attribute' | 'value' | 'snippet' | 'namedValue' | 'fragment';

export interface XmlItem {
  label: string;
  kind: XmlItemKind;
  /** Snippet syntax. */
  insert: string;
  range: OffsetRange;
  detail?: string;
  documentation?: string;
  sortText?: string;
}

export interface XmlCompletionContext {
  catalog: Catalog;
  /** Fragment ids known in the workspace. */
  fragmentIds?: readonly string[];
  /** Named values known in the workspace. */
  namedValues?: readonly string[];
}

const NAME = '[A-Za-z_:][-A-Za-z0-9_:.]*';

export function xmlCompletions(doc: Document, offset: number, ctx: XmlCompletionContext): XmlItem[] | undefined {
  const src = doc.source;
  const before = src.slice(Math.max(0, offset - 300), offset);

  const nv = /\{\{([A-Za-z0-9._-]*)$/.exec(before);
  if (nv) return namedValueItems(src, offset, nv[1], ctx);

  if (doc.expressions.some((e) => offset >= e.codeRange.start && offset <= e.codeRange.end)) return undefined;
  if (inOpaqueNode(doc.children, offset)) return undefined;

  const close = new RegExp(`</(${NAME})?$`).exec(before);
  if (close) return closeTagItems(doc, offset, close[1] ?? '');

  const open = new RegExp(`<(${NAME})?$`).exec(before);
  if (open) {
    const typed = open[1] ?? '';
    return elementItems(doc, offset - typed.length - 1, { start: offset - typed.length, end: offset }, ctx.catalog, '');
  }

  const tag = startTagAt(src, doc.children, offset);
  if (tag) {
    const attr = tag.attributes.find((a) => a.valueRange && offset >= a.valueRange.start && offset <= a.valueRange.end);
    if (attr) return valueItems(doc, tag, attr, offset, ctx);
    const partial = new RegExp(`\\s(${NAME})?$`).exec(before);
    if (partial && offset > tag.nameRange.end) return attributeItems(doc, tag, offset, partial[1] ?? '', ctx.catalog);
    return undefined;
  }

  // In element text: offer expression snippets after '@'.
  if (/(^|[>\s])@$/.test(before)) {
    const path = pathAt(doc.children, offset);
    const def = resolveDef(path, ctx.catalog);
    if (def?.content.kind === 'text' && def.content.expressions) return expressionSnippets({ start: offset - 1, end: offset });
  }

  // A bare element name typed where elements go ("set-variable" without the '<').
  const bare = new RegExp(`(^|[>\\s])(${NAME})$`).exec(before);
  if (bare && acceptsElements(doc, offset - bare[2].length, ctx.catalog)) {
    const typed = bare[2];
    return elementItems(doc, offset - typed.length, { start: offset - typed.length, end: offset }, ctx.catalog, '<');
  }
  return undefined;
}

// ---- elements ---------------------------------------------------------------------------

/**
 * Element names allowed at `anchor` (the '<' being typed, or the start of a bare name). `prefix`
 * is put in front of each insertion: '' after a typed '<', '<' for a bare name.
 */
function elementItems(doc: Document, anchor: number, range: OffsetRange, catalog: Catalog, prefix: string): XmlItem[] {
  const path = pathAt(doc.children, anchor);
  const parent = path[path.length - 1];
  const inFragment = path[0]?.name === 'fragment';
  const element = (name: string, description: string, tail: string, r: OffsetRange, sortText?: string, detail?: string): XmlItem => ({
    label: name,
    kind: 'element',
    insert: `${prefix}${name}${tail}`,
    range: r,
    documentation: description,
    sortText,
    detail,
  });

  if (!parent) {
    return [
      element('policies', 'Policy document with inbound, backend, outbound and on-error sections.', '>\n\t$0\n</policies>', range),
      element('fragment', 'Policy fragment: policies to reuse with include-fragment.', '>\n\t$0\n</fragment>', range),
    ];
  }
  if (parent.name === 'policies' && path.length === 1) {
    const present = new Set(childElements(parent).filter((e) => e.range.start !== anchor).map((e) => e.name));
    return SECTIONS.filter((s) => !present.has(s)).map((s, i) =>
      element(s, `The ${s} section.`, `>\n\t<base />$0\n</${s}>`, range, String(i)),
    );
  }

  const parentDef = parent.name === 'fragment' && path.length === 1 ? undefined : (SECTIONS as readonly string[]).includes(parent.name) ? undefined : resolveDef(path, catalog);
  const content = parentDef ? parentDef.content : { kind: 'policies' as const };
  if (content.kind === 'children') {
    return content.children.map((c) => element(c.name, c.description, elementTail(c), range));
  }
  if (content.kind !== 'policies') return [];

  const section = sectionOf(path);
  const items: XmlItem[] = [];
  for (const name of catalog.names) {
    const def = catalog.get(name)!;
    if (inFragment && name === 'base') continue;
    if (section && def.sections.length > 0 && !def.sections.includes(section)) continue;
    if (content.only && !content.only.includes(name)) continue;
    if (content.exclude?.includes(name)) continue;
    items.push(element(name, def.description, elementTail(def), range, undefined, def.category));
  }
  return items;
}

/** True inside a comment, CDATA section or declaration, where nothing should be offered. */
function inOpaqueNode(nodes: Node[], offset: number): boolean {
  for (const n of nodes) {
    if (n.type === 'element') {
      if (offset > n.range.start && offset <= n.range.end && inOpaqueNode(n.children, offset)) return true;
    } else if ((n.type === 'comment' || n.type === 'cdata' || n.type === 'declaration') && offset > n.range.start && offset < n.range.end) {
      return true;
    }
  }
  return false;
}

/** Whether the content at `pos` can hold elements (rather than text, or nothing). */
function acceptsElements(doc: Document, pos: number, catalog: Catalog): boolean {
  const path = pathAt(doc.children, pos);
  const parent = path[path.length - 1];
  if (!parent || parent.name === 'policies' || parent.name === 'fragment' || (SECTIONS as readonly string[]).includes(parent.name)) return true;
  const kind = resolveDef(path, catalog)?.content.kind;
  return kind === 'policies' || kind === 'children';
}

/** Required attributes as tab stops, then the right closing for the content model. */
function elementTail(def: ElementDef): string {
  let n = 1;
  let attrs = '';
  for (const a of def.attributes ?? []) {
    if (!a.required) continue;
    attrs += ` ${a.name}="${valuePlaceholder(a, n++)}"`;
  }
  switch (def.content.kind) {
    case 'empty':
      return `${attrs} />`;
    case 'text':
      return `${attrs}>$${n}</${def.name}>`;
    default:
      return `${attrs}>\n\t$0\n</${def.name}>`;
  }
}

function valuePlaceholder(a: AttributeDef, n: number): string {
  const choices = a.enum ?? (a.type === 'bool' ? ['true', 'false'] : undefined);
  return choices ? `\${${n}|${choices.map(escapeChoice).join(',')}|}` : `$${n}`;
}

function closeTagItems(doc: Document, offset: number, typed: string): XmlItem[] {
  const lt = offset - typed.length - 2;
  const open = pathAt(doc.children, lt).filter((e) => !e.selfClosing && (!e.endTag || e.endTag.start >= lt));
  const el = open[open.length - 1];
  if (!el) return [];
  return [{ label: `/${el.name}`, kind: 'closeTag', insert: `${el.name}>`, range: { start: offset - typed.length, end: offset } }];
}

// ---- attributes -------------------------------------------------------------------------

function attributeItems(doc: Document, el: Element, offset: number, typed: string, catalog: Catalog): XmlItem[] {
  const path = [...pathAt(doc.children, el.range.start), el];
  const def = resolveDef(path, catalog);
  if (!def) return [];
  const range = { start: offset - typed.length, end: offset };
  const present = new Set(el.attributes.filter((a) => a.nameRange.end !== offset).map((a) => a.name));
  const items: XmlItem[] = [];
  for (const a of def.attributes ?? []) {
    if (present.has(a.name)) continue;
    items.push({
      label: a.name,
      kind: 'attribute',
      insert: `${a.name}="${valuePlaceholder(a, 1)}"`,
      range,
      detail: a.required ? 'required' : undefined,
      documentation: a.description,
      sortText: `${a.required ? 0 : 1}${a.name}`,
    });
  }
  if (!present.has('id')) {
    items.push({ label: 'id', kind: 'attribute', insert: 'id="$1"', range, documentation: 'Identifier reported in context.LastError.PolicyId.', sortText: '2id' });
  }
  return items;
}

function valueItems(doc: Document, el: Element, attr: Attribute, offset: number, ctx: XmlCompletionContext): XmlItem[] {
  if (attr.expression) return [];
  const path = [...pathAt(doc.children, el.range.start), el];
  const def = resolveDef(path, ctx.catalog)?.attributes?.find((a) => a.name === attr.name);
  const range = attr.valueRange!;
  const items: XmlItem[] = [];
  if (el.name === 'include-fragment' && attr.name === 'fragment-id') {
    for (const id of ctx.fragmentIds ?? []) items.push({ label: id, kind: 'fragment', insert: escapeSnippet(id), range });
  }
  const choices = def?.enum ?? (def?.type === 'bool' ? ['true', 'false'] : []);
  for (const v of choices) items.push({ label: v, kind: 'value', insert: escapeSnippet(v), range });
  const typed = doc.source.slice(range.start, offset);
  if (def?.expressions && (typed === '' || typed.startsWith('@'))) {
    items.push(...expressionSnippets(range));
  }
  return items;
}

function expressionSnippets(range: OffsetRange): XmlItem[] {
  return [
    { label: '@(…)', kind: 'snippet', insert: '@($0)', range, documentation: 'Policy expression: a single C# expression.', sortText: '~1' },
    { label: '@{…}', kind: 'snippet', insert: '@{\n\t$0\n\treturn ;\n}', range, documentation: 'Policy expression block: C# statements that return a value.', sortText: '~2' },
  ];
}

// ---- named values -----------------------------------------------------------------------

function namedValueItems(src: string, offset: number, typed: string, ctx: XmlCompletionContext): XmlItem[] {
  const closed = src.startsWith('}}', offset);
  const range = { start: offset - typed.length, end: offset };
  return (ctx.namedValues ?? []).map((name) => ({
    label: name,
    kind: 'namedValue' as const,
    insert: closed ? escapeSnippet(name) : `${escapeSnippet(name)}}}`,
    range,
    documentation: 'Named value, substituted before the policy runs.',
  }));
}

// ---- helpers ----------------------------------------------------------------------------

/** Elements whose content contains `pos`, root first. */
export function pathAt(nodes: Node[], pos: number, out: Element[] = []): Element[] {
  for (const n of nodes) {
    if (n.type !== 'element' || n.selfClosing) continue;
    const end = n.endTag ? n.endTag.start : n.range.end;
    if (pos >= n.startTag.end && pos <= end && n.startTag.end > n.nameRange.end) {
      out.push(n);
      return pathAt(n.children, pos, out);
    }
  }
  return out;
}

/** The element whose start tag contains `offset` after its name, if any. */
function startTagAt(src: string, nodes: Node[], offset: number): Element | undefined {
  for (const n of nodes) {
    if (n.type !== 'element') continue;
    const terminated = src[n.startTag.end - 1] === '>';
    if (offset >= n.nameRange.end && (offset < n.startTag.end || (!terminated && offset <= n.startTag.end))) return n;
    const end = n.endTag ? n.endTag.start : n.range.end;
    if (offset >= n.startTag.end && offset <= end) {
      const inner = startTagAt(src, n.children, offset);
      if (inner) return inner;
    }
  }
  return undefined;
}

function childElements(el: Element): Element[] {
  return el.children.filter((c): c is Element => c.type === 'element');
}

function escapeSnippet(s: string): string {
  return s.replace(/[$}\\]/g, '\\$&');
}

function escapeChoice(s: string): string {
  return s.replace(/[$}\\,|]/g, '\\$&');
}

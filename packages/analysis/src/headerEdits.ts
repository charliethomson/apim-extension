/**
 * The edits the fragment-header quick fixes and refactors make, worked out over document text and
 * offsets. The editor turns them into its own edits; snippet text uses `${1:…}` tab stops.
 */

import { Lines, type OffsetRange } from '@apim-policy/core';
import { type Document, escapeForDocument, isEscapedFormat, nodeAt } from '@apim-policy/document';
import { propertiesOfTypeText, type FragmentDoc, type FragmentVariable, type TypedefDoc } from './fragmentDoc';
import { insertTypedefs, readHeaderComment, renderHeader, tabStops, type HeaderEntry, type HeaderModel } from './headerShape';
import { emptyValueFor, type UnguardedRead } from './variableSafety';
import { typeNameFor, type GeneratedTypedefs } from './shapes';
import type { PolicySummary } from './variables';

export type TagKind = 'in' | 'out' | 'internal';

/** A stand-in for a tab stop's text, from `tabStops().stop`. */
export type Stop = (text: string, key?: string) => string;

/**
 * Where a new tag line goes in `header`: after the last tag of its kind, else after the kinds that
 * come before it (`@in`, `@out`, `@internal`), else before the ones after, else before `-->`. A
 * tag's description can run onto the lines below it; the new line goes past those.
 */
export function tagInsertion(source: string, header: FragmentDoc, kind: TagKind = 'in'): { offset: number; indent: string } {
  const lines = new Lines(source);
  const after = (v: FragmentVariable) => {
    let n = lines.lineOf(v.range.start);
    while (n + 1 < lines.count && /^\s+[^\s@-]/.test(lines.line(n + 1)) && lines.start(n + 1) < header.range.end - 3) n++;
    return lines.start(n + 1);
  };
  const indentOf = (v: FragmentVariable) => lines.indentAt(v.range.start);
  const groups = { in: header.inputs, out: header.outputs, internal: header.internals };
  const order: TagKind[] = ['in', 'out', 'internal'];
  const own = groups[kind].at(-1);
  if (own) return { offset: after(own), indent: indentOf(own) };
  const before = order.slice(0, order.indexOf(kind)).map((k) => groups[k].at(-1)).filter((v): v is FragmentVariable => !!v).at(-1);
  if (before) return { offset: after(before), indent: indentOf(before) };
  const next = order.slice(order.indexOf(kind) + 1).map((k) => groups[k][0]).find((v): v is FragmentVariable => !!v);
  if (next) return { offset: lines.start(lines.lineOf(next.range.start)), indent: indentOf(next) };
  return { offset: lines.start(lines.lineOf(header.range.end)), indent: '    ' };
}

/** A new tag line as snippet text, the cursor left where its description goes. */
export function tagLine(indent: string, kind: TagKind, name: string, type: string | undefined): string {
  const lit = (t: string) => t.replace(/[$}\\]/g, '\\$&');
  const tag = `@${kind}`.padEnd(4);
  return `${indent}${tag} ${type ? `{${lit(type)}} ` : ''}${lit(name)}  \${1:description}\n`;
}

/**
 * The whole header rewritten through its model (headerShape.ts), as snippet text for
 * `header.range`: `change` adds or edits entries, using `stop` for text that should become a tab
 * stop. Undefined when the header has something the model can't hold; callers then fall back to
 * inserting a line.
 */
export async function rewriteHeader(source: string, header: FragmentDoc, unit: string, change: (model: HeaderModel, stop: Stop) => void | Promise<void>): Promise<string | undefined> {
  const model = readHeaderComment(source.slice(header.range.start, header.range.end));
  if (!model) return undefined;
  const stops = tabStops();
  await change(model, stops.stop);
  return stops.snippet(renderHeader(model, new Lines(source).indentAt(header.range.start), unit));
}

/** A new header holding just `generated`, as snippet text to insert before the fragment. */
export function headerFor(generated: GeneratedTypedefs, unit: string): string {
  const stops = tabStops();
  const model: HeaderModel = { summary: [], entries: [] };
  namedTypedefs(model, stops.stop, generated);
  return `${stops.snippet(renderHeader(model, '', unit))}\n`;
}

/**
 * Adds generated typedefs to `model` with the root's name as a tab stop, and gives the type for a
 * tag (`Kept[]`, with the same stop).
 */
export function namedTypedefs(model: HeaderModel, stop: Stop, generated: GeneratedTypedefs): string {
  const sentinel = stop(generated.name, `typedef:${generated.name}`);
  const entries = generated.entries.map((e) => (e.kind === 'typedef' && e.name === generated.name ? { ...e, name: sentinel } : e));
  insertTypedefs(model, entries);
  return generated.type === generated.name ? sentinel : `${sentinel}[]`;
}

/** Whether a header type is an inline JSON shape (`{ … }`, `{ … }[]`) rather than a name. */
export function inlineShape(type: string): boolean {
  return /^\{|\}(\[\])?$/.test(type.trim());
}

/**
 * A typedef for an inline object type (`{ rules: UserRule[] }`, or an array of one), from the text
 * as written so the typedefs it names stay references. Undefined for text this can't split. The
 * name it takes goes into `taken`.
 */
export function typedefFromText(typeText: string, variable: string, taken: Set<string>): GeneratedTypedefs | undefined {
  const m = /^(\{[\s\S]*\})(\[\])?$/.exec(typeText.trim()) ?? /^JArray<(\{[\s\S]*\})>()$/.exec(typeText.trim());
  const array = !!m && (m[2] === '[]' || typeText.trim().startsWith('JArray<'));
  const props = m && propertiesOfTypeText(m[1]);
  if (!props?.length) return undefined;
  const base = typeNameFor(variable, array);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  taken.add(name);
  const entries: HeaderEntry[] = [
    { kind: 'typedef', name, optional: false, description: [] },
    ...props.map((p): HeaderEntry => ({ kind: 'property', name: p.name, type: p.type, optional: p.optional, description: [] })),
  ];
  return { type: array ? `${name}[]` : name, name, entries };
}

/**
 * Rewrites an old one-line `@typedef {{ … }} Name` in `model` as `@property` lines, keeping its
 * description. False when its type text can't be split, so there's nothing to offer.
 */
export function typedefAsProperties(header: FragmentDoc, legacy: TypedefDoc, model: HeaderModel): boolean {
  // From the text as written, so a typedef it uses (`rules: UserRule[]`) stays a reference.
  const props = propertiesOfTypeText(header.typedefs.get(legacy.name) ?? '');
  if (!props) return false;
  const at = model.entries.findIndex((e) => e.kind === 'typedef' && e.name === legacy.name);
  if (at < 0) return true;
  const entries: HeaderEntry[] = [
    { kind: 'typedef', name: legacy.name, optional: false, description: model.entries[at].description },
    ...props.map((p): HeaderEntry => ({ kind: 'property', name: p.name, type: p.type, optional: p.optional, description: [] })),
  ];
  model.entries.splice(at, 1, ...entries);
  return true;
}

/**
 * The `set-variable` lines that give each of `names` an empty value at the start of the fragment
 * (after its header when that's inside `<fragment>`), so every path leaves one set.
 */
export function outputsFirst(doc: Document, summary: PolicySummary, names: readonly string[], unit: string): { offset: number; text: string; count: number } | undefined {
  const root = doc.root;
  if (root?.name !== 'fragment' || !root.endTag) return undefined;
  const offset = summary.header && summary.header.range.start > root.startTag.end ? summary.header.range.end : root.startTag.end;
  const indent = new Lines(doc.source).indentAt(root.range.start) + unit;
  const types = new Map((summary.header?.outputs ?? []).map((v) => [v.name, v.type]));
  const unique = [...new Set(names)];
  const text = unique.map((n) => `\n${indent}<set-variable name="${n}" value="${emptyValueFor(types.get(n))}" />`).join('');
  return { offset, text, count: unique.length };
}

/** The `set-variable` at `offset` whose value is still empty (`""`, `@()`, `@{}`): what it sets, its value's range, its line's indent. */
export function emptySetVariable(doc: Document, offset: number): { name: string; range: OffsetRange; indent: string } | undefined {
  const element = [...nodeAt(doc, offset).path].reverse().find((e) => e.name === 'set-variable');
  const name = element?.attributes.find((a) => a.name === 'name' && !a.expression)?.value?.trim();
  const value = element?.attributes.find((a) => a.name === 'value');
  if (!element || !name || !value?.valueRange || !/^\s*(@\(\s*\)|@\{\s*\})?\s*$/.test(value.value ?? '')) return undefined;
  return { name, range: value.valueRange, indent: new Lines(doc.source).indentAt(element.range.start) };
}

/**
 * A typedef name at `offset` inside the header, used in a tag's `{type}`: the word and the
 * `@typedef` it names. Only inside a `{…}` on its line, so a description that mentions the name
 * isn't one.
 */
export function typedefReferenceAt(source: string, header: FragmentDoc, offset: number): { range: OffsetRange; typedef: TypedefDoc } | undefined {
  if (offset <= header.range.start || offset >= header.range.end) return undefined;
  const lines = new Lines(source);
  const word = lines.wordAt(offset);
  const typedef = word && header.typedefDocs.get(word.text);
  if (!word || !typedef) return undefined;
  const before = source.slice(lines.start(lines.lineOf(word.start)), word.start);
  if ((before.match(/\{/g)?.length ?? 0) <= (before.match(/\}/g)?.length ?? 0)) return undefined;
  return { range: { start: word.start, end: word.end }, typedef };
}

/** The typedef named at `offset` inside the header, wherever it's written there. */
export function typedefNameAt(source: string, header: FragmentDoc, offset: number): { range: OffsetRange; name: string } | undefined {
  if (offset <= header.range.start || offset >= header.range.end) return undefined;
  const word = new Lines(source).wordAt(offset);
  return word && header.typedefs.has(word.text) ? { range: { start: word.start, end: word.end }, name: word.text } : undefined;
}

/** The edit that rewrites an unguarded read to `GetValueOrDefault`, escaped for the document's format. */
export function guardedRead(doc: Document, read: UnguardedRead): { range: OffsetRange; text: string } | undefined {
  if (!read.fix) return undefined;
  const at = read.fix.expression.range.start;
  const inCData = doc.source.lastIndexOf('<![CDATA[', at) > doc.source.lastIndexOf(']]>', at);
  return { range: read.fix.range, text: escapeForDocument(read.fix.code, isEscapedFormat(doc), inCData) };
}

/** `ru-tmp-` for `ru-tmp-count`: the family an `@internal ru-tmp-*` pattern would cover. */
export function variableFamily(name: string): string | undefined {
  return /^(.+-)[^-]+$/.exec(name)?.[1];
}

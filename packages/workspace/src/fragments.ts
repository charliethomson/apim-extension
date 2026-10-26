/**
 * What the fragment-header features need from the workspace: what a document's includes declare,
 * where a variable is declared, and values and types built from the JSON shapes.
 */

import { type Document, escapeForDocument } from '@charliethomson/apim-document';
import { type FragmentDoc, type FragmentVariable, type HeaderModel, type IncludedFragment, type Includes, inlineShape, namedTypedefs, type PolicySummary, type Stop } from '@charliethomson/apim-analysis';
import type { PolicyIndex } from './policyIndex';
import type { ShapeService } from './shapes';

/** What `summary`'s includes declare, read once each, for the checks and the hints. */
export interface IncludedFragments<U> extends Includes {
  /** The headers, with the file each came from. */
  readonly headers: ReadonlyMap<string, { uri: U; header: FragmentDoc }>;
}

/** The fragments `summary` includes, resolved from `from` as the index resolves them. */
export async function includedFragments<U>(index: PolicyIndex<U>, from: U, summary: PolicySummary): Promise<IncludedFragments<U>> {
  const headers = new Map<string, { uri: U; header: FragmentDoc }>();
  const sets = new Map<string, string[]>();
  const internals = new Map<string, IncludedFragment>();
  for (const id of new Set(summary.includes)) {
    const f = await index.fragment(id, from);
    if (!f) continue;
    const s = f.summary;
    sets.set(id, s.header ? s.header.outputs.map((v) => v.name) : s.variables.map((v) => v.name));
    if (s.header) {
      headers.set(id, { uri: f.uri, header: s.header });
      internals.set(id, { header: s.header, sets: s.variables.map((v) => v.name) });
    }
  }
  return {
    headers,
    header: (id) => headers.get(id)?.header,
    sets: (id) => sets.get(id),
    internals: (id) => internals.get(id),
  };
}

/**
 * Where `name` is declared for a `set-variable` in the document at `uri`: an `@in` of a fragment it
 * includes, or (in a fragment) its own `@out` or `@internal`, with the header and its file.
 */
export async function declarationOf<U>(index: PolicyIndex<U>, uri: U, summary: PolicySummary, name: string): Promise<{ header: FragmentDoc; v: FragmentVariable; uri: U; own: boolean } | undefined> {
  for (const id of new Set(summary.includes)) {
    const f = await index.fragment(id, uri);
    const v = f?.summary.header?.inputs.find((x) => x.name === name);
    if (f?.summary.header && v) return { header: f.summary.header, v, uri: f.uri, own: false };
  }
  const own = summary.header;
  const v = own && [...own.outputs, ...own.internals].find((x) => x.name === name);
  return own && v ? { header: own, v, uri, own: true } : undefined;
}

export interface Layout {
  /** The indentation of the line the value goes on. */
  indent: string;
  /** One level of indentation. */
  unit: string;
  /** Whether the document writes expressions entity-escaped. */
  escaped: boolean;
}

/**
 * A `set-variable` value for `v` as `header` declares it (attribute text, escaped for the
 * document): its default, else an empty value of its type, a JSON type built out key by key.
 * `known` is false when the type couldn't be read, so the value is just empty.
 */
export async function valueFor<U>(shapes: ShapeService<U>, header: FragmentDoc, v: FragmentVariable, layout: Layout): Promise<{ value: string; known: boolean }> {
  if (v.default !== undefined) return { value: v.default.replace(/&/g, '&amp;').replace(/"/g, '&quot;'), known: true };
  const example = v.type ? await shapes.example(header, v.type, { strings: 'empty', indent: layout.indent, unit: layout.unit }) : undefined;
  if (!example) return { value: '', known: false };
  if (example.csharp === '""') return { value: '', known: true };
  return { value: `@(${escapeForDocument(example.csharp, layout.escaped, false)})`, known: true };
}

/** A `set-variable` line for input `v` of a fragment, noting when it's optional or what type it wants. */
export async function inputLine<U>(shapes: ShapeService<U>, header: FragmentDoc, v: FragmentVariable, layout: Layout): Promise<string> {
  const note = v.optional ? ` <!-- optional${v.default !== undefined ? `, default ${v.default}` : ''} -->` : '';
  const { value, known } = await valueFor(shapes, header, v, layout);
  const typeNote = v.type && !known ? ` <!-- ${v.type} -->` : '';
  return `${layout.indent}<set-variable name="${v.name}" value="${value}" />${note || typeNote}\n`;
}

/**
 * The type to write on a new tag for `variable`: when what the code builds is a JSON object (or
 * array of them) no typedef fits, a new `@typedef` with `@property` lines is added to `model` and
 * named here, its name a tab stop that follows into the tag.
 */
export async function typeForTag<U>(shapes: ShapeService<U>, doc: Document, model: HeaderModel, stop: Stop, variable: string, type: string | undefined, taken: Set<string>): Promise<string | undefined> {
  if (!type || !inlineShape(type)) return type;
  const generated = await shapes.typedefsFor(doc, variable, taken);
  return generated ? namedTypedefs(model, stop, generated) : type;
}

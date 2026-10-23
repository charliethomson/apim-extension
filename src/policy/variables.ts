/**
 * What a policy file declares and uses (fragment ids, included fragments, context variables,
 * named values), and the expression-level completion that builds on it: variable names in
 * `context.Variables["…"]` and friends, and header names in `Headers["…"]`.
 */

import type { Document, Element, Node } from '../parser/ast';
import { lex, type Token } from '../parser/csharpLexer';
import type { OffsetRange } from '../sourceMap';
import { fragmentDoc, variableReads, type FragmentDoc, type FragmentVariable, type IncludeSite, type VariableRead } from './fragmentDoc';

export interface VariableDef {
  name: string;
  /** Document range of the name's value. */
  range: OffsetRange;
  /** Element that sets it, e.g. set-variable or send-request. */
  element: string;
  /** Short preview of the assigned value (set-variable only). */
  value?: string;
}

export interface PolicySummary {
  root?: 'policies' | 'fragment';
  /** Fragment ids used by include-fragment. */
  includes: string[];
  /** Each include-fragment with a literal id, in document order. */
  includeSites: IncludeSite[];
  variables: VariableDef[];
  /** Variables read by a literal key, in document order. */
  reads: VariableRead[];
  namedValues: string[];
  /** A fragment's documented inputs and outputs (see fragmentDoc.ts). */
  header?: FragmentDoc;
}

/** One summary per parsed document: the document cache hands back the same object per version. */
const summaries = new WeakMap<Document, PolicySummary>();

export function summarize(doc: Document): PolicySummary {
  const hit = summaries.get(doc);
  if (hit) return hit;
  const out: PolicySummary = {
    root: doc.root?.name === 'policies' || doc.root?.name === 'fragment' ? doc.root.name : undefined,
    includes: [],
    includeSites: [],
    variables: [],
    reads: variableReads(doc),
    namedValues: [],
    header: fragmentDoc(doc),
  };
  const nvs = new Set<string>();
  const visit = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === 'text' || n.type === 'cdata') n.namedValues.forEach((v) => nvs.add(v.name));
      if (n.type !== 'element') continue;
      for (const a of n.attributes) a.namedValues.forEach((v) => nvs.add(v.name));
      collect(n, out);
      visit(n.children);
    }
  };
  visit(doc.children);
  out.namedValues = [...nvs];
  summaries.set(doc, out);
  return out;
}

function collect(el: Element, out: PolicySummary): void {
  const literal = (name: string) => {
    const a = el.attributes.find((x) => x.name === name);
    return a && !a.expression && a.value?.trim() ? a : undefined;
  };
  if (el.name === 'include-fragment') {
    const id = literal('fragment-id');
    if (id) {
      out.includes.push(id.value!.trim());
      out.includeSites.push({ id: id.value!.trim(), range: id.valueRange!, end: el.range.end });
    }
  }
  if (el.name === 'set-variable') {
    const name = literal('name');
    const value = el.attributes.find((a) => a.name === 'value');
    if (name) {
      out.variables.push({ name: name.value!.trim(), range: name.valueRange!, element: el.name, value: preview(value?.value) });
    }
    return;
  }
  for (const a of el.attributes) {
    if (!a.name.endsWith('variable-name') || a.expression || !a.value?.trim()) continue;
    out.variables.push({ name: a.value.trim(), range: a.valueRange!, element: el.name });
  }
}

function preview(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const one = v.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 77)}…` : one;
}

export interface KnownVariable extends VariableDef {
  /** Where it comes from, for display: undefined for this file. */
  origin?: string;
  /** The `key` of the related file that defines it; undefined for this file. */
  originKey?: string;
  /** From a fragment header's @in or @out. */
  type?: string;
  description?: string;
}

export interface RelatedFile {
  /** Opaque identifier passed back as `originKey`. */
  key?: string;
  label: string;
  fragmentIds: string[];
  summary: PolicySummary;
}

/**
 * Variables visible to a document: its own, those set by the fragments it includes and, for a
 * fragment, those set by the files that include it. The first definition of a name wins.
 */
export function knownVariables(self: PolicySummary, selfFragmentIds: readonly string[], others: readonly RelatedFile[]): KnownVariable[] {
  const out = new Map<string, KnownVariable>();
  const add = (vars: VariableDef[], origin?: string, originKey?: string, documented: readonly FragmentVariable[] = []) => {
    for (const v of vars) {
      if (out.has(v.name)) continue;
      const doc = documented.find((d) => d.name === v.name);
      out.set(v.name, { ...v, origin, originKey, type: doc?.type, description: doc?.description || undefined });
    }
  };
  /** A header's variables as definitions at their place in the header. */
  const fromHeader = (vars: readonly FragmentVariable[], element: string): VariableDef[] => vars.map((v) => ({ name: v.name, range: v.range, element }));
  // A fragment's own variables take their docs from its @out and @internal lines.
  add(self.variables, undefined, undefined, [...(self.header?.outputs ?? []), ...(self.header?.internals.filter((v) => !v.name.includes('*')) ?? [])]);
  for (const o of others) {
    if (!o.fragmentIds.some((id) => self.includes.includes(id))) continue;
    const outputs = o.summary.header?.outputs ?? [];
    add(o.summary.variables.filter((v) => !o.summary.header || outputs.some((d) => d.name === v.name)), `fragment ${o.fragmentIds[0]}`, o.key, outputs);
    add(fromHeader(outputs, '@out'), `fragment ${o.fragmentIds[0]}`, o.key, outputs);
  }
  if (self.root === 'fragment') {
    for (const o of others) {
      if (o.summary.includes.some((id) => selfFragmentIds.includes(id))) add(o.summary.variables, `set by ${o.label}`, o.key);
    }
  }
  // A fragment's own documented inputs: a caller's definition stays (it has the value) and takes
  // the header's docs; one no caller sets is offered from the header.
  for (const v of self.header?.inputs ?? []) {
    const known = out.get(v.name);
    if (known) out.set(v.name, { ...known, type: known.type ?? v.type, description: known.description ?? (v.description || undefined) });
    else add(fromHeader([v], '@in'), 'documented @in', undefined, [v]);
  }
  return [...out.values()];
}

// ---- expression-level completion ------------------------------------------------------------

export const COMMON_HEADERS = [
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Content-Length',
  'Content-Type',
  'Cookie',
  'Host',
  'If-Match',
  'If-None-Match',
  'Ocp-Apim-Subscription-Key',
  'Ocp-Apim-Trace',
  'Origin',
  'Referer',
  'User-Agent',
  'X-Forwarded-For',
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
  'X-Request-ID',
];

export type KeyKind = 'variable' | 'header';

export interface KeyAccess {
  kind: KeyKind;
  /** Code range to replace: the string's contents, or an empty range where a string should go. */
  range: OffsetRange;
  /** Whether the replacement needs its own quotes. */
  quote: boolean;
  /** The key already typed, if inside a string. */
  key?: string;
}

const LOOKUPS = new Set(['GetValueOrDefault', 'ContainsKey', 'TryGetValue']);

/**
 * Recognises a dictionary key position in an expression: `Variables["…"]`,
 * `Variables.GetValueOrDefault<T>("…")`, `Headers.ContainsKey("…")` and so on. `offset` is in
 * code coordinates.
 */
export function keyAccessAt(code: string, offset: number): KeyAccess | undefined {
  const toks = [...lex(code)].filter((t) => t.kind !== 'comment');
  // The string token holding the cursor, or the token just before an empty key position.
  let i = toks.findIndex((t) => (t.kind === 'string' || t.kind === 'char') && offset > t.start && (offset < t.end || !!t.error));
  let range: OffsetRange;
  let quote = false;
  let key: string | undefined;
  if (i >= 0) {
    const t = toks[i];
    if (code[t.start] !== '"') return undefined; // only plain strings
    const end = t.error ? t.end : t.end - 1;
    range = { start: t.start + 1, end };
    key = code.slice(range.start, range.end);
    i--; // look at what precedes the string
  } else {
    i = lastIndexBefore(toks, offset);
    if (i < 0) return undefined;
    const p = code[toks[i].start];
    if (toks[i].kind !== 'punct' || (p !== '[' && p !== '(')) return undefined;
    range = { start: offset, end: offset };
    quote = true;
  }
  const kind = receiverKind(code, toks, i);
  return kind ? { kind, range, quote, key } : undefined;
}

/** Given the index of the `[` or `(` before a key, decides which dictionary it indexes. */
function receiverKind(code: string, toks: Token[], open: number): KeyKind | undefined {
  const text = (k: number) => (k >= 0 ? code.slice(toks[k].start, toks[k].end) : '');
  if (open < 0) return undefined;
  let k = open;
  if (text(k) === '[') {
    k--;
  } else if (text(k) === '(') {
    k--;
    if (text(k) === '>') {
      // Skip generic arguments: GetValueOrDefault<T>(
      let depth = 0;
      for (; k >= 0; k--) {
        if (text(k) === '>') depth++;
        else if (text(k) === '<' && --depth === 0) break;
      }
      k--;
    }
    if (!LOOKUPS.has(text(k))) return undefined;
    k--;
    if (text(k) !== '.') return undefined;
    k--;
  } else {
    return undefined;
  }
  const recv = text(k);
  if (recv === 'Variables') return 'variable';
  if (recv === 'Headers') return 'header';
  return undefined;
}

function lastIndexBefore(toks: Token[], offset: number): number {
  let idx = -1;
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].end <= offset) idx = k;
    else break;
  }
  return idx;
}

/**
 * The standard shape of a fragment header (see docs/fragment-headers.md), and what writes it:
 *
 * ```xml
 * <!--
 *     Signs the outgoing request with an HMAC of the URL.
 *
 *     @in  {string} sig-key        The HMAC key.
 *     @in  {int}    [sig-ttl=300]  Seconds the signature holds.
 *     @in           [sig-scope]    Narrows what the signature covers.
 *
 *     @out {string} sig-header  The value for the Authorization header.
 *                               A description continues here.
 * -->
 * ```
 *
 * `<!--` and `-->` on their own lines; the summary, then the `@in` tags and the `@out` tags, each
 * group after a blank line and aligned in columns: tag, `{type}`, name, description, with continued
 * description lines under the first. A name over 32 characters overflows its column.
 * The formatter brings a header into this shape (only whitespace changes), and the drafted
 * header and the `@in`/`@out` expansions write it.
 */

import type { Document } from '@charliethomson/apim-document';
import { BALANCED, declarationOf, headerCommentOf, inputUse, readsIn } from './fragmentDoc';
import { summarize, type PolicySummary } from './variables';

export interface HeaderEntry {
  kind: 'in' | 'out' | 'internal' | 'typedef' | 'property';
  type?: string;
  name: string;
  optional: boolean;
  default?: string;
  /** One item per line. */
  description: string[];
}

export interface HeaderModel {
  /** Summary lines; '' for a paragraph break. */
  summary: string[];
  entries: HeaderEntry[];
}

const TAG = new RegExp(`^@(in|out|internal|typedef|property)\\b[ \\t]*(?:\\{(${BALANCED})\\}[ \\t]*)?(\\[)?([A-Za-z0-9_.*-]+)(?:=([^\\]\\s]*))?(\\])?[ \\t]*(.*)$`);

/**
 * A header comment's content (`<!--` to `-->`) as a model, or undefined when it holds anything
 * the standard shape can't keep: a malformed tag, or text after the tags that isn't a
 * description. The formatter leaves such a header as written.
 */
export function readHeaderComment(comment: string): HeaderModel | undefined {
  if (!comment.startsWith('<!--') || !comment.endsWith('-->')) return undefined;
  const lines = comment.slice(4, -3).split('\n').map((l) => l.trim());
  const out: HeaderModel = { summary: [], entries: [] };
  let current: HeaderEntry | undefined;
  for (const line of lines) {
    if (line === '') {
      current = undefined;
      if (!out.entries.length && out.summary.length && out.summary[out.summary.length - 1] !== '') out.summary.push('');
      continue;
    }
    if (line.startsWith('@')) {
      const m = TAG.exec(line);
      if (!m || !!m[3] !== !!m[6] || (m[1] !== 'in' && m[1] !== 'property' && m[3])) return undefined;
      current = { kind: m[1] as HeaderEntry['kind'], type: m[2]?.trim() || undefined, name: m[4], optional: !!m[3], default: m[5] || undefined, description: m[7].trim() ? [m[7].trim()] : [] };
      out.entries.push(current);
      continue;
    }
    if (current) current.description.push(line);
    else if (out.entries.length) return undefined;
    else out.summary.push(line);
  }
  while (out.summary[out.summary.length - 1] === '') out.summary.pop();
  return out.entries.length ? out : undefined;
}

/**
 * The header in the standard shape. `indent` is the comment's own indentation (for lines after
 * the first), `unit` one level of it.
 */
export function renderHeader(model: HeaderModel, indent: string, unit: string): string {
  const inner = indent + unit;
  const typeOf = (e: HeaderEntry) => (e.type ? `{${e.type}}` : '');
  const nameOf = (e: HeaderEntry) => (e.optional ? `[${e.name}${e.default !== undefined ? `=${e.default}` : ''}]` : e.name);
  const lines = ['<!--'];
  for (const s of model.summary) lines.push(s ? inner + s : '');
  // The @in run, then the @out run, each aligned on its own, with a blank line before each.
  const runs: HeaderEntry[][] = [];
  for (const e of model.entries) {
    const last = runs[runs.length - 1];
    if (last && last[0].kind === e.kind) last.push(e);
    else runs.push([e]);
  }
  for (const run of runs) {
    // A typedef's @property lines follow it directly; every other run starts after a blank line.
    if (lines.length > 1 && run[0].kind !== 'property') lines.push('');
    // @typedef lines aren't aligned with each other: `@typedef Name  description` (or the old
    // one-line form, whose types are long by nature). Elsewhere, a type far longer than the rest
    // overflows its column, like a long name.
    if (run[0].kind === 'typedef') {
      for (const e of run) {
        const [first, ...rest] = e.description;
        lines.push(`${inner}@typedef ${e.type ? `${typeOf(e)} ` : ''}${e.name}${first ? `  ${first}` : ''}`);
        for (const r of rest) lines.push(`${inner}    ${r}`);
      }
      continue;
    }
    const typeWidth = Math.max(0, ...run.map((e) => typeOf(e).length).filter((n) => n <= MAX_TYPE_COLUMN));
    // A name far longer than the rest overflows its column rather than pushing every description out.
    const names = run.map(nameOf);
    const nameWidth = Math.max(0, ...names.filter((n) => n.length <= MAX_NAME_COLUMN).map((n) => n.length));
    for (const e of run) {
      const head = `${`@${e.kind}`.padEnd(4)} ${run.some((x) => x.type) ? `${typeOf(e).padEnd(typeWidth)} ` : ''}`;
      const name = nameOf(e);
      const [first, ...rest] = e.description;
      const column = Math.max(nameWidth, name.length);
      lines.push(first ? `${inner}${head}${name.padEnd(column)}  ${first}` : `${inner}${head}${name}`);
      for (const r of rest) lines.push(`${inner}${' '.repeat(head.length + column + 2)}${r}`);
    }
  }
  lines.push(`${indent}-->`);
  return lines.join('\n');
}

/** Names longer than this don't widen the name column. */
const MAX_NAME_COLUMN = 32;
/** Types longer than this (inline object types) don't widen the type column. */
const MAX_TYPE_COLUMN = 24;

/**
 * A header drafted from a fragment: the variables it reads without setting as `@in`; what it
 * sets as `@out` when a caller reads it, else `@internal` (a shared prefix becomes one pattern,
 * `@internal ru-int-*`); types where the code shows them, with `shapeText` giving the JSON shape
 * the code builds for a variable (`{ someData: int }`).
 */
export function draftModel(
  doc: Document,
  summary: PolicySummary,
  text = 'What this fragment does.',
  shapeText: (name: string) => string | undefined = () => undefined,
  /** Variables a file that includes the fragment reads: those become @out, the rest @internal. */
  publicNames: ReadonlySet<string> = new Set(),
  /** Typedefs for the variables whose shapes need one (see shapes.ts `generateTypedefs`). */
  typedefs: ReadonlyMap<string, { type: string; entries: HeaderEntry[] }> = new Map(),
): HeaderModel {
  const types = inferredTypes(doc);
  for (const v of summary.variables) {
    const s = shapeText(v.name);
    if (s) types.sets.set(v.name, s);
  }
  const set = new Set(summary.variables.map((v) => v.name));
  const inputs = [...new Set(summary.reads.map((r) => r.name).filter((n) => !set.has(n)))];
  const codes = doc.expressions.map((e) => e.code);
  const sets = [...set];
  const outputs = sets.filter((n) => publicNames.has(n));
  const internals = sets.filter((n) => !publicNames.has(n));
  // Internals sharing a prefix (ru-int-…) become one pattern; a JSON-shaped one keeps its own line for its type.
  const prefixOf = (n: string) => /^(.+-)[^-]+$/.exec(n)?.[1];
  const counts = new Map<string, number>();
  for (const n of internals) {
    const p = prefixOf(n);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const patterns = [...counts].filter(([, c]) => c >= 3).map(([p]) => p);
  const covered = (n: string) => patterns.some((p) => n.startsWith(p));
  const shaped = (t: string | undefined) => !!t && (t.startsWith('{') || t.endsWith(']'));
  const entries: HeaderEntry[] = [
    ...inputs.map((name): HeaderEntry => {
      // Optional, typed and defaulted as the reads say: GetValueOrDefault<bool>("x", false).
      const use = inputUse(name, codes);
      return { kind: 'in', name, type: use.type ?? types.reads.get(name), optional: use.optional, default: use.default, description: [] };
    }),
    ...outputs.map((name): HeaderEntry => ({ kind: 'out', name, type: types.sets.get(name), optional: false, description: [] })),
    ...internals.filter((n) => !covered(n) || shaped(types.sets.get(n))).map((name): HeaderEntry => ({ kind: 'internal', name, type: types.sets.get(name), optional: false, description: [] })),
    ...patterns.map((p): HeaderEntry => ({ kind: 'internal', name: `${p}*`, optional: false, description: [] })),
  ];
  if (!entries.length) entries.push({ kind: 'in', name: 'variable-name', optional: false, description: ['What the caller sets before including this.'] });
  // A variable whose shape needs a typedef gets one, and its tag names it.
  const blocks: HeaderEntry[] = [];
  for (const e of entries) {
    const t = typedefs.get(e.name);
    if (t && (e.kind === 'out' || e.kind === 'internal')) {
      e.type = t.type;
      blocks.push(...t.entries);
    }
  }
  return { summary: [text], entries: [...blocks, ...entries] };
}

/**
 * Types the code shows for variables: what a read casts to or asks `GetValueOrDefault<T>` for,
 * and what a `set-variable` value obviously is (a literal is a string; a leading cast or `new`).
 */
export function inferredTypes(doc: Document): { reads: Map<string, string>; sets: Map<string, string> } {
  const reads = new Map<string, string>();
  const sets = new Map<string, string>();
  for (const e of doc.expressions) {
    for (const r of readsIn(e.code)) if (r.indexer?.cast && !reads.has(r.name)) reads.set(r.name, r.indexer.cast.type);
    for (const m of e.code.matchAll(/GetValueOrDefault\s*<\s*([\w.<>[\], ?]+?)\s*>\s*\(\s*"([A-Za-z0-9_.-]+)"/g)) if (!reads.has(m[2])) reads.set(m[2], m[1].trim());
  }
  const visit = (nodes: Document['children']) => {
    for (const n of nodes) {
      if (n.type !== 'element') continue;
      if (n.name === 'set-variable') {
        const name = n.attributes.find((a) => a.name === 'name' && !a.expression)?.value?.trim();
        const value = n.attributes.find((a) => a.name === 'value');
        if (name && value && !sets.has(name)) {
          const t = value.expression ? obviousType(value.expression.code) : 'string';
          if (t) sets.set(name, t);
        }
      }
      visit(n.children);
    }
  };
  visit(doc.children);
  return { reads, sets };
}

function obviousType(code: string): string | undefined {
  const c = code.trim();
  const cast = /^\(\s*([A-Za-z_][\w.]*(?:<[^()]*>)?\??)\s*\)\s*[\w(]/.exec(c);
  if (cast) return cast[1];
  const created = /^new\s+([A-Za-z_][\w.]*)\s*[({]/.exec(c);
  if (created) return created[1];
  if (/^(true|false)$/.test(c)) return 'bool';
  if (/^"([^"\\]|\\.)*"$/.test(c) || /^\$"/.test(c)) return 'string';
  if (/^-?\d+$/.test(c)) return 'int';
  return undefined;
}

export interface Expansion {
  label: string;
  detail: string;
  /** VS Code snippet text. */
  snippet: string;
  /** Document range the snippet replaces. */
  replace: { start: number; end: number };
  sortText: string;
}

/** Escapes text for a VS Code snippet. */
function lit(text: string): string {
  return text.replace(/[$}\\]/g, '\\$&');
}

/**
 * Abbreviations for writing a fragment header, at `offset`:
 *
 * - in an empty comment where the header goes (what typing `<!--` leaves, with its auto-closed
 *   `-->`), the whole header, drafted from the fragment, with the summary to fill in;
 * - at the start of a line in the header, `@in` and `@out` lines: first for the variables the
 *   fragment uses but doesn't document yet, with their types, then blank ones to fill in.
 *
 * `unit` is one level of indentation.
 */
export function headerExpansions(
  doc: Document,
  offset: number,
  unit: string,
  shapeText: (name: string) => string | undefined = () => undefined,
  publicNames: ReadonlySet<string> = new Set(),
  typedefs: ReadonlyMap<string, { type: string; entries: HeaderEntry[] }> = new Map(),
): Expansion[] {
  const comment = headerCommentOf(doc);
  if (!comment || offset <= comment.range.start + 3 || offset > comment.range.end - 3) return [];
  const src = doc.source;
  const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
  const indent = /^[ \t]*/.exec(src.slice(src.lastIndexOf('\n', comment.range.start - 1) + 1))![0];
  const summary = summarize(doc);
  const body = src.slice(comment.range.start + 4, comment.range.end - 3);

  if (body.trim() === '') {
    const SUMMARY = '\u0000summary\u0000';
    const draft = renderHeader(draftModel(doc, summary, SUMMARY, shapeText, publicNames, typedefs), indent, unit);
    return [
      {
        label: 'Fragment header',
        detail: 'A header drafted from what this fragment reads and sets',
        snippet: lit(draft).replace(SUMMARY, '${1:What this fragment does.}'),
        replace: { start: comment.range.start, end: comment.range.end },
        sortText: '0',
      },
    ];
  }

  // A tag goes at the start of a line: only whitespace, then what's typed of `@in`/`@out`.
  const typed = /^[ \t]*(@?[a-z]*)$/.exec(src.slice(lineStart, offset));
  if (!typed) return [];
  const replace = { start: offset - typed[1].length, end: offset };
  const header = summary.header;
  const documented = new Set([...(header?.inputs ?? []), ...(header?.outputs ?? [])].map((v) => v.name));
  const types = inferredTypes(doc);
  for (const v of summary.variables) {
    const s = shapeText(v.name);
    if (s) types.sets.set(v.name, s);
  }
  const set = new Set(summary.variables.map((v) => v.name));
  const out: Expansion[] = [];
  const placeholder = { in: 'What the caller sets.', out: 'What callers can read.', internal: 'What it holds.' };
  const line = (kind: 'in' | 'out' | 'internal', name: string, type: string | undefined) =>
    `${`@${kind}`.padEnd(4)} ${type ? `{${lit(type)}} ` : ''}${lit(name)}  \${1:${placeholder[kind]}}`;
  const codes = doc.expressions.map((e) => e.code);
  for (const name of new Set(summary.reads.map((r) => r.name))) {
    if (set.has(name) || documented.has(name)) continue;
    const use = inputUse(name, codes);
    const type = use.type ?? types.reads.get(name);
    const label = use.optional ? `[${name}${use.default !== undefined ? `=${use.default}` : ''}]` : name;
    out.push({ label: `@in ${name}`, detail: `read by this fragment${type ? ` as ${type}` : ''}${use.optional ? ', optional' : ''}, not documented`, snippet: line('in', label, type), replace, sortText: `0${name}` });
  }
  for (const name of set) {
    if (header ? declarationOf(header, name) : documented.has(name)) continue;
    const type = types.sets.get(name);
    const as = `set by this fragment${type ? ` as ${type}` : ''}, not documented`;
    out.push(
      { label: `@out ${name}`, detail: `${as}; for callers`, snippet: line('out', name, type), replace, sortText: `1${name}` },
      { label: `@internal ${name}`, detail: `${as}; private to the fragment`, snippet: line('internal', name, type), replace, sortText: `1${name}~` },
    );
  }
  out.push(
    { label: '@in', detail: 'A required input', snippet: '@in  {${1:string}} ${2:name}  ${3:What the caller sets.}', replace, sortText: '2a' },
    { label: '@in [optional]', detail: 'An optional input, with what it defaults to', snippet: '@in  {${1:string}} [${2:name}=${3:default}]  ${4:What the caller may set.}', replace, sortText: '2b' },
    { label: '@out', detail: 'An output', snippet: '@out {${1:string}} ${2:name}  ${3:What callers can read.}', replace, sortText: '2c' },
    { label: '@internal', detail: "A variable private to the fragment, by name or pattern (prefix-*)", snippet: '@internal ${1:name-or-prefix-*}  ${2:What it holds.}', replace, sortText: '2c~' },
    { label: '@typedef', detail: 'A named JSON shape, its keys as @property lines', snippet: '@typedef ${1:Name}  ${2:What it is.}\n@property {${3:string}} ${4:key}  ${5:What it holds.}', replace, sortText: '2d' },
    { label: '@property', detail: 'A key of the @typedef above: [key] if optional, a.b for a nested key', snippet: '@property {${1:string}} ${2:key}  ${3:What it holds.}', replace, sortText: '2e' },
  );
  return out;
}

// ---- editing a header ---------------------------------------------------------------------------

/** Where each kind of tag goes: typedef blocks first, then @in, @out, @internal. */
const ORDER: HeaderEntry['kind'][] = ['typedef', 'in', 'out', 'internal'];
const rank = (e: HeaderEntry) => (e.kind === 'property' ? 0 : ORDER.indexOf(e.kind));

/** Adds typedef blocks (`@typedef` + `@property` entries) after the last one already there. */
export function insertTypedefs(model: HeaderModel, entries: readonly HeaderEntry[]): void {
  let at = 0;
  model.entries.forEach((e, i) => {
    if (rank(e) === 0) at = i + 1;
  });
  model.entries.splice(at, 0, ...entries);
}

/** Adds a tag after the last of its kind, else where its kind goes among the others. */
export function insertTag(model: HeaderModel, entry: HeaderEntry): void {
  const r = rank(entry);
  let at = model.entries.length;
  for (let i = model.entries.length - 1; i >= 0; i--) {
    if (rank(model.entries[i]) <= r) {
      at = i + 1;
      break;
    }
    at = i;
  }
  model.entries.splice(at, 0, entry);
}

/**
 * Tab stops for a header rendered as a snippet: `stop(text)` gives a stand-in of the same length
 * (so columns line up) to put in an entry, and `snippet` turns the rendered text into snippet
 * text with each stand-in as a placeholder. Stand-ins of the same text share one stop, so a new
 * typedef's name and the tag using it change together.
 */
export function tabStops(): { stop: (text: string, key?: string) => string; snippet: (rendered: string) => string } {
  const stops = new Map<string, { sentinel: string; index: number; text: string }>();
  return {
    /** `key` (default: the text) decides which stand-ins are the same stop. */
    stop(text, key = text) {
      let s = stops.get(key);
      if (!s) {
        s = { sentinel: String.fromCharCode(0xe000 + stops.size).repeat(Math.max(1, text.length)), index: stops.size + 1, text };
        stops.set(key, s);
      }
      return s.sentinel;
    },
    snippet(rendered) {
      let out = rendered.replace(/[$}\\]/g, '\\$&');
      for (const s of stops.values()) out = out.split(s.sentinel).join(`\${${s.index}:${s.text.replace(/[$}\\]/g, '\\$&')}}`);
      return out;
    },
  };
}

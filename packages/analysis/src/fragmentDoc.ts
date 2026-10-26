/**
 * Fragment headers: the variables a policy fragment takes and sets, documented in the comment
 * before (or first inside) `<fragment>`, in a JSDoc-shaped format:
 *
 * ```xml
 * <!--
 *   Fetches people from randomuser.me and summarises them.
 *
 *   @in  {int}    ru-arg-results     How many users, 1..5000.
 *   @in  {string} [ru-arg-seed]      Makes the results repeatable.
 *   @in  {int}    [ru-arg-take=0]    Cap on users returned; 0 means no limit.
 *   @out {string} ru-ret-status      "ok", "empty", "invalid-args" or "upstream-error".
 *                                    A description continues on the following lines.
 *   @out {JArray} ru-ret-users       The projected users.
 * -->
 * <fragment>
 * ```
 *
 * `{type}` is optional. `[name]` is an optional input and `[name=value]` one with a default;
 * every other input is required. Text before the first tag is the fragment's summary.
 *
 * Also the checks that use it: a header that disagrees with the fragment's body, and an include
 * that doesn't set an input the fragment requires.
 */

import type { Comment, Document, Element, Node } from '@charliethomson/apim-document';
import { significantTokens, type Token } from '@charliethomson/apim-csharp-lexer';
import type { OffsetRange } from '@charliethomson/apim-core';

export interface FragmentVariable {
  /** For `@internal`, may be a pattern: `ru-int-*`, or `*` for everything undocumented. */
  name: string;
  /** Document range of the name in the header. */
  range: OffsetRange;
  type?: string;
  /** Inputs only: `[name]` or `[name=value]`. */
  optional: boolean;
  default?: string;
  description: string;
}

export interface FragmentDoc {
  summary: string;
  /**
   * `@typedef` names and the types they stand for, as type text (`{ id: string, age?: int }`):
   * built from a typedef's `@property` lines, or read from the old one-line form.
   */
  typedefs: Map<string, string>;
  /** Each `@typedef` as written: its description and `@property` lines. */
  typedefDocs: Map<string, TypedefDoc>;
  inputs: FragmentVariable[];
  outputs: FragmentVariable[];
  /** `@internal`s: the fragment's own variables, which callers shouldn't read. Names may be patterns. */
  internals: FragmentVariable[];
  /** The header comment, `<!--` to `-->`. */
  range: OffsetRange;
  /** Malformed tags, duplicates and the like. */
  problems: HeaderProblem[];
}

export interface TypedefDoc {
  name: string;
  /** Document range of the name on the `@typedef` line. */
  range: OffsetRange;
  /** The whole `@typedef` line through its last `@property` line. */
  block: OffsetRange;
  description: string;
  properties: FragmentVariable[];
  /** Written the old way, `@typedef {{ … }} Name`, with no `@property` lines. */
  legacy?: boolean;
}

/** `@property` descriptions by typedef, then by key path (`address.city`). */
export function propertyDocs(header: FragmentDoc): Map<string, Map<string, string>> {
  return new Map([...header.typedefDocs].map(([name, t]) => [name, new Map(t.properties.filter((p) => p.description).map((p) => [p.name, p.description]))]));
}

export interface HeaderProblem {
  range: OffsetRange;
  message: string;
}

/** A `{type}` that may hold object types, `{{ a: { b: int } }}`, a few levels deep. */
export const BALANCED = '(?:[^{}]|\\{(?:[^{}]|\\{(?:[^{}]|\\{[^{}]*\\})*\\})*\\})*';

/** `@in {type} [name=default] description`, after the line's leading whitespace. */
const TAG = new RegExp(`^@(in|out|internal)\\b[ \\t]*(?:\\{(${BALANCED})\\}[ \\t]*)?(\\[)?([A-Za-z0-9_.*-]+)(?:=([^\\]\\s]*))?(\\])?[ \\t]*(.*)$`, 'd');

/** The old one-line form, `@typedef {{ … }} Name description`, still read. */
const TYPEDEF = new RegExp(`^@typedef\\b[ \\t]*\\{(${BALANCED})\\}[ \\t]*([A-Za-z_][\\w]*)[ \\t]*(.*)$`);

/** `@typedef Name description`, followed by its `@property` lines. */
const TYPEDEF_BLOCK = /^@typedef\b[ \t]+([A-Za-z_]\w*)(?![\w{])[ \t]*(.*)$/d;

/** `@property {type} name description`; `[name]` is an optional key, `a.b` a key of a nested object. */
const PROPERTY = new RegExp(`^@property\\b[ \\t]*(?:\\{(${BALANCED})\\}[ \\t]*)?(\\[)?([A-Za-z_][\\w-]*(?:\\.[A-Za-z_][\\w-]*)*)(?:=([^\\]\\s]*))?(\\])?[ \\t]*(.*)$`, 'd');

/** Variable names APIM accepts in `set-variable`. */
const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * The fragment's header, or undefined when the document isn't a fragment or has no comment with
 * an `@in` or `@out` tag where a header goes.
 */
export function fragmentDoc(doc: Document): FragmentDoc | undefined {
  const root = doc.root;
  if (root?.name !== 'fragment') return undefined;
  const comment = headerComment(doc.children, root);
  if (!comment) return undefined;
  const parsed = parseHeader(doc.source, comment);
  return parsed.inputs.length || parsed.outputs.length || parsed.internals.length ? parsed : undefined;
}

/** Where a fragment's header goes, if a comment is there (tagged or not). */
export function headerCommentOf(doc: Document): Comment | undefined {
  return doc.root?.name === 'fragment' ? headerComment(doc.children, doc.root) : undefined;
}

/** The comment just before the root element, or else the first node inside it if a comment. */
function headerComment(top: Node[], root: Element): Comment | undefined {
  const at = top.indexOf(root);
  for (let i = at - 1; i >= 0; i--) {
    const n = top[i];
    if (n.type === 'comment') return n;
    if (n.type === 'text' && n.value.trim() === '') continue;
    break;
  }
  return firstMeaningful(root.children);
}

function firstMeaningful(nodes: Node[]): Comment | undefined {
  for (const n of nodes) {
    if (n.type === 'text' && n.value.trim() === '') continue;
    return n.type === 'comment' ? n : undefined;
  }
  return undefined;
}

function parseHeader(source: string, comment: Comment): FragmentDoc {
  const out: FragmentDoc = { summary: '', typedefs: new Map(), typedefDocs: new Map(), inputs: [], outputs: [], internals: [], range: comment.range, problems: [] };
  /** The @typedef whose @property lines are being read. */
  let typedef: TypedefDoc | undefined;
  const bodyStart = comment.range.start + 4; // <!--
  const body = source.slice(bodyStart, Math.max(bodyStart, comment.range.end - 3));
  const summary: string[] = [];
  let current: FragmentVariable | undefined;
  let offset = bodyStart;
  for (const raw of body.split('\n')) {
    const lineStart = offset;
    offset += raw.length + 1;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (line === '') {
      current = undefined;
      continue;
    }
    if (!line.startsWith('@')) {
      if (current) current.description = `${current.description} ${line}`.trim();
      else if (!out.inputs.length && !out.outputs.length && !out.internals.length && !out.typedefDocs.size) summary.push(line);
      continue;
    }
    current = undefined;
    const at = lineStart + indent;
    if (/^@property\b/.test(line)) {
      const p = PROPERTY.exec(line);
      if (!p) {
        out.problems.push({ range: { start: at, end: at + line.length }, message: 'Expected `@property {type} name description`.' });
        continue;
      }
      const nameStart = at + p.indices![3][0];
      const range = { start: nameStart, end: nameStart + p[3].length };
      if (!typedef) {
        out.problems.push({ range, message: 'A @property belongs under a `@typedef Name` line.' });
        continue;
      }
      if (!!p[2] !== !!p[5]) {
        out.problems.push({ range, message: `Unbalanced brackets around '${p[3]}'.` });
        continue;
      }
      if (typedef.properties.some((x) => x.name === p[3])) {
        out.problems.push({ range, message: `'${p[3]}' is already a @property of ${typedef.name}.` });
        continue;
      }
      current = { name: p[3], range, type: p[1]?.trim() || undefined, optional: !!p[2], default: p[4] || undefined, description: p[6].trim() };
      typedef.properties.push(current);
      typedef.block = { start: typedef.block.start, end: at + line.length };
      continue;
    }
    typedef = undefined;
    const legacy = TYPEDEF.exec(line);
    if (legacy) {
      const nameStart = at + line.indexOf(legacy[2], line.indexOf('}'));
      out.typedefs.set(legacy[2], legacy[1].trim());
      out.typedefDocs.set(legacy[2], { name: legacy[2], range: { start: nameStart, end: nameStart + legacy[2].length }, block: { start: at, end: at + line.length }, description: legacy[3].trim(), properties: [], legacy: true });
      continue;
    }
    const block = TYPEDEF_BLOCK.exec(line);
    if (block) {
      const nameStart = at + block.indices![1][0];
      typedef = { name: block[1], range: { start: nameStart, end: nameStart + block[1].length }, block: { start: at, end: at + line.length }, description: block[2].trim(), properties: [] };
      out.typedefDocs.set(block[1], typedef);
      continue;
    }
    if (/^@typedef\b/.test(line)) {
      out.problems.push({ range: { start: at, end: at + line.length }, message: 'Expected `@typedef Name description`, then its `@property` lines.' });
      continue;
    }
    const m = TAG.exec(line);
    if (!m) {
      if (/^@(in|out|internal)\b/.test(line)) out.problems.push({ range: { start: at, end: at + line.length }, message: 'Expected `@in`, `@out` or `@internal`, then `{type} name description`.' });
      continue;
    }
    const [, kind, type, open, name, def, close, description] = m;
    const nameStart = at + m.indices![4][0];
    const range = { start: nameStart, end: nameStart + name.length };
    if (!!open !== !!close) {
      out.problems.push({ range, message: `Unbalanced brackets around '${name}'.` });
      continue;
    }
    if (kind !== 'in' && open) {
      out.problems.push({ range, message: `Only an input can be optional; drop the brackets around '${name}'.` });
      continue;
    }
    if (kind !== 'internal' && name.includes('*')) {
      out.problems.push({ range, message: `Only @internal takes a pattern; name each @${kind} in full.` });
      continue;
    }
    const list = kind === 'in' ? out.inputs : kind === 'out' ? out.outputs : out.internals;
    if (list.some((v) => v.name === name)) {
      out.problems.push({ range, message: `'${name}' is already documented as @${kind}.` });
      continue;
    }
    current = { name, range, type: type?.trim() || undefined, optional: !!open, default: def === '' ? undefined : def, description: description.trim() };
    list.push(current);
  }
  out.summary = summary.join(' ');
  for (const t of out.typedefDocs.values()) {
    if (t.legacy) continue;
    if (!t.properties.length) out.problems.push({ range: t.range, message: `@typedef ${t.name} has no @property lines.` });
    out.typedefs.set(t.name, typeTextOf(t.properties));
  }
  return out;
}

/**
 * An object type's keys as `@property` lines would list them, from type text as written:
 * `{ match?: string, rules: UserRule[], address: { city: string } }` gives `match` (optional),
 * `rules` as `UserRule[]`, `address` as `JObject` and `address.city`. Names and types are kept as
 * written, so a typedef another one uses stays a reference. Undefined when the text isn't an object
 * type, or has a key a property name can't spell.
 */
export function propertiesOfTypeText(text: string): { name: string; type: string; optional: boolean }[] | undefined {
  const out: { name: string; type: string; optional: boolean }[] = [];
  const walk = (t: string, prefix: string): boolean => {
    const body = /^\{([\s\S]*)\}$/.exec(t.trim())?.[1];
    if (body === undefined) return false;
    for (const part of splitTopLevel(body)) {
      const m = /^([A-Za-z_][\w-]*)(\?)?\s*:\s*([\s\S]+)$/.exec(part.trim());
      if (!m) return false;
      const name = prefix + m[1];
      const type = m[3].trim();
      if (/^\{[\s\S]*\}$/.test(type)) {
        out.push({ name, type: 'JObject', optional: !!m[2] });
        if (!walk(type, `${name}.`)) return false;
      } else out.push({ name, type, optional: !!m[2] });
    }
    return true;
  };
  return walk(text, '') ? out : undefined;
}

/** `a: int, b: { c: int, d: x<y, z> }` split at the commas outside brackets and quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if ('{[<('.includes(c)) depth++;
    else if ('}]>)'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((p) => p.trim());
}

/**
 * The type text `@property` lines describe: `{ id: string, age?: int, address: { city: string } }`.
 * A dotted name (`address.city`) is a key of a nested object; a key without a type is `JToken`.
 */
function typeTextOf(properties: readonly FragmentVariable[]): string {
  interface Node {
    type?: string;
    optional: boolean;
    children: Map<string, Node>;
  }
  const root: Node = { optional: false, children: new Map() };
  for (const p of properties) {
    let node = root;
    const parts = p.name.split('.');
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { optional: false, children: new Map() };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) {
        child.type = p.type;
        child.optional = p.optional;
      }
      node = child;
    });
  }
  const render = (n: Node): string => `{ ${[...n.children].map(([k, c]) => `${/^[A-Za-z_][\w-]*$/.test(k) ? k : JSON.stringify(k)}${c.optional ? '?' : ''}: ${c.children.size ? render(c) : (c.type ?? 'JToken')}`).join(', ')} }`;
  return root.children.size ? render(root) : '{ }';
}

/** Whether `name` matches an `@internal` name or pattern (`ru-int-*`, `*`). */
export function matchesPattern(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

/** The `@internal` entry that covers `name`: a line naming it, else the first pattern matching it. */
export function internalFor(header: FragmentDoc, name: string): FragmentVariable | undefined {
  return header.internals.find((v) => v.name === name) ?? header.internals.find((v) => v.name.includes('*') && matchesPattern(v.name, name));
}

/** How a documented fragment declares `name`: `in`, `out`, `internal`, or undefined when it doesn't. */
export function declarationOf(header: FragmentDoc, name: string): 'in' | 'out' | 'internal' | undefined {
  if (header.outputs.some((v) => v.name === name)) return 'out';
  if (header.inputs.some((v) => v.name === name)) return 'in';
  return internalFor(header, name) ? 'internal' : undefined;
}

// ---- reads ------------------------------------------------------------------------------------

export interface VariableRead {
  name: string;
  /** Document range of the key inside its string. */
  range: OffsetRange;
}

const READERS = new Set(['GetValueOrDefault', 'ContainsKey', 'TryGetValue']);

/**
 * Variables an expression reads by a literal key: `context.Variables["x"]` and
 * `context.Variables.GetValueOrDefault<T>("x")`, `ContainsKey("x")`, `TryGetValue("x", …)`.
 */
export function variableReads(doc: Document): VariableRead[] {
  const out: VariableRead[] = [];
  for (const e of doc.expressions) {
    for (const r of readsIn(e.code)) {
      const range = e.map.rangeToSource(r.range);
      if (range) out.push({ name: r.name, range });
    }
  }
  return out;
}

/** A read in code offsets; for `Variables["x"]`, also what the safety lint rewrites. */
export interface CodeRead extends VariableRead {
  indexer?: {
    /** From `Variables` to the closing `]`. */
    start: number;
    end: number;
    /** A cast applied to exactly this access: `(string)context.Variables["x"]`. */
    cast?: { start: number; type: string };
  };
  /** Code offsets of `ContainsKey("x")` / `TryGetValue("x", …)` checks are reads too, flagged here. */
  guard?: boolean;
  /** For `GetValueOrDefault<T>("x", fallback)`: the `T` and the fallback's source text, when literal. */
  lookup?: { type?: string; fallback?: string };
}

/** Reads by code, in code offsets: an edit changes one expression, so the rest come from here. */
const readCache = new Map<string, CodeRead[]>();

/** Every read in `code`, in code offsets. */
export function readsIn(code: string): CodeRead[] {
  const hit = readCache.get(code);
  if (hit) return hit;
  const reads = scanReads(code);
  if (readCache.size >= 4000) readCache.delete(readCache.keys().next().value!);
  readCache.set(code, reads);
  return reads;
}

function scanReads(code: string): CodeRead[] {
  const out: CodeRead[] = [];
  // Reads inside `$"…{…}"` holes count too.
  const toks = significantTokens(code);
  const text = (k: number) => (k >= 0 && k < toks.length ? code.slice(toks[k].start, toks[k].end) : '');
  for (let i = 0; i < toks.length; i++) {
    if (text(i) !== 'Variables' || text(i - 1) !== '.') continue;
    let k = i + 1;
    let typeArg: string | undefined;
    const lookup = text(k + 1);
    if (text(k) === '.') {
      if (!READERS.has(lookup)) continue;
      k += 2;
      if (text(k) === '<') {
        const open = toks[k].end;
        let depth = 0;
        for (; k < toks.length; k++) {
          if (text(k) === '<') depth++;
          else if (text(k) === '>' && --depth === 0) break;
        }
        typeArg = code.slice(open, toks[k]?.start ?? open).trim();
        k++;
      }
      if (text(k) !== '(') continue;
    } else if (text(k) !== '[') {
      continue;
    }
    const key = toks[k + 1];
    if (!key || key.kind !== 'string' || code[key.start] !== '"' || key.error) continue;
    // The key must be the whole argument: `["a" + b]` reads something else.
    const after = text(k + 2);
    if (after !== (text(k) === '[' ? ']' : ')') && after !== ',') continue;
    const name = code.slice(key.start + 1, key.end - 1);
    if (!NAME.test(name)) continue;
    const read: CodeRead = { name, range: { start: key.start + 1, end: key.end - 1 } };
    if (text(k) === '[') {
      const close = toks[k + 2];
      read.indexer = { start: toks[i].start, end: close.end, cast: castBefore(code, toks, i, k + 3) };
    } else if (lookup !== 'GetValueOrDefault') {
      read.guard = true;
    } else {
      // A literal fallback: `GetValueOrDefault<bool>("x", false)`.
      const value = toks[k + 3];
      const literal = !!value && (['string', 'number', 'char'].includes(value.kind) || ['true', 'false'].includes(text(k + 3)));
      const fallback = text(k + 2) === ',' && literal && text(k + 4) === ')' ? text(k + 3) : undefined;
      read.lookup = { type: typeArg, fallback };
    }
    out.push(read);
  }
  return out;
}

/**
 * `(T)` directly before `context.Variables[…]` (token `variables` is `Variables`, `next` the token
 * after `]`), when it casts exactly that access rather than something after it.
 */
function castBefore(code: string, toks: Token[], variables: number, next: number): { start: number; type: string } | undefined {
  const text = (k: number) => (k >= 0 && k < toks.length ? code.slice(toks[k].start, toks[k].end) : '');
  // `(string)context.Variables["x"].Length` casts the Length.
  if (['.', '[', '(', '?.', '?'].includes(text(next))) return undefined;
  let k = variables - 1;
  // The receiver: `context.` (or any dotted chain).
  while (text(k) === '.' && /^[A-Za-z_]\w*$/.test(text(k - 1))) k -= 2;
  if (text(k) !== ')') return undefined;
  let depth = 0;
  let open = -1;
  for (let j = k; j >= 0; j--) {
    if (text(j) === ')') depth++;
    else if (text(j) === '(' && --depth === 0) {
      open = j;
      break;
    }
  }
  if (open < 0) return undefined;
  const type = code.slice(toks[open].end, toks[k].start).trim();
  // A cast's parentheses hold a type, and follow an operator or the start, not a callee.
  if (!/^[A-Za-z_][\w.]*(<[\w\s.,<>[\]]*>)?(\[\])*\??$/.test(type) || /^[A-Za-z_\])]/.test(text(open - 1))) return undefined;
  return { start: toks[open].start, type };
}

/** What a fragment's code says about an input it reads: its type, whether it's optional, its default. */
export interface InputUse {
  type?: string;
  optional: boolean;
  /** The default as header text (`false`, `10`, `https://…`), when every read agrees on a literal one. */
  default?: string;
}

/**
 * How `name` is read across `codes` (expression code): optional when no read would throw
 * (`GetValueOrDefault`, or guarded by `ContainsKey` / `TryGetValue`), typed by `<T>` or a cast
 * (not `object`), and defaulting to the literal fallback when every `GetValueOrDefault` gives
 * the same one.
 */
export function inputUse(name: string, codes: readonly string[]): InputUse {
  const reads = codes.flatMap((c) => readsIn(c)).filter((r) => r.name === name);
  const guarded = reads.some((r) => r.guard);
  const optional = guarded || !reads.some((r) => r.indexer);
  const types = reads.map((r) => r.lookup?.type ?? r.indexer?.cast?.type).filter((t): t is string => !!t && t !== 'object' && t !== 'object?');
  const fallbacks = [...new Set(reads.filter((r) => r.lookup).map((r) => r.lookup!.fallback))];
  const only = fallbacks.length === 1 ? fallbacks[0] : undefined;
  const value = only === undefined ? undefined : /^".*"$/s.test(only) ? only.slice(1, -1) : only;
  return { type: types[0]?.replace(/\?$/, ''), optional, default: optional && value !== undefined && value !== '' ? value : undefined };
}

// ---- checks -----------------------------------------------------------------------------------

export interface FragmentProblem {
  range: OffsetRange;
  message: string;
  severity: 'warning' | 'information';
  code:
    | 'fragment-header'
    | 'fragment-out-unset'
    | 'fragment-out-maybe-unset'
    | 'fragment-in-unused'
    | 'fragment-in-undocumented'
    | 'fragment-in-unset'
    | 'fragment-internal-unset'
    | 'fragment-var-undeclared'
    | 'fragment-internal-read'
    | 'fragment-internal-overwrite';
  /** For `fragment-in-undocumented`, `fragment-out-maybe-unset` and `fragment-var-undeclared`: the variable. */
  variable?: string;
  /** For `fragment-in-unset`: the required inputs nothing sets. */
  missing?: string[];
}

/**
 * A fragment's header against its body. Only fragments with a header are checked, so an
 * undocumented fragment stays quiet: an output that's never set, an input that's never read, and
 * a variable the fragment reads but neither sets nor documents as an input.
 */
export function checkFragmentHeader(header: FragmentDoc, sets: readonly { name: string; range: OffsetRange }[], reads: readonly VariableRead[]): FragmentProblem[] {
  const out: FragmentProblem[] = header.problems.map((p) => ({ ...p, severity: 'warning', code: 'fragment-header' }));
  const set = new Set(sets.map((s) => s.name));
  const read = new Set(reads.map((r) => r.name));
  const inputs = new Set(header.inputs.map((v) => v.name));
  for (const v of header.outputs) {
    if (!set.has(v.name)) out.push({ range: v.range, severity: 'warning', code: 'fragment-out-unset', message: `'${v.name}' is documented as @out, but this fragment never sets it.` });
  }
  for (const v of header.inputs) {
    if (!read.has(v.name)) out.push({ range: v.range, severity: 'warning', code: 'fragment-in-unused', message: `'${v.name}' is documented as @in, but this fragment never reads it.` });
  }
  for (const v of header.internals) {
    if (v.name.includes('*') ? !sets.some((s) => matchesPattern(v.name, s.name)) : !set.has(v.name)) {
      out.push({ range: v.range, severity: 'information', code: 'fragment-internal-unset', message: v.name.includes('*') ? `No variable this fragment sets matches '${v.name}'.` : `'${v.name}' is documented as @internal, but this fragment never sets it.` });
    }
  }
  // Every variable a documented fragment introduces is an @out, an @internal, or covered by an
  // @internal pattern: the header says which are its interface.
  const undeclared = new Set<string>();
  for (const s of sets) {
    if (undeclared.has(s.name) || declarationOf(header, s.name)) continue;
    undeclared.add(s.name);
    out.push({
      range: s.range,
      severity: 'information',
      code: 'fragment-var-undeclared',
      variable: s.name,
      message: `'${s.name}' isn't in the header. Document it as @out if callers read it, or @internal if they shouldn't.`,
    });
  }
  const reported = new Set<string>();
  for (const r of reads) {
    if (set.has(r.name) || inputs.has(r.name) || reported.has(r.name)) continue;
    reported.add(r.name);
    out.push({ range: r.range, severity: 'information', code: 'fragment-in-undocumented', variable: r.name, message: `'${r.name}' is read here but isn't set by this fragment or documented as @in.` });
  }
  return out;
}

/** What a caller needs to know about an included fragment: its header and every variable it sets. */
export interface IncludedFragment {
  header: FragmentDoc;
  sets: readonly string[];
}

/**
 * A caller depending on a fragment's internals. APIM doesn't scope variables, so a caller can
 * read what a fragment sets for itself, and a fragment's internal can overwrite the caller's
 * variable of the same name. Both are warnings:
 *
 * - reading a variable an included fragment declares `@internal` (and the caller doesn't set);
 * - including a fragment whose internal overwrites a variable the caller set before the include
 *   and reads after it.
 *
 * Undocumented fragments have no internals: everything they set is theirs to hand out.
 */
export function checkInternalUse(
  sites: readonly IncludeSite[],
  sets: readonly { name: string; range: OffsetRange }[],
  reads: readonly VariableRead[],
  fragmentOf: (id: string) => IncludedFragment | undefined,
): FragmentProblem[] {
  const out: FragmentProblem[] = [];
  const own = new Set(sets.map((s) => s.name));
  const internalOf = (f: IncludedFragment, name: string) => f.sets.includes(name) && declarationOf(f.header, name) !== 'out' && declarationOf(f.header, name) !== 'in';
  const reported = new Set<string>();
  for (const r of reads) {
    if (own.has(r.name) || reported.has(r.name)) continue;
    const site = sites.find((s) => {
      const f = fragmentOf(s.id);
      return f && internalOf(f, r.name) && !sites.some((o) => fragmentOf(o.id)?.header.outputs.some((v) => v.name === r.name));
    });
    if (!site) continue;
    reported.add(r.name);
    out.push({
      range: r.range,
      severity: 'warning',
      code: 'fragment-internal-read',
      variable: r.name,
      message: `'${r.name}' is internal to fragment '${site.id}'. Reading it depends on how the fragment works inside; ask for it as an @out instead.`,
    });
  }
  for (const site of sites) {
    const f = fragmentOf(site.id);
    if (!f) continue;
    const clobbered = [...own].filter((name) => internalOf(f, name) && sets.some((s) => s.name === name && s.range.start < site.range.start) && reads.some((r) => r.name === name && r.range.start > site.end));
    if (!clobbered.length) continue;
    const list = clobbered.map((n) => `'${n}'`).join(', ');
    out.push({
      range: site.range,
      severity: 'warning',
      code: 'fragment-internal-overwrite',
      message: `Fragment '${site.id}' sets ${list} for its own use, overwriting what this file set before the include and reads after it. Rename one of them.`,
    });
  }
  return out;
}

export interface IncludeSite {
  id: string;
  /** The fragment-id value's range. */
  range: OffsetRange;
  /** End of the include-fragment element, where hints go. */
  end: number;
}

/**
 * Required inputs an include leaves unset: nothing earlier in the file sets them (directly, or as
 * an @out of an earlier include), and, in a fragment, they aren't the fragment's own @in. Only
 * information, since a policy at an outer scope (product, global) may set them.
 */
export function checkIncludes(
  sites: readonly IncludeSite[],
  sets: readonly { name: string; range: OffsetRange }[],
  ownInputs: readonly string[],
  headerOf: (id: string) => FragmentDoc | undefined,
): FragmentProblem[] {
  const out: FragmentProblem[] = [];
  for (const site of sites) {
    const header = headerOf(site.id);
    if (!header) continue;
    const before = new Set([...ownInputs, ...sets.filter((s) => s.range.start < site.range.start).map((s) => s.name)]);
    for (const earlier of sites) {
      if (earlier.range.start >= site.range.start) break;
      for (const o of headerOf(earlier.id)?.outputs ?? []) before.add(o.name);
    }
    const missing = header.inputs.filter((v) => !v.optional && !before.has(v.name)).map((v) => v.name);
    if (missing.length) {
      const list = missing.map((n) => `'${n}'`).join(', ');
      out.push({ range: site.range, severity: 'information', code: 'fragment-in-unset', missing, message: `Fragment '${site.id}' requires ${list}, which nothing earlier in this file sets.` });
    }
  }
  return out;
}

// ---- naming variables -------------------------------------------------------------------------

export interface NamedVariableSuggestion {
  name: string;
  detail: string;
  documentation?: string;
  sortText: string;
}

/**
 * Names worth offering where a policy names a variable it sets: first the inputs of the fragments
 * it includes (required before optional, in include order), then, in a documented fragment, its
 * own outputs, then the variables already known. Each name once.
 */
export function variableNameSuggestions(
  includes: readonly { id: string; header: FragmentDoc }[],
  own: FragmentDoc | undefined,
  known: readonly { name: string; origin?: string; type?: string; description?: string }[],
): NamedVariableSuggestion[] {
  const out = new Map<string, NamedVariableSuggestion>();
  const put = (s: NamedVariableSuggestion) => {
    if (!out.has(s.name)) out.set(s.name, s);
  };
  const typed = (v: FragmentVariable) => (v.type ? `{${v.type}} ` : '');
  let order = 0;
  for (const { id, header } of includes) {
    for (const v of header.inputs) {
      const how = v.optional ? `optional${v.default !== undefined ? `, default ${v.default}` : ''}` : 'required';
      put({ name: v.name, detail: `${typed(v)}@in of ${id} (${how})`, documentation: v.description || undefined, sortText: `${v.optional ? 1 : 0}${String(order++).padStart(4, '0')}` });
    }
  }
  for (const v of own?.outputs ?? []) put({ name: v.name, detail: `${typed(v)}@out of this fragment`, documentation: v.description || undefined, sortText: `2${String(order++).padStart(4, '0')}` });
  for (const v of known) put({ name: v.name, detail: `${v.type ? `{${v.type}} ` : ''}${v.origin ?? 'set in this file'}`, documentation: v.description, sortText: `3${v.name}` });
  return [...out.values()];
}

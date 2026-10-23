/**
 * The opt-in lint for `context.Variables["x"]`, which throws `KeyNotFoundException` when `x`
 * isn't set. A read is reported unless `x` is definitely set by the time it runs:
 *
 * - an earlier `set-variable` (or `*-variable-name` attribute) sets it, in the same `<when>` or
 *   `<otherwise>` branch as the read or outside any `<choose>` (a set in a sibling branch may not
 *   have run); `cache-lookup-value` only counts with a `default-value`, since a miss sets nothing;
 * - an earlier include in such a place sets it (its `@out`s, or for an undocumented fragment
 *   everything it sets);
 * - it's a required `@in` of the fragment being read in;
 * - a broader scope (product, global) sets it, and it runs first (see scopes.ts);
 * - an enclosing `<when>` checks `ContainsKey("x")`, or the expression itself checks
 *   `ContainsKey("x")` or `TryGetValue("x", …)`.
 *
 * A `retry` evaluates its condition after running its children, so the condition sees what they
 * set. And a `<when>` whose condition is `!…ContainsKey("x")` and that sets `x` leaves `x` set
 * after its `<choose>` either way: the cache-lookup idiom.
 *
 * Each report carries a rewrite to `GetValueOrDefault<T>("x")`, keeping a cast's type.
 */

import type { Document, Element, Expression, Node } from '../parser/ast';
import type { OffsetRange } from '../sourceMap';
import { readsIn, type FragmentDoc } from './fragmentDoc';
import { namesVariable } from './completion';

export interface UnguardedRead {
  name: string;
  /** Document range of the key, where the diagnostic goes. */
  range: OffsetRange;
  /** The rewrite: replace `fix.range` (document) with `fix.code` (unescaped C#). */
  fix?: { range: OffsetRange; code: string; expression: Expression };
}

/** What an include sets: its documented @outs, or everything it sets when it's undocumented. */
export type IncludeSets = (fragmentId: string) => readonly string[] | undefined;

export function unguardedReads(
  doc: Document,
  header: FragmentDoc | undefined,
  includeSets: IncludeSets,
  /** What broader scopes set, and from where in this document (see scopes.ts). */
  outer: readonly { name: string; at: number }[] = [],
): UnguardedRead[] {
  // Set events in document order, each with the branch it's in ('' outside any choose; nested
  // branches extend their parent's path), and for each expression its branch, when it runs and the
  // checks around it.
  const sets: Set_[] = outer.map((o) => ({ name: o.name, at: o.at, branch: '' }));
  const context = new Map<Expression, { guards: Set<string>; branch: string; at: number }>();
  let branches = 0;
  const visit = (nodes: Node[], branch: string, guards: ReadonlySet<string>) => {
    for (const n of nodes) {
      if (n.type === 'text' || n.type === 'cdata') {
        if (n.expression) context.set(n.expression, { guards: new Set(guards), branch, at: n.expression.range.start });
        continue;
      }
      if (n.type !== 'element') continue;
      for (const a of n.attributes) {
        // retry runs its children, then evaluates its condition.
        const at = n.name === 'retry' && a.name === 'condition' ? n.range.end : (a.expression?.range.start ?? 0);
        if (a.expression) context.set(a.expression, { guards: new Set(guards), branch, at });
      }
      recordSets(n, branch, sets, includeSets);
      let inner = guards;
      let innerBranch = branch;
      if (n.name === 'when' || n.name === 'otherwise') {
        innerBranch = `${branch}/${++branches}`;
        const condition = n.attributes.find((a) => a.name === 'condition')?.expression;
        const checked = condition && n.name === 'when' ? checksIn(condition.code) : [];
        if (checked.length) inner = new Set([...guards, ...checked]);
      }
      visit(n.children, innerBranch, inner);
      if (n.name === 'choose') {
        for (const name of fillsIfMissing(n, sets)) sets.push({ name, at: n.range.end, branch });
      }
    }
  };
  visit(doc.children, '', new Set());
  /** A set reaches a read when it ran first, in the read's branch or one enclosing it. */
  const reaches = (s: Set_, branch: string, at: number) => s.at <= at && (branch === s.branch || branch.startsWith(`${s.branch}/`));

  const required = new Set(header?.inputs.filter((v) => !v.optional).map((v) => v.name));
  const out: UnguardedRead[] = [];
  for (const e of doc.expressions) {
    const reads = readsIn(e.code);
    const where = context.get(e) ?? { guards: new Set<string>(), branch: '', at: e.range.start };
    const checked = new Set([...where.guards, ...checksIn(e.code)]);
    for (const r of reads) {
      if (!r.indexer || required.has(r.name) || checked.has(r.name)) continue;
      if (sets.some((s) => s.name === r.name && reaches(s, where.branch, where.at))) continue;
      const range = e.map.rangeToSource(r.range);
      if (!range) continue;
      const { indexer } = r;
      const start = indexer.cast?.start ?? indexer.start;
      const receiver = indexer.cast ? e.code.slice(e.code.indexOf(')', start) + 1, indexer.start).trimStart() : '';
      const code = `${receiver}Variables.GetValueOrDefault<${indexer.cast?.type ?? 'object'}>("${r.name}")`;
      const fixRange = e.map.rangeToSource({ start, end: indexer.end });
      out.push({ name: r.name, range, fix: fixRange ? { range: fixRange, code, expression: e } : undefined });
    }
  }
  return out;
}

/**
 * Variables `code` checks for: `ContainsKey("x")`, `TryGetValue("x", …)`, and
 * `GetValueOrDefault…("x") != null`.
 */
function checksIn(code: string): string[] {
  const out = readsIn(code).filter((r) => r.guard).map((r) => r.name);
  for (const m of code.matchAll(/GetValueOrDefault\s*(?:<[^>()]*>)?\s*\(\s*"([^"]+)"\s*\)\s*!=\s*null/g)) out.push(m[1]);
  return out;
}

/** Variables a choose sets whenever they weren't already: a `<when>` on `!ContainsKey("x")` that sets `x`. */
function fillsIfMissing(choose: Element, sets: readonly Set_[]): string[] {
  const out: string[] = [];
  for (const when of choose.children) {
    if (when.type !== 'element' || when.name !== 'when') continue;
    const condition = when.attributes.find((a) => a.name === 'condition')?.expression?.code ?? '';
    for (const m of condition.matchAll(/!\s*context\s*\.\s*Variables\s*\.\s*ContainsKey\s*\(\s*"([^"]+)"\s*\)/g)) {
      if (sets.some((s) => s.name === m[1] && s.at > when.range.start && s.at <= when.range.end)) out.push(m[1]);
    }
  }
  return out;
}

interface Set_ {
  name: string;
  at: number;
  branch: string;
}

/** What an element sets, at its end (a set-variable's own value reads the old one). */
function recordSets(el: Element, branch: string, sets: Set_[], includeSets: IncludeSets): void {
  // A cache miss sets nothing unless there's a default.
  if (el.name === 'cache-lookup-value' && !el.attributes.some((a) => a.name === 'default-value')) return;
  for (const a of el.attributes) {
    if (namesVariable(el, a) && !a.expression && a.value?.trim()) sets.push({ name: a.value.trim(), at: el.range.end, branch });
  }
  if (el.name === 'include-fragment') {
    const id = el.attributes.find((a) => a.name === 'fragment-id' && !a.expression)?.value?.trim();
    for (const name of (id && includeSets(id)) || []) sets.push({ name, at: el.range.end, branch });
  }
}

// ---- outputs set on every path -----------------------------------------------------------------

/** What a run of steps sets on every path through it; `all` when every path ends (return-response). */
interface Definite {
  names: Set<string>;
  all: boolean;
}

/**
 * The `@out`s a fragment sets somewhere but not on every path through it. After the include a
 * caller reads such a variable as whatever it was before (a stale value from an earlier include,
 * or nothing, which throws), so a fragment should set each output up front and overwrite it later.
 */
export function outputsNotAlwaysSet(doc: Document, header: FragmentDoc, includeSets: IncludeSets): FragmentDoc['outputs'] {
  const root = doc.root;
  if (root?.name !== 'fragment') return [];
  const sets = new Set<string>();
  const collect = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type !== 'element') continue;
      for (const name of setsBy(n, includeSets, true)) sets.add(name);
      collect(n.children);
    }
  };
  collect(root.children);
  const definite = definitely(root.children, includeSets);
  // Never set at all is its own, separate warning (fragment-out-unset).
  return header.outputs.filter((v) => sets.has(v.name) && !definite.all && !definite.names.has(v.name));
}

function definitely(nodes: readonly Node[], includeSets: IncludeSets): Definite {
  const out: Definite = { names: new Set(), all: false };
  for (const n of nodes) {
    if (n.type !== 'element') continue;
    if (n.name === 'return-response') return { names: out.names, all: true };
    if (n.name === 'choose') {
      const branches = n.children.filter((c): c is Element => c.type === 'element' && (c.name === 'when' || c.name === 'otherwise'));
      const results = branches.map((b) => definitely(b.children, includeSets));
      // Without an otherwise, nothing may run.
      if (!branches.some((b) => b.name === 'otherwise')) results.push({ names: new Set(), all: false });
      const live = results.filter((r) => !r.all);
      if (!live.length) return { names: out.names, all: true };
      for (const name of live[0].names) if (live.every((r) => r.names.has(name))) out.names.add(name);
      continue;
    }
    for (const name of setsBy(n, includeSets, false)) out.names.add(name);
    // Other elements with steps inside (retry, wait, limit-concurrency) run them.
    if (n.children.some((c) => c.type === 'element')) {
      const inner = definitely(n.children, includeSets);
      if (inner.all) return { names: out.names, all: true };
      for (const name of inner.names) out.names.add(name);
    }
  }
  return out;
}

/** Names one element sets; a cache-lookup-value without a default only `maybe` sets its variable. */
function setsBy(el: Element, includeSets: IncludeSets, maybe: boolean): string[] {
  if (el.name === 'cache-lookup-value' && !maybe && !el.attributes.some((a) => a.name === 'default-value')) return [];
  if (el.name === 'include-fragment') {
    const id = el.attributes.find((a) => a.name === 'fragment-id' && !a.expression)?.value?.trim();
    return [...((id && includeSets(id)) || [])];
  }
  const out: string[] = [];
  for (const a of el.attributes) if (namesVariable(el, a) && !a.expression && a.value?.trim()) out.push(a.value.trim());
  return out;
}

/** A `set-variable` value that gives an output of `type` an empty start, before the steps that set it. */
export function emptyValueFor(type: string | undefined): string {
  switch (type?.replace(/\?$/, '')) {
    case 'bool':
    case 'Boolean':
      return '@(false)';
    case 'int':
    case 'long':
    case 'short':
    case 'Int32':
    case 'Int64':
      return '@(0)';
    case 'double':
      return '@(0d)';
    case 'float':
      return '@(0f)';
    case 'decimal':
      return '@(0m)';
    case 'JArray':
      return '@(new JArray())';
    case 'JObject':
      return '@(new JObject())';
    default:
      return '';
  }
}

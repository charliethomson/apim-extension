/**
 * Where a policy sits in APIM's scope hierarchy, and what the broader scopes set before it runs.
 *
 * A policy's `<base />` is where the next broader scope's same section runs: an operation's
 * inbound runs its own steps, reaches `<base />`, and there the API's inbound runs (which in turn
 * runs each product's, then the global one, at its own `<base />`). So a variable set by a broader
 * scope is set *after* the policy's `<base />` in that section, and from the start of every later
 * section (inbound, then backend, then outbound). If a policy's section has no `<base />`, the
 * broader scopes' section doesn't run at all.
 *
 * An API can belong to several products, so there's one chain per product. A variable counts as
 * set only when every chain sets it.
 */

import type { Document, Element, Node } from '../parser/ast';
import type { Scope } from '../scope';

/**
 * The broader scopes around `scope`, innermost first, one chain per product the API belongs to
 * (a single chain when it's in none). Workspaces aren't modelled yet.
 */
export function chainsFor(scope: Scope, products: readonly string[]): Scope[][] {
  const global: Scope = { kind: 'global' };
  const viaProducts = (prefix: Scope[]): Scope[][] => (products.length ? products.map((p) => [...prefix, { kind: 'product', product: p }, global]) : [[...prefix, global]]);
  switch (scope.kind) {
    case 'operation':
      return viaProducts([{ kind: 'api', api: scope.api }]);
    case 'api':
      return viaProducts([]);
    case 'product':
    case 'workspace':
      return [[global]];
    case 'global':
    case 'fragment':
      return [];
  }
}

export interface OuterSet {
  name: string;
  /** Document offset from which it's set: just after `<base />`, or a section's start. */
  at: number;
  /** The scope that sets it. */
  scope: Scope;
}

/** What an included fragment sets, by fragment id; undefined when it isn't known. */
export type IncludeSets = (fragmentId: string) => readonly string[] | undefined;

const ORDER = ['inbound', 'backend', 'outbound'] as const;
type Section = (typeof ORDER)[number];

/**
 * Variables the broader scopes set, placed in `doc` (the policy being edited): at the end of each
 * section's `<base />` for that section, and at the start of each later section for earlier ones.
 * `chains` hold each broader scope's parsed policy, innermost first (undefined when the scope has
 * none). Only top-level steps count: a set inside a `<choose>` may not run.
 */
export function outerVariables(doc: Document, chains: readonly { scope: Scope; doc: Document | undefined }[][], includeSets: IncludeSets = () => undefined): OuterSet[] {
  if (!chains.length) return [];
  const sections = new Map<Section, Element>();
  for (const s of ORDER) {
    const el = sectionOf(doc, s);
    if (el) sections.set(s, el);
  }
  const out: OuterSet[] = [];
  for (const [i, s] of ORDER.entries()) {
    const own = sections.get(s);
    if (!own) continue;
    // In this section, after <base />: what the broader scopes' same section sets.
    const base = own.children.find((n): n is Element => n.type === 'element' && n.name === 'base');
    if (base) out.push(...common(chains.map((chain) => setsInChain(chain, [s], includeSets)), base.range.end));
    // From the section's start: what the broader scopes' earlier sections set, when they ran.
    const earlier = ORDER.slice(0, i).filter((e) => ranBroader(doc, e));
    if (earlier.length) out.push(...common(chains.map((chain) => setsInChain(chain, earlier, includeSets)), own.range.start));
  }
  return out;
}

/** Whether the broader scopes' `section` ran: the policy's own section calls `<base />`. */
function ranBroader(doc: Document, section: Section): boolean {
  return !!sectionOf(doc, section)?.children.some((n) => n.type === 'element' && n.name === 'base');
}

/** Names the chain sets in `sections`, walking outward until a scope's section skips `<base />`. */
function setsInChain(chain: readonly { scope: Scope; doc: Document | undefined }[], sections: readonly Section[], includeSets: IncludeSets): Map<string, Scope> {
  const out = new Map<string, Scope>();
  for (const section of sections) {
    for (const link of chain) {
      // No policy at this scope: APIM treats it as just `<base />`.
      if (!link.doc) continue;
      const el = sectionOf(link.doc, section);
      if (!el) break;
      for (const name of topLevelSets(el.children, includeSets)) if (!out.has(name)) out.set(name, link.scope);
      if (!el.children.some((n) => n.type === 'element' && n.name === 'base')) break;
    }
  }
  return out;
}

/** Names in every chain's map, placed at `at`. */
function common(maps: readonly Map<string, Scope>[], at: number): OuterSet[] {
  const [first, ...rest] = maps;
  if (!first) return [];
  return [...first].filter(([name]) => rest.every((m) => m.has(name))).map(([name, scope]) => ({ name, at, scope }));
}

function topLevelSets(nodes: readonly Node[], includeSets: IncludeSets): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type !== 'element') continue;
    if (n.name === 'cache-lookup-value' && !n.attributes.some((a) => a.name === 'default-value')) continue;
    if (n.name === 'include-fragment') {
      const id = n.attributes.find((a) => a.name === 'fragment-id' && !a.expression)?.value?.trim();
      out.push(...((id && includeSets(id)) || []));
      continue;
    }
    for (const a of n.attributes) {
      if (a.expression || !a.value?.trim()) continue;
      if ((n.name === 'set-variable' && a.name === 'name') || a.name.endsWith('variable-name')) out.push(a.value.trim());
    }
  }
  return out;
}

function sectionOf(doc: Document, name: string): Element | undefined {
  const root = doc.root;
  if (root?.name !== 'policies') return undefined;
  return root.children.find((n): n is Element => n.type === 'element' && n.name === name);
}

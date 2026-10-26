/**
 * Reading a connected instance for the workspace layer: its fragments summarised, what its broader
 * scopes set around a policy, which scope a document is at, and which named values it lacks. The
 * editor owns the connection itself (sign-in, settings, status); this owns what's read through it.
 */

import type { Backend, Fragment, NamedValue, Product } from '@apim-policy/azure';
import { scopeFromInstancePath, scopeFromPath, type OffsetRange, type Scope } from '@apim-policy/core';
import { type Document, type Node, parse } from '@apim-policy/document';
import { type IncludeSets, type OuterSet, outerVariables, summarize } from '@apim-policy/analysis';
import { scopeChains, type ScopeReads } from './extract';
import { EDIT_SCHEME, INSTANCE_SCHEME, type RemoteFragment } from './host';

/** The reads an instance answers (`ApimInstance` in @apim-policy/azure). */
export interface InstanceReads {
  fragments(): Promise<Fragment[]>;
  namedValues(): Promise<NamedValue[]>;
  backends(): Promise<Backend[]>;
  productsOf(api: string): Promise<Product[]>;
  policy(scope: Scope): Promise<string | undefined>;
}

/** Runs a read so that it fails soft: `fallback` on error, after the editor has said why. */
export type Guard = <T>(read: Promise<T>, fallback: T) => Promise<T>;

/**
 * What the extension reads from one instance, parsed and cached. Every read goes through `guard`.
 * `invalidate` drops what was worked out from earlier reads.
 */
export class InstanceReader<U> {
  private readonly parsed = new Map<string, Document>();
  private readonly outerCache = new Map<string, { doc: Document; scope: string; value: Promise<OuterSet[]> }>();
  private summarized?: { source: Promise<unknown>; value: Promise<RemoteFragment<U>[]> };

  constructor(
    private readonly instance: InstanceReads,
    private readonly guard: Guard,
    /** The read-only document for a scope's policy on the instance. */
    readonly policyUri: (scope: Scope) => U,
  ) {}

  /** The instance's fragments, summarised once per read of the list. */
  fragments(): Promise<RemoteFragment<U>[]> {
    const source = this.instance.fragments();
    if (this.summarized?.source !== source) {
      const value = this.guard(source, []).then((list) =>
        list.map((f) => {
          const doc = this.parse(f.xml);
          return { id: f.id, description: f.description, uri: this.policyUri({ kind: 'fragment', fragment: f.id }), summary: summarize(doc), doc };
        }),
      );
      this.summarized = { source, value };
    }
    return this.summarized.value;
  }

  namedValues(): Promise<NamedValue[]> {
    return this.guard(this.instance.namedValues(), []);
  }

  backends(): Promise<Backend[]> {
    return this.guard(this.instance.backends(), []);
  }

  /**
   * What the broader scopes set before each point of `doc`, the policy `key` names at `scope` (see
   * scopes.ts in @apim-policy/analysis). Worked out once per parse and scope.
   */
  outerVariables(key: string, scope: Scope, doc: Document, includeSets: IncludeSets): Promise<OuterSet[]> {
    const hit = this.outerCache.get(key);
    const scopeKey = JSON.stringify(scope);
    if (hit && hit.doc === doc && hit.scope === scopeKey) return hit.value;
    const value = this.guard(
      scopeChains(scope, this.reads(false)).then((chains) => outerVariables(doc, chains, includeSets)),
      [],
    );
    this.outerCache.set(key, { doc, scope: scopeKey, value });
    return value;
  }

  /** The instance's scopes, each read soft: a failed read is no products, or no policy. */
  scopeReads(): ScopeReads {
    return this.reads(true);
  }

  private reads(soft: boolean): ScopeReads {
    const i = this.instance;
    const guard = <T>(p: Promise<T>, fallback: T) => (soft ? this.guard(p, fallback) : p);
    return {
      productsOf: (api) => guard(i.productsOf(api).then((list) => list.map((p) => p.id)), []),
      policy: (s) => guard(i.policy(s).then((xml) => (xml === undefined ? undefined : this.parse(xml))), undefined),
    };
  }

  /** Forgets what was worked out from earlier reads. */
  invalidate(): void {
    this.outerCache.clear();
  }

  /** The instance sends the same policies again and again; each text is parsed once. */
  private parse(xml: string): Document {
    let doc = this.parsed.get(xml);
    if (!doc) {
      if (this.parsed.size > 500) this.parsed.clear();
      doc = parse(xml);
      this.parsed.set(xml, doc);
    }
    return doc;
  }
}

/**
 * The scope a document's policy applies at: an instance document's from its path, else the one
 * the user set by hand (`manual`), else from its APIOps-shaped path. `isExtractRoot` says whether
 * a folder is an extract's root, so its policy.xml is the global policy.
 */
export function documentScope(scheme: string, path: string, manual: Scope | undefined, isExtractRoot: (dir: string) => boolean): Scope | undefined {
  if (scheme === INSTANCE_SCHEME || scheme === EDIT_SCHEME) return scopeFromInstancePath(path);
  return manual ?? scopeFromPath(path, isExtractRoot);
}

/**
 * The `{{named values}}` `doc` uses that aren't among `known`, matched as APIM does, ignoring
 * case. Undefined when nothing is known (signed out, offline), so nothing gets flagged.
 */
export function unknownNamedValues(doc: Document, known: readonly NamedValue[]): { name: string; range: OffsetRange }[] | undefined {
  if (!known.length) return undefined;
  const names = new Set(known.map((n) => n.displayName.toLowerCase()));
  return namedValueUses(doc.children).filter((nv) => !names.has(nv.name.toLowerCase()));
}

function namedValueUses(nodes: readonly Node[], out: { name: string; range: OffsetRange }[] = []) {
  for (const n of nodes) {
    if (n.type === 'text' || n.type === 'cdata') out.push(...n.namedValues);
    if (n.type !== 'element') continue;
    for (const a of n.attributes) out.push(...a.namedValues);
    namedValueUses(n.children, out);
  }
  return out;
}

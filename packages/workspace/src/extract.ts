/**
 * The broader scopes around a policy, read from wherever they live: an APIOps extract on disk, or a
 * connected instance. Both answer the same two questions (which products is an API in, and what's
 * a scope's policy), and `scopeChains` builds the chains from them.
 */

import { extractPolicyPath, type Scope } from '@apim-policy/core';
import type { Document } from '@apim-policy/document';
import { chainsFor } from '@apim-policy/analysis';

/** One broader scope and its parsed policy; undefined when it has none (APIM treats that as `<base />`). */
export interface ScopeLink {
  scope: Scope;
  doc: Document | undefined;
}

/** What building a scope's chains needs to read. */
export interface ScopeReads {
  /** The ids of the products API `api` is in. */
  productsOf(api: string): Promise<string[]>;
  /** A scope's parsed policy, or undefined when it has none. */
  policy(scope: Scope): Promise<Document | undefined>;
}

/**
 * The broader scopes around `scope` with their policies, innermost first, one chain per product its
 * API is in (`chainsFor` in @apim-policy/analysis).
 */
export async function scopeChains(scope: Scope, reads: ScopeReads): Promise<ScopeLink[][]> {
  const products = scope.kind === 'api' || scope.kind === 'operation' ? await reads.productsOf(scope.api) : [];
  return Promise.all(chainsFor(scope, products).map((chain) => Promise.all(chain.map(async (s) => ({ scope: s, doc: await reads.policy(s) })))));
}

/** The files an extract reader reads, by absolute path with forward slashes. */
export interface ExtractFiles {
  /** The parsed policy at `path`, or undefined when there's no such file. */
  policy(path: string): Promise<Document | undefined>;
  /** A file's text, or undefined when there's no such file. */
  text(path: string): Promise<string | undefined>;
  /** The names of the folders in `path`; empty when it doesn't exist. */
  folders(path: string): Promise<string[]>;
}

/**
 * An APIOps extract on disk, rooted at `root`. Which products hold which APIs is read once from
 * `products/<p>/apis.json` (until `forgetProducts`); policies are read through `files` each time,
 * so caching them is the caller's call.
 */
export class ExtractReader implements ScopeReads {
  private products?: Promise<{ all: string[]; byApi: Map<string, string[]> }>;

  constructor(
    readonly root: string,
    private readonly files: ExtractFiles,
  ) {}

  /** Where `scope`'s policy file is, or would be. */
  policyPath(scope: Scope): string {
    return `${this.root}/${extractPolicyPath(scope)}`;
  }

  policy(scope: Scope): Promise<Document | undefined> {
    return this.files.policy(this.policyPath(scope));
  }

  async productsOf(api: string): Promise<string[]> {
    return (await (this.products ??= this.readProducts())).byApi.get(api) ?? [];
  }

  /** Whether the extract has any products: without them, it says nothing about which APIs they hold. */
  async hasProducts(): Promise<boolean> {
    return (await (this.products ??= this.readProducts())).all.length > 0;
  }

  /** A product's `apis.json` changed: read them all again next time. */
  forgetProducts(): void {
    this.products = undefined;
  }

  private async readProducts(): Promise<{ all: string[]; byApi: Map<string, string[]> }> {
    const byApi = new Map<string, string[]>();
    const products = await this.files.folders(`${this.root}/products`);
    await Promise.all(
      products.sort().map(async (product) => {
        const text = await this.files.text(`${this.root}/products/${product}/apis.json`).catch(() => undefined);
        for (const api of text === undefined ? [] : productApis(text)) byApi.set(api, [...(byApi.get(api) ?? []), product]);
      }),
    );
    for (const list of byApi.values()) list.sort();
    return { all: products, byApi };
  }
}

/**
 * The API names a product's `apis.json` lists. The extractor has written both a list of names and
 * a list of `{ "name": … }` objects over its versions; anything else reads as none.
 */
export function productApis(json: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item === 'string') return [item];
    const name = item && typeof item === 'object' ? ((item as { name?: unknown }).name ?? (item as { id?: unknown }).id) : undefined;
    return typeof name === 'string' ? [name.split('/').pop() as string] : [];
  });
}

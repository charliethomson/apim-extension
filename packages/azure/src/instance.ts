/**
 * What the extension reads from a live API Management instance, loaded lazily and cached in
 * memory with a TTL. It never asks for secret values: named values come from the list call,
 * which leaves a secret's value out, and `listValue` is never called. Nothing is written to disk.
 *
 * The only writes are `pushPolicy` and `pushFragment`, which the push command calls after the
 * user has opted the instance in and confirmed a diff (see extension/src/instance/push.ts).
 */

import type { ArmClient } from './arm';
import type { Scope } from '@charliethomson/apim-core';

export interface NamedValue {
  id: string;
  /** What `{{…}}` refers to. */
  displayName: string;
  /** The value, for plain named values only. */
  value?: string;
  secret: boolean;
  /** Key Vault secret identifier, for Key Vault references. */
  keyVault?: string;
}

export interface Fragment {
  id: string;
  description?: string;
  /** The fragment's XML in the raw format. */
  xml: string;
}

export interface Backend {
  id: string;
  url?: string;
  description?: string;
}

export interface Api {
  id: string;
  displayName: string;
  path: string;
}

export interface Operation {
  id: string;
  displayName: string;
  method: string;
  urlTemplate: string;
}

export interface Product {
  id: string;
  displayName: string;
}

interface Resource<P> {
  name: string;
  properties: P;
}

/** How many requests a bulk load (every fragment's XML) has in flight. */
const CONCURRENCY = 4;

export class ApimInstance {
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    private readonly client: ArmClient,
    /** The service's resource ID. */
    readonly id: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get name(): string {
    return this.id.slice(this.id.lastIndexOf('/') + 1);
  }

  /** Drops everything cached, so the next read goes to the instance. */
  refresh(): void {
    this.cache.clear();
  }

  namedValues(): Promise<NamedValue[]> {
    return this.cached('namedValues', async () =>
      (await this.client.list<Resource<{ displayName: string; value?: string | null; secret?: boolean; keyVault?: { secretIdentifier?: string } | null }>>(`${this.id}/namedValues`)).map((r) => ({
        id: r.name,
        displayName: r.properties.displayName,
        value: r.properties.secret || r.properties.keyVault ? undefined : (r.properties.value ?? undefined),
        secret: !!r.properties.secret,
        keyVault: r.properties.keyVault?.secretIdentifier ?? undefined,
      })),
    );
  }

  fragments(): Promise<Fragment[]> {
    return this.cached('fragments', async () => {
      const list = await this.client.list<Resource<{ description?: string }>>(`${this.id}/policyFragments`);
      const out = await mapLimit(list, CONCURRENCY, async (r): Promise<Fragment | undefined> => {
        const full = await this.client.get<Resource<{ value?: string; description?: string }>>(`${this.id}/policyFragments/${encodeURIComponent(r.name)}`, { format: 'rawxml' });
        return full?.properties.value === undefined ? undefined : { id: r.name, description: full.properties.description || r.properties.description || undefined, xml: full.properties.value };
      });
      return out.filter((f): f is Fragment => !!f);
    });
  }

  backends(): Promise<Backend[]> {
    return this.cached('backends', async () =>
      (await this.client.list<Resource<{ url?: string; description?: string }>>(`${this.id}/backends`)).map((r) => ({ id: r.name, url: r.properties.url, description: r.properties.description || undefined })),
    );
  }

  /** Current revisions only. */
  apis(): Promise<Api[]> {
    return this.cached('apis', async () =>
      (await this.client.list<Resource<{ displayName: string; path?: string; isCurrent?: boolean }>>(`${this.id}/apis`))
        .filter((r) => r.properties.isCurrent !== false && !r.name.includes(';rev='))
        .map((r) => ({ id: r.name, displayName: r.properties.displayName, path: r.properties.path ?? '' })),
    );
  }

  operations(api: string): Promise<Operation[]> {
    return this.cached(`operations/${api}`, async () =>
      (await this.client.list<Resource<{ displayName: string; method: string; urlTemplate: string }>>(`${this.id}/apis/${encodeURIComponent(api)}/operations`)).map((r) => ({
        id: r.name,
        displayName: r.properties.displayName,
        method: r.properties.method,
        urlTemplate: r.properties.urlTemplate,
      })),
    );
  }

  products(): Promise<Product[]> {
    return this.cached('products', async () => (await this.client.list<Resource<{ displayName: string }>>(`${this.id}/products`)).map(product));
  }

  /** The products an API belongs to. */
  productsOf(api: string): Promise<Product[]> {
    return this.cached(`productsOf/${api}`, async () => (await this.client.list<Resource<{ displayName: string }>>(`${this.id}/apis/${encodeURIComponent(api)}/products`)).map(product));
  }

  /** A scope's policy XML (raw format), or undefined when the scope has none. */
  policy(scope: Scope): Promise<string | undefined> {
    const path = policyPath(scope);
    if (path === undefined) return Promise.resolve(undefined);
    return this.cached(`policy${path}`, async () => (await this.client.get<Resource<{ value?: string }>>(`${this.id}${path}/policies/policy`, { format: 'rawxml' }))?.properties.value);
  }

  /** A scope's policy as it is now, bypassing the cache (and refreshing it), with its ETag. */
  async livePolicy(scope: Scope, format: 'rawxml' | 'xml' = 'rawxml'): Promise<{ xml?: string; etag?: string }> {
    const path = policyPath(scope);
    if (path === undefined) throw new Error(`${scope.kind} has no policy`);
    const r = await this.client.getWithEtag<Resource<{ value?: string }>>(`${this.id}${path}/policies/policy`, { format });
    const xml = r?.body.properties.value;
    if (format === 'rawxml') this.prime(`policy${path}`, xml);
    return { xml, etag: r?.etag };
  }

  /** A fragment as it is now, with its ETag; undefined values when it doesn't exist yet. */
  async liveFragment(id: string, format: 'rawxml' | 'xml' = 'rawxml'): Promise<{ xml?: string; etag?: string; description?: string }> {
    const r = await this.client.getWithEtag<Resource<{ value?: string; description?: string }>>(`${this.id}/policyFragments/${encodeURIComponent(id)}`, { format });
    return { xml: r?.body.properties.value, etag: r?.etag, description: r?.body.properties.description || undefined };
  }

  /**
   * Replaces a scope's policy. `format` is `rawxml` for a policy written with plain quotes in its
   * expressions, `xml` for one written with `&quot;`. With `etag`, the write fails (412) if the
   * policy changed since it was read; without, if one has appeared since.
   */
  async pushPolicy(scope: Scope, value: string, format: 'rawxml' | 'xml', etag?: string): Promise<void> {
    const path = policyPath(scope);
    if (path === undefined) throw new Error(`${scope.kind} has no policy`);
    await this.client.put(`${this.id}${path}/policies/policy`, {}, { properties: { format, value } }, etag ? { ifMatch: etag } : { ifNoneMatch: '*' });
    this.cache.delete(`policy${path}`);
  }

  /** Creates or replaces a fragment, like `pushPolicy`. */
  async pushFragment(id: string, value: string, format: 'rawxml' | 'xml', description: string | undefined, etag?: string): Promise<void> {
    await this.client.put(`${this.id}/policyFragments/${encodeURIComponent(id)}`, {}, { properties: { format, value, description } }, etag ? { ifMatch: etag } : { ifNoneMatch: '*' });
    this.cache.delete('fragments');
  }

  private prime(key: string, value: unknown): void {
    this.cache.set(key, { at: this.now(), value: Promise.resolve(value) });
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: this.now(), value });
    // A failed load isn't cached: the next read tries again.
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }
}

function product(r: Resource<{ displayName: string }>): Product {
  return { id: r.name, displayName: r.properties.displayName };
}

/** The ARM path under the service for a scope's policy; empty for the global (service) policy. */
function policyPath(scope: Scope): string | undefined {
  const e = encodeURIComponent;
  switch (scope.kind) {
    case 'global':
      return '';
    case 'product':
      return `/products/${e(scope.product)}`;
    case 'api':
      return `/apis/${e(scope.api)}`;
    case 'operation':
      return `/apis/${e(scope.api)}/operations/${e(scope.operation)}`;
    case 'workspace':
      return `/workspaces/${e(scope.workspace)}`;
    case 'fragment':
      return undefined;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await f(items[i]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

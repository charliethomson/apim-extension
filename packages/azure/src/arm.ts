/**
 * A small Azure Resource Manager client: GETs with paging, PUTs with ETags and long-running
 * operations, retry on throttling, and the tenant hint ARM sends when a token is for the wrong
 * directory. No Azure SDK: the extension needs a handful of calls, and the SDK would be most of
 * the bundle.
 */

export const API_VERSION = '2024-05-01';

/** A bearer token for ARM, for `tenant` when one is known. */
export type TokenProvider = (tenant: string | undefined, signal?: AbortSignal) => Promise<string>;

export type Fetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export class ArmError extends Error {
  constructor(
    readonly status: number,
    /** ARM's error code, e.g. `ResourceNotFound` or `AuthorizationFailed`. */
    readonly code: string,
    message: string,
    /** The messages of `error.details`, where APIM puts each policy validation error. */
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ArmError';
  }
}

export interface ArmOptions {
  endpoint: string;
  token: TokenProvider;
  fetch: Fetch;
  /** Tenant to ask for tokens in; learned from ARM when unset. */
  tenant?: string;
  /** Waits between retries; tests pass one that doesn't. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const RETRIES = 3;
/** Longest Retry-After honoured, so a throttled call can't hang the editor. */
const MAX_WAIT_MS = 10_000;

export class ArmClient {
  private tenant: string | undefined;
  private readonly sleep: NonNullable<ArmOptions['sleep']>;
  /** Number of requests sent, for the log. */
  requests = 0;

  constructor(private readonly options: ArmOptions) {
    this.tenant = options.tenant;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get endpoint(): string {
    return this.options.endpoint.replace(/\/+$/, '');
  }

  /** GET `path` (an ARM resource path, or a full URL from `nextLink`); undefined on 404. */
  async get<T>(path: string, query: Record<string, string> = {}, signal?: AbortSignal): Promise<T | undefined> {
    return (await this.getWithEtag<T>(path, query, signal))?.body;
  }

  /** GET, with the resource's ETag for a later conditional PUT. */
  async getWithEtag<T>(path: string, query: Record<string, string> = {}, signal?: AbortSignal): Promise<{ body: T; etag?: string } | undefined> {
    const res = await this.send('GET', this.resolve(path, query), undefined, {}, signal);
    if (res.status === 404) return undefined;
    return { body: res.body as T, etag: res.headers.get('etag') ?? undefined };
  }

  /**
   * PUT `body` to `path`. With `ifMatch`, ARM refuses the write (412) when the resource changed
   * since that ETag was read; with `ifNoneMatch: '*'`, when it has been created in the meantime.
   * Waits for a long-running operation to finish.
   */
  async put<T>(path: string, query: Record<string, string>, body: unknown, options: { ifMatch?: string; ifNoneMatch?: string; signal?: AbortSignal } = {}): Promise<T | undefined> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.ifMatch) headers['if-match'] = options.ifMatch;
    if (options.ifNoneMatch) headers['if-none-match'] = options.ifNoneMatch;
    const res = await this.send('PUT', this.resolve(path, query), JSON.stringify(body), headers, options.signal);
    if (res.status === 202 || (res.status === 201 && res.headers.get('azure-asyncoperation'))) return this.await<T>(res.headers, options.signal);
    return res.body as T;
  }

  /** Polls a long-running operation until it succeeds (returning nothing useful) or fails. */
  private async await<T>(headers: { get(name: string): string | null }, signal?: AbortSignal): Promise<T | undefined> {
    const op = headers.get('azure-asyncoperation');
    const location = headers.get('location');
    let delay = retryDelay(headers.get('retry-after'), 0);
    for (let i = 0; i < 60; i++) {
      await this.sleep(delay, signal);
      if (op) {
        const r = await this.send('GET', op, undefined, {}, signal);
        const status = (r.body as { status?: string } | undefined)?.status;
        if (status === 'Succeeded') return undefined;
        if (status === 'Failed' || status === 'Canceled') throw armError(400, JSON.stringify(r.body ?? {}));
        delay = retryDelay(r.headers.get('retry-after'), 1);
      } else if (location) {
        const r = await this.send('GET', location, undefined, {}, signal);
        if (r.status !== 202) return r.body as T;
        delay = retryDelay(r.headers.get('retry-after'), 1);
      } else {
        return undefined;
      }
    }
    throw new ArmError(408, 'Timeout', 'The operation was still running after a minute.');
  }

  private resolve(path: string, query: Record<string, string>): string {
    return path.startsWith('https://') ? path : this.url(path, query);
  }

  /** One request, with tenant switching and retries; throws an ArmError for any failure but 404. */
  private async send(method: 'GET' | 'PUT', url: string, body: string | undefined, extra: Record<string, string>, signal?: AbortSignal) {
    let tenantRetried = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.options.token(this.tenant, signal);
      this.requests++;
      const res = await this.options.fetch(url, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...extra }, body, signal });
      const text = await res.text();
      if (res.status === 404 && method === 'GET') return { status: 404, headers: res.headers, body: undefined };
      if (res.status >= 200 && res.status < 300) return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as unknown) : undefined };
      // A token from the wrong directory: ARM names the right one in WWW-Authenticate.
      if (res.status === 401 && !tenantRetried) {
        const tenant = tenantFromChallenge(res.headers.get('www-authenticate'));
        if (tenant && tenant !== this.tenant) {
          this.tenant = tenant;
          tenantRetried = true;
          attempt--;
          continue;
        }
      }
      // Throttling is safe to retry for anything; a server error only for a read.
      const retry = res.status === 429 || (res.status >= 500 && method === 'GET');
      if (retry && attempt < RETRIES) {
        await this.sleep(retryDelay(res.headers.get('retry-after'), attempt), signal);
        continue;
      }
      throw armError(res.status, text);
    }
  }

  /** Every item of a paged list, following `nextLink`. */
  async list<T>(path: string, query: Record<string, string> = {}, signal?: AbortSignal): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = this.url(path, query);
    while (next) {
      const page: { value?: T[]; nextLink?: string } | undefined = await this.get(next, {}, signal);
      if (!page) break;
      out.push(...(page.value ?? []));
      next = page.nextLink;
    }
    return out;
  }

  /** The tenant tokens are requested for, once known. */
  get currentTenant(): string | undefined {
    return this.tenant;
  }

  private url(path: string, query: Record<string, string>): string {
    const params = new URLSearchParams({ 'api-version': API_VERSION, ...query });
    return `${this.endpoint}${path.startsWith('/') ? '' : '/'}${path}?${params.toString()}`;
  }
}

/** `Bearer authorization_uri="https://login.microsoftonline.com/<tenant>", …` → `<tenant>`. */
export function tenantFromChallenge(header: string | null): string | undefined {
  const m = header && /authorization_uri="https:\/\/[^/"]+\/([^/"]+)"/i.exec(header);
  return m ? m[1] : undefined;
}

function retryDelay(header: string | null, attempt: number): number {
  const seconds = header ? Number(header) : NaN;
  const ms = Number.isFinite(seconds) ? seconds * 1000 : 500 * 2 ** attempt;
  return Math.min(ms, MAX_WAIT_MS);
}

function armError(status: number, body: string): ArmError {
  try {
    const e = (JSON.parse(body) as { error?: { code?: string; message?: string; details?: { message?: string }[] } }).error;
    if (e) {
      const details = (e.details ?? []).map((d) => d.message ?? '').filter(Boolean);
      return new ArmError(status, e.code ?? String(status), e.message ?? `HTTP ${status}`, details);
    }
  } catch {
    // not JSON
  }
  return new ArmError(status, String(status), `HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason as Error);
    });
  });
}

/** `/subscriptions/<s>/resourceGroups/<g>/providers/Microsoft.ApiManagement/service/<name>`, normalised. */
export function parseServiceId(id: string): { subscription: string; resourceGroup: string; name: string; id: string } | undefined {
  const m = /^\/?subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ApiManagement\/service\/([^/]+)\/?$/i.exec(id.trim());
  if (!m) return undefined;
  return { subscription: m[1], resourceGroup: m[2], name: m[3], id: `/subscriptions/${m[1]}/resourceGroups/${m[2]}/providers/Microsoft.ApiManagement/service/${m[3]}` };
}

/** What to tell the user about a failed read; a 403 says which role reading policies needs. */
export function describeError(e: unknown): string {
  if (e instanceof ArmError) {
    if (e.status === 403) return `${e.message} (reading policies needs the API Management Service Reader role)`;
    return e.message;
  }
  return (e as Error).message ?? String(e);
}

/** Whether `id` is on `allowed`, a list of resource IDs as the user wrote them (any case, any slashes). */
export function isAllowedInstance(allowed: readonly string[], id: string): boolean {
  const want = id.toLowerCase();
  return allowed.some((a) => (parseServiceId(a)?.id ?? a).toLowerCase() === want);
}

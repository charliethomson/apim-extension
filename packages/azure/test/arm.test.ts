import { describe, expect, it } from 'vitest';
import { ArmClient, ArmError, describeError, isAllowedInstance, parseServiceId, tenantFromChallenge, type Fetch } from '../src/arm';
import { ApimInstance } from '../src/instance';

const SVC = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.ApiManagement/service/apim1';

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fake ARM: replies by path (without the query), in order when a path has several. */
function fakeArm(routes: Record<string, Reply | Reply[]>) {
  const calls: { url: string; auth: string; method: string; body?: string; headers: Record<string, string> }[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const fetch: Fetch = (url, init) => {
    calls.push({ url, auth: init.headers.authorization, method: init.method ?? 'GET', body: init.body, headers: init.headers });
    const u = new URL(url);
    const key = (init.method === 'PUT' ? 'PUT ' : '') + u.pathname + (u.searchParams.get('format') ? `?format=${u.searchParams.get('format')}` : '') + (u.searchParams.get('page') ? `?page=${u.searchParams.get('page')}` : '');
    const q = queues.get(key);
    const r = (q && q.length > 1 ? q.shift() : q?.[0]) ?? { status: 404, body: { error: { code: 'NotFound', message: 'nope' } } };
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return Promise.resolve({
      status: r.status ?? 200,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: () => Promise.resolve(r.body === undefined ? '' : JSON.stringify(r.body)),
    });
  };
  const tokens: (string | undefined)[] = [];
  const client = new ArmClient({
    endpoint: 'https://management.azure.com/',
    fetch,
    token: (tenant) => {
      tokens.push(tenant);
      return Promise.resolve(`token-${tenant ?? 'home'}`);
    },
    sleep: () => Promise.resolve(),
  });
  return { client, calls, tokens };
}

describe('ArmClient', () => {
  it('sends the token and api-version, and returns undefined for a 404', async () => {
    const { client, calls } = fakeArm({ [`${SVC}/policies/policy`]: { body: { properties: { value: '<policies />' } } } });
    expect(await client.get(`${SVC}/policies/policy`)).toEqual({ properties: { value: '<policies />' } });
    expect(calls[0].url).toBe(`https://management.azure.com${SVC}/policies/policy?api-version=2024-05-01`);
    expect(calls[0].auth).toBe('Bearer token-home');
    expect(await client.get(`${SVC}/nope`)).toBeUndefined();
  });

  it('follows nextLink through every page', async () => {
    const { client } = fakeArm({
      [`${SVC}/apis`]: { body: { value: [{ name: 'a' }], nextLink: `https://management.azure.com${SVC}/apis?page=2` } },
      [`${SVC}/apis?page=2`]: { body: { value: [{ name: 'b' }] } },
    });
    expect((await client.list<{ name: string }>(`${SVC}/apis`)).map((x) => x.name)).toEqual(['a', 'b']);
  });

  it('retries throttling and server errors, then gives up with the ARM error', async () => {
    const { client, calls } = fakeArm({ [`${SVC}/x`]: [{ status: 429, headers: { 'retry-after': '1' } }, { status: 503 }, { body: { ok: true } }] });
    expect(await client.get(`${SVC}/x`)).toEqual({ ok: true });
    expect(calls).toHaveLength(3);

    const failing = fakeArm({ [`${SVC}/x`]: { status: 500, body: { error: { code: 'InternalError', message: 'boom' } } } });
    await expect(failing.client.get(`${SVC}/x`)).rejects.toMatchObject({ status: 500, code: 'InternalError', message: 'boom' });
    expect(failing.calls).toHaveLength(4);
  });

  it("doesn't retry other errors", async () => {
    const { client, calls } = fakeArm({ [`${SVC}/x`]: { status: 403, body: { error: { code: 'AuthorizationFailed', message: 'no' } } } });
    await expect(client.get(`${SVC}/x`)).rejects.toBeInstanceOf(ArmError);
    expect(calls).toHaveLength(1);
  });

  it('switches tenant when ARM says the token is for the wrong directory', async () => {
    const { client, tokens } = fakeArm({
      [`${SVC}/x`]: [{ status: 401, headers: { 'www-authenticate': 'Bearer authorization_uri="https://login.microsoftonline.com/t-2", error="invalid_token"' } }, { body: { ok: 1 } }],
    });
    expect(await client.get(`${SVC}/x`)).toEqual({ ok: 1 });
    expect(tokens).toEqual([undefined, 't-2']);
    expect(client.currentTenant).toBe('t-2');
  });

  it('reads tenants from challenges and service ids from strings', () => {
    expect(tenantFromChallenge('Bearer authorization_uri="https://login.windows.net/abc", error="x"')).toBe('abc');
    expect(tenantFromChallenge(null)).toBeUndefined();
    expect(parseServiceId(` ${SVC.slice(1)}/ `)).toEqual({ subscription: 's1', resourceGroup: 'rg', name: 'apim1', id: SVC });
    expect(parseServiceId('/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Web/sites/x')).toBeUndefined();
  });
});

describe('ApimInstance', () => {
  const routes = {
    [`${SVC}/namedValues`]: {
      body: {
        value: [
          { name: 'nv1', properties: { displayName: 'backend-url', value: 'https://x', secret: false } },
          { name: 'nv2', properties: { displayName: 'api-key', value: null, secret: true } },
          { name: 'nv3', properties: { displayName: 'kv', secret: true, keyVault: { secretIdentifier: 'https://v.vault.azure.net/secrets/s' } } },
        ],
      },
    },
    [`${SVC}/policyFragments`]: { body: { value: [{ name: 'f1', properties: { description: 'one' } }, { name: 'gone', properties: {} }] } },
    [`${SVC}/policyFragments/f1?format=rawxml`]: { body: { properties: { value: '<fragment />', description: '' } } },
    [`${SVC}/apis`]: {
      body: {
        value: [
          { name: 'echo', properties: { displayName: 'Echo', path: 'echo', isCurrent: true } },
          { name: 'echo;rev=2', properties: { displayName: 'Echo', path: 'echo', isCurrent: false } },
        ],
      },
    },
    [`${SVC}/apis/echo/products`]: { body: { value: [{ name: 'starter', properties: { displayName: 'Starter' } }] } },
    [`${SVC}/apis/echo/operations`]: { body: { value: [{ name: 'get', properties: { displayName: 'Get', method: 'GET', urlTemplate: '/' } }] } },
    [`${SVC}/products`]: { body: { value: [{ name: 'starter', properties: { displayName: 'Starter' } }] } },
    [`${SVC}/backends`]: { body: { value: [{ name: 'b1', properties: { url: 'https://b', description: '' } }] } },
    [`${SVC}/policies/policy?format=rawxml`]: { body: { properties: { value: '<policies>global</policies>' } } },
    [`${SVC}/apis/echo/operations/get/policies/policy?format=rawxml`]: { body: { properties: { value: '<policies>op</policies>' } } },
  };

  it('reads named values without secret values, fragments as raw XML, current API revisions, and the rest', async () => {
    const { client } = fakeArm(routes);
    const i = new ApimInstance(client, SVC, 60_000);
    expect(i.name).toBe('apim1');
    expect(await i.namedValues()).toEqual([
      { id: 'nv1', displayName: 'backend-url', value: 'https://x', secret: false, keyVault: undefined },
      { id: 'nv2', displayName: 'api-key', value: undefined, secret: true, keyVault: undefined },
      { id: 'nv3', displayName: 'kv', value: undefined, secret: true, keyVault: 'https://v.vault.azure.net/secrets/s' },
    ]);
    expect(await i.fragments()).toEqual([{ id: 'f1', description: 'one', xml: '<fragment />' }]);
    expect(await i.apis()).toEqual([{ id: 'echo', displayName: 'Echo', path: 'echo' }]);
    expect(await i.productsOf('echo')).toEqual([{ id: 'starter', displayName: 'Starter' }]);
    expect(await i.products()).toEqual([{ id: 'starter', displayName: 'Starter' }]);
    expect(await i.operations('echo')).toEqual([{ id: 'get', displayName: 'Get', method: 'GET', urlTemplate: '/' }]);
    expect(await i.backends()).toEqual([{ id: 'b1', url: 'https://b', description: undefined }]);
    expect(await i.policy({ kind: 'global' })).toBe('<policies>global</policies>');
    expect(await i.policy({ kind: 'operation', api: 'echo', operation: 'get' })).toBe('<policies>op</policies>');
    expect(await i.policy({ kind: 'product', product: 'starter' })).toBeUndefined();
    expect(await i.policy({ kind: 'fragment', fragment: 'f1' })).toBeUndefined();
  });

  it('never asks for a secret value', async () => {
    const { client, calls } = fakeArm(routes);
    const i = new ApimInstance(client, SVC, 60_000);
    await Promise.all([i.namedValues(), i.fragments(), i.apis(), i.backends(), i.policy({ kind: 'global' })]);
    expect(calls.some((c) => /listValue|listSecrets/i.test(c.url))).toBe(false);
  });

  it('caches reads until the TTL or a refresh, and retries a failed read next time', async () => {
    let now = 0;
    const { client, calls } = fakeArm({ ...routes, [`${SVC}/backends`]: [{ status: 403, body: { error: { code: 'AuthorizationFailed', message: 'no' } } }, routes[`${SVC}/backends`]] });
    const i = new ApimInstance(client, SVC, 1000, () => now);
    await i.namedValues();
    await i.namedValues();
    expect(calls).toHaveLength(1);
    now = 1500;
    await i.namedValues();
    expect(calls).toHaveLength(2);
    i.refresh();
    await i.namedValues();
    expect(calls).toHaveLength(3);

    await expect(i.backends()).rejects.toBeInstanceOf(ArmError);
    expect(await i.backends()).toHaveLength(1);
  });
});

describe('writing', () => {
  it('PUTs JSON with If-Match, and returns the body', async () => {
    const { client, calls } = fakeArm({ [`PUT ${SVC}/x`]: { body: { ok: 1 } } });
    expect(await client.put(`${SVC}/x`, {}, { a: 1 }, { ifMatch: '"e1"' })).toEqual({ ok: 1 });
    expect(calls[0]).toMatchObject({ method: 'PUT', body: '{"a":1}', headers: { 'if-match': '"e1"', 'content-type': 'application/json' } });
  });

  it('waits for a long-running operation, through Azure-AsyncOperation or Location', async () => {
    const op = `https://management.azure.com${SVC}/operations/1`;
    const viaOp = fakeArm({
      [`PUT ${SVC}/x`]: { status: 202, headers: { 'azure-asyncoperation': op } },
      [`${SVC}/operations/1`]: [{ body: { status: 'InProgress' } }, { body: { status: 'Succeeded' } }],
    });
    await viaOp.client.put(`${SVC}/x`, {}, {});
    expect(viaOp.calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'GET']);

    const failed = fakeArm({
      [`PUT ${SVC}/x`]: { status: 202, headers: { 'azure-asyncoperation': op } },
      [`${SVC}/operations/1`]: { body: { status: 'Failed', error: { code: 'ValidationError', message: 'bad', details: [{ message: 'Error in element x on line 2, column 3: no' }] } } },
    });
    await expect(failed.client.put(`${SVC}/x`, {}, {})).rejects.toMatchObject({ code: 'ValidationError', details: ['Error in element x on line 2, column 3: no'] });

    const viaLocation = fakeArm({
      [`PUT ${SVC}/x`]: { status: 202, headers: { location: `https://management.azure.com${SVC}/loc` } },
      [`${SVC}/loc`]: [{ status: 202 }, { body: { done: true } }],
    });
    expect(await viaLocation.client.put(`${SVC}/x`, {}, {})).toEqual({ done: true });
  });

  it("doesn't retry a write after a server error, and keeps APIM's validation details", async () => {
    const { client, calls } = fakeArm({ [`PUT ${SVC}/x`]: { status: 500 } });
    await expect(client.put(`${SVC}/x`, {}, {})).rejects.toBeInstanceOf(ArmError);
    expect(calls).toHaveLength(1);
    const invalid = fakeArm({ [`PUT ${SVC}/x`]: { status: 400, body: { error: { code: 'ValidationError', message: 'One or more fields contain incorrect values:', details: [{ code: 'ValidationError', message: "Error in element 'set-variable' on line 479, column 6: Expression return type 'System.Object' is not allowed" }] } } } });
    await expect(invalid.client.put(`${SVC}/x`, {}, {})).rejects.toMatchObject({ status: 400, details: ["Error in element 'set-variable' on line 479, column 6: Expression return type 'System.Object' is not allowed"] });
  });

  it('pushes a policy with the ETag it read, or If-None-Match when there was none', async () => {
    const { client, calls } = fakeArm({
      [`${SVC}/apis/echo/policies/policy?format=rawxml`]: { body: { properties: { value: '<policies>live</policies>' } }, headers: { etag: '"v1"' } },
      [`PUT ${SVC}/apis/echo/policies/policy`]: { body: {} },
      [`PUT ${SVC}/policyFragments/new-one`]: { status: 201, body: {} },
    });
    const i = new ApimInstance(client, SVC, 60_000);
    const live = await i.livePolicy({ kind: 'api', api: 'echo' });
    expect(live).toEqual({ xml: '<policies>live</policies>', etag: '"v1"' });
    await i.pushPolicy({ kind: 'api', api: 'echo' }, '<policies>new</policies>', 'rawxml', live.etag);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(JSON.parse(put.body!)).toEqual({ properties: { format: 'rawxml', value: '<policies>new</policies>' } });
    expect(put.headers['if-match']).toBe('"v1"');

    expect(await i.liveFragment('new-one')).toEqual({ xml: undefined, etag: undefined, description: undefined });
    await i.pushFragment('new-one', '<fragment />', 'xml', 'desc');
    const created = calls.filter((c) => c.method === 'PUT')[1];
    expect(created.headers['if-none-match']).toBe('*');
    expect(JSON.parse(created.body!)).toEqual({ properties: { format: 'xml', value: '<fragment />', description: 'desc' } });
    await expect(i.livePolicy({ kind: 'fragment', fragment: 'f' })).rejects.toThrow();
  });
});

describe('telling the user what went wrong', () => {
  it('says which role reading needs when ARM refuses, and passes other messages on', () => {
    expect(describeError(new ArmError(403, 'AuthorizationFailed', 'Not allowed.'))).toBe('Not allowed. (reading policies needs the API Management Service Reader role)');
    expect(describeError(new ArmError(404, 'ResourceNotFound', 'No such service.'))).toBe('No such service.');
    expect(describeError(new Error('offline'))).toBe('offline');
  });
});

describe('the instances pushing may write to', () => {
  it('match a resource ID however it was written', () => {
    const allowed = [`${SVC.toUpperCase()}/`, 'not-an-id'];
    expect(isAllowedInstance(allowed, SVC)).toBe(true);
    expect(isAllowedInstance(allowed, SVC.replace('apim1', 'apim2'))).toBe(false);
    expect(isAllowedInstance(['not-an-id'], 'NOT-AN-ID')).toBe(true);
  });
});

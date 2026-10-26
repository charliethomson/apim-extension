/**
 * A test case and the APIOps extract around it, as a run for the runner: the policy under test and
 * its broader scopes (innermost first), every fragment, the extract's plain named values with the
 * test's on top, and the API's details for `context`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { extractRootOf, type Scope, scopeFromPath, scopeLabel } from '@charliethomson/apim-core';
import { type Document, parse } from '@charliethomson/apim-document';
import { ExtractReader, type ScopeLink, scopeChains } from '@charliethomson/apim-workspace';
import type { RunContext, RunInput, RunNode, ScopePolicy } from './protocol';
import { type BodySpec, merge, type TestCase, TestFileError } from './testFile';
import { toRunTree } from './tree';

/** The files a project reads, by absolute path. */
export interface ProjectFiles {
  /** A file's text, or undefined when there's no such file. */
  read(path: string): Promise<string | undefined>;
  /** The names of the folders in `path`; empty when it doesn't exist. */
  folders(path: string): Promise<string[]>;
}

/** The local disk. */
export const nodeFiles: ProjectFiles = {
  read: (path) => readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'EISDIR' ? undefined : Promise.reject(e))),
  folders: (path) =>
    readdir(path, { withFileTypes: true }).then(
      (entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name),
      () => [],
    ),
};

/** The host test requests go to when a test's url is just a path. */
export const TEST_HOST = 'https://apim.example.net';

/** An extract on disk, read once per run of the tests. */
export class Project {
  private readonly docs = new Map<string, Promise<Document | undefined>>();
  private fragmentTrees?: Promise<RunInput['fragments']>;
  private named?: Promise<Record<string, string>>;
  readonly reader: ExtractReader;

  constructor(
    readonly root: string,
    readonly files: ProjectFiles = nodeFiles,
  ) {
    this.reader = new ExtractReader(root, {
      policy: (path) => this.doc(path),
      text: (path) => files.read(path),
      folders: (path) => files.folders(path),
    });
  }

  /** A policy file, parsed once. */
  doc(path: string): Promise<Document | undefined> {
    let doc = this.docs.get(path);
    if (!doc) this.docs.set(path, (doc = this.files.read(path).then((text) => (text === undefined ? undefined : parse(text)))));
    return doc;
  }

  /** Every fragment in `policyFragments/`, by id. */
  fragments(): Promise<RunInput['fragments']> {
    return (this.fragmentTrees ??= (async () => {
      const out: RunInput['fragments'] = {};
      for (const id of (await this.files.folders(join(this.root, 'policyFragments'))).sort()) {
        const file = join(this.root, 'policyFragments', id, 'policy.xml');
        const doc = await this.doc(file);
        const root = doc && toRunTree(doc);
        if (root) out[id] = { file, root };
      }
      return out;
    })());
  }

  /** Named values from `namedValues/`, by display name. Secrets and Key Vault references have no value here, so a test gives them. */
  namedValues(): Promise<Record<string, string>> {
    return (this.named ??= (async () => {
      const out: Record<string, string> = {};
      for (const name of await this.files.folders(join(this.root, 'namedValues'))) {
        const info = props(await this.json(join(this.root, 'namedValues', name, 'namedValueInformation.json')));
        if (info.secret === true || typeof info.value !== 'string') continue;
        out[typeof info.displayName === 'string' ? info.displayName : name] = info.value;
      }
      return out;
    })());
  }

  async json(path: string): Promise<unknown> {
    const text = await this.files.read(path);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
}

/** Where a test file's policy is: the scope folder holding its `tests/`, and the extract's root. */
export async function locate(test: TestCase, files: ProjectFiles = nodeFiles): Promise<{ root: string; scope: Scope; policyFile: string }> {
  const testsDir = dirname(test.file);
  if (posix.basename(testsDir.replace(/\\/g, '/')) !== 'tests') throw new TestFileError(test.file, 1, "A test file lives in a tests/ folder beside the policy it tests, like apis/<api>/tests/.");
  const scopeDir = dirname(testsDir);
  const policyFile = test.policy ? join(scopeDir, test.policy, 'policy.xml') : join(scopeDir, 'policy.xml');
  let scope = scopeFromPath(policyFile);
  if (!scope && dirname(policyFile) === scopeDir) {
    const folders = await files.folders(scopeDir);
    if (folders.includes('apis') || folders.includes('policyFragments')) scope = { kind: 'global' };
  }
  if (!scope) throw new TestFileError(test.file, 1, `${policyFile} isn't a policy in an APIOps extract (apis/, products/, policyFragments/, or the extract root).`);
  return { root: extractRootOf(policyFile, scope), scope, policyFile };
}

/** The run for `test`, in the extract `project` reads. */
export async function buildRun(test: TestCase, project: Project, located: { scope: Scope; policyFile: string }): Promise<RunInput> {
  const { scope, policyFile } = located;
  const [fragments, extractValues] = await Promise.all([project.fragments(), project.namedValues()]);
  let scopes: ScopePolicy[];
  let product: string | undefined;
  if (scope.kind === 'fragment') {
    if (!fragments[scope.fragment]) throw new TestFileError(test.file, test.line, `There's no fragment ${scope.fragment} at ${policyFile}.`);
    scopes = [{ kind: 'test', label: `test of fragment ${scope.fragment}`, root: fragmentWrapper(scope.fragment, test) }];
  } else {
    const chain = pickChain(await scopeChains(scope, project.reader), test, scope);
    product = chain.flatMap((l) => (l.scope.kind === 'product' ? [l.scope.product] : []))[0];
    const self = await project.doc(policyFile);
    scopes = [{ scope, doc: self }, ...chain].map((l) => ({
      kind: l.scope.kind,
      label: scopeLabel(l.scope),
      file: project.reader.policyPath(l.scope),
      root: l.doc && toRunTree(l.doc),
    }));
  }
  const context = await contextFor(scope, product, project);
  const merged = merge(context as Record<string, unknown>, test.context) as RunContext;
  const request = requestFor(test, merged);
  return {
    scopes,
    fragments,
    namedValues: { ...extractValues, ...test.namedValues },
    variables: test.variables,
    request: { ...request, body: await bodyText(test.request.body, test) },
    backend: test.backend && { status: test.backend.status, reason: test.backend.reason, headers: test.backend.headers, body: await bodyText(test.backend.body, test) },
    context: merged,
  };
}

/** The chain the test runs in: the only one, or the one through the product it names. */
function pickChain(chains: ScopeLink[][], test: TestCase, scope: Scope): ScopeLink[] {
  const productOf = (c: ScopeLink[]) => c.flatMap((l) => (l.scope.kind === 'product' ? [l.scope.product] : []))[0];
  if (!chains.length) return [];
  if (test.product) {
    const chain = chains.find((c) => productOf(c) === test.product);
    if (!chain) {
      const products = chains.map(productOf).filter(Boolean);
      throw new TestFileError(test.file, test.line, `${scopeLabel(scope)} isn't in product ${test.product}${products.length ? `; it's in ${products.join(', ')}` : ''}.`);
    }
    return chain;
  }
  if (chains.length > 1) throw new TestFileError(test.file, test.line, `${scopeLabel(scope)} is in products ${chains.map(productOf).join(', ')}: say which with product:.`);
  return chains[0];
}

/** A fragment's test runs it alone, included in the section the test names. */
function fragmentWrapper(id: string, test: TestCase): RunNode {
  const include: RunNode = { name: 'include-fragment', attrs: [{ name: 'fragment-id', value: id }], children: [], line: 0, col: 0 };
  const sections: RunNode[] = [{ name: test.section, attrs: [], children: [include], line: 0, col: 0 }];
  if (test.backend && test.section === 'inbound') sections.push({ name: 'backend', attrs: [], children: [{ name: 'forward-request', attrs: [], children: [], line: 0, col: 0 }], line: 0, col: 0 });
  return { name: 'policies', attrs: [], children: sections, line: 0, col: 0 };
}

/** What the extract says about the API, operation and product, for `context`. */
async function contextFor(scope: Scope, product: string | undefined, project: Project): Promise<RunContext> {
  const out: RunContext = {};
  if (scope.kind === 'api' || scope.kind === 'operation') {
    const info = props(await project.json(join(project.root, 'apis', scope.api, 'apiInformation.json')));
    out.api = {
      id: scope.api,
      name: str(info.displayName) ?? scope.api,
      path: str(info.path) ?? '',
      ...(str(info.serviceUrl) ? { serviceUrl: str(info.serviceUrl) } : {}),
      ...(str(info.apiRevision) ? { revision: str(info.apiRevision) } : {}),
      ...(str(info.apiVersion) ? { version: str(info.apiVersion) } : {}),
    };
  }
  if (scope.kind === 'operation') out.operation = { id: scope.operation, name: scope.operation };
  if (product) {
    const info = props(await project.json(join(project.root, 'products', product, 'productInformation.json')));
    out.product = { id: product, name: str(info.displayName) ?? product };
  }
  return out;
}

/**
 * The request: a path-only url goes under the API's path on the test host, and the backend URL is
 * the API's service URL with what follows the API's path.
 */
export function requestFor(test: TestCase, context: RunContext): Omit<RunInput['request'], 'body'> {
  const apiPath = (context.api?.path ?? '').replace(/^\/+|\/+$/g, '');
  const url = test.request.url.startsWith('/') ? `${TEST_HOST}${apiPath ? `/${apiPath}` : ''}${test.request.url}` : test.request.url;
  let backendUrl: string | undefined;
  const service = context.api?.serviceUrl;
  if (service) {
    const u = new URL(url);
    const prefix = apiPath ? `/${apiPath}` : '';
    const rest = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname;
    backendUrl = `${service.replace(/\/+$/, '')}${rest === '/' && !service.endsWith('/') ? '' : rest}${u.search}`;
  }
  return {
    method: test.request.method,
    url,
    ...(backendUrl ? { backendUrl } : {}),
    headers: test.request.headers,
    matchedParameters: test.request.matchedParameters,
    ...(test.request.ipAddress ? { ipAddress: test.request.ipAddress } : {}),
  };
}

/** A body's text: as written, JSON written out, or a file beside the test. */
export async function bodyText(body: BodySpec | undefined, test: TestCase, files: ProjectFiles = nodeFiles): Promise<string | undefined> {
  if (!body) return undefined;
  if ('text' in body) return body.text;
  if ('json' in body) return JSON.stringify(body.json);
  const path = join(dirname(test.file), body.file);
  const text = await files.read(path);
  if (text === undefined) throw new TestFileError(test.file, test.line, `Body file ${body.file} isn't there (looked for ${path}).`);
  return text;
}

/** An APIOps information file's fields: under `properties`, or at the top in older extracts. */
function props(json: unknown): Record<string, unknown> {
  const o = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  const p = o.properties;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : o;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

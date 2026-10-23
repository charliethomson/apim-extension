/**
 * Where a policy sits in APIM's scope hierarchy, and the paths that name each scope: the APIOps
 * extract's layout and the instance documents' (`apim-instance:`, `apim-edit:`).
 */

export type Scope =
  | { kind: 'global' }
  | { kind: 'workspace'; workspace: string }
  | { kind: 'product'; product: string }
  | { kind: 'api'; api: string }
  | { kind: 'operation'; api: string; operation: string }
  | { kind: 'fragment'; fragment: string };

export function scopeKey(s: Scope): string {
  switch (s.kind) {
    case 'global':
      return 'global';
    case 'workspace':
      return `workspace/${s.workspace}`;
    case 'product':
      return `product/${s.product}`;
    case 'api':
      return `api/${s.api}`;
    case 'operation':
      return `api/${s.api}/operation/${s.operation}`;
    case 'fragment':
      return `fragment/${s.fragment}`;
  }
}

export function scopeLabel(s: Scope): string {
  switch (s.kind) {
    case 'global':
      return 'global';
    case 'workspace':
      return `workspace ${s.workspace}`;
    case 'product':
      return `product ${s.product}`;
    case 'api':
      return `API ${s.api}`;
    case 'operation':
      return `operation ${s.api}/${s.operation}`;
    case 'fragment':
      return `fragment ${s.fragment}`;
  }
}

/**
 * The scope an APIOps-shaped path holds (the extractor's layout). `global` needs
 * `isExtractRoot` to say the folder is an extract's root, since a bare `policy.xml` could be
 * anything.
 */
export function scopeFromPath(path: string, isExtractRoot?: (dir: string) => boolean): Scope | undefined {
  const parts = path.replace(/\\/g, '/').split('/');
  const n = parts.length;
  if (parts[n - 1] !== 'policy.xml') return undefined;
  const at = (i: number) => parts[n - 1 - i];
  if (at(4) === 'apis' && at(2) === 'operations') return { kind: 'operation', api: at(3), operation: at(1) };
  if (at(2) === 'apis') return { kind: 'api', api: at(1) };
  if (at(2) === 'products') return { kind: 'product', product: at(1) };
  if (at(2) === 'workspaces') return { kind: 'workspace', workspace: at(1) };
  if (at(2) === 'policyFragments') return { kind: 'fragment', fragment: at(1) };
  const dir = parts.slice(0, n - 1).join('/');
  return isExtractRoot?.(dir) ? { kind: 'global' } : undefined;
}

/**
 * The path of a scope's policy in the instance's documents (`apim-instance:`, `apim-edit:`),
 * named for what it is so editor tabs and Quick Open tell them apart:
 * `/<instance>/apis/echo.policy.xml`, `/<instance>/fragments/sign.fragment.xml`.
 */
export function instancePath(scope: Scope, instance: string): string {
  switch (scope.kind) {
    case 'global':
      return `/${instance}/global.policy.xml`;
    case 'workspace':
      return `/${instance}/workspaces/${scope.workspace}.policy.xml`;
    case 'product':
      return `/${instance}/products/${scope.product}.policy.xml`;
    case 'api':
      return `/${instance}/apis/${scope.api}.policy.xml`;
    case 'operation':
      return `/${instance}/apis/${scope.api}/${scope.operation}.policy.xml`;
    case 'fragment':
      return `/${instance}/fragments/${scope.fragment}.fragment.xml`;
  }
}

/** The scope an instance document's path (from `instancePath`) is for. */
export function scopeFromInstancePath(path: string): Scope | undefined {
  const [, , ...rest] = path.split('/');
  const name = (file: string | undefined, suffix: string) => (file?.endsWith(suffix) && file.length > suffix.length ? file.slice(0, -suffix.length) : undefined);
  if (rest.length === 1 && rest[0] === 'global.policy.xml') return { kind: 'global' };
  if (rest.length === 2) {
    const fragment = rest[0] === 'fragments' ? name(rest[1], '.fragment.xml') : undefined;
    if (fragment) return { kind: 'fragment', fragment };
    const id = name(rest[1], '.policy.xml');
    if (id && rest[0] === 'apis') return { kind: 'api', api: id };
    if (id && rest[0] === 'products') return { kind: 'product', product: id };
    if (id && rest[0] === 'workspaces') return { kind: 'workspace', workspace: id };
  }
  if (rest.length === 3 && rest[0] === 'apis') {
    const operation = name(rest[2], '.policy.xml');
    if (operation) return { kind: 'operation', api: rest[1], operation };
  }
  return undefined;
}

import { describe, expect, it } from 'vitest';
import { instancePath, scopeFromInstancePath, scopeFromPath, scopeKey, scopeLabel, type Scope } from '../src/scope';

describe('scopeFromPath', () => {
  it('reads the APIOps layout', () => {
    expect(scopeFromPath('/r/apis/echo/operations/get/policy.xml')).toEqual({ kind: 'operation', api: 'echo', operation: 'get' });
    expect(scopeFromPath('/r/apis/echo/policy.xml')).toEqual({ kind: 'api', api: 'echo' });
    expect(scopeFromPath('/r/products/starter/policy.xml')).toEqual({ kind: 'product', product: 'starter' });
    expect(scopeFromPath('/r/workspaces/team/policy.xml')).toEqual({ kind: 'workspace', workspace: 'team' });
    expect(scopeFromPath('C:\\r\\policyFragments\\sign\\policy.xml')).toEqual({ kind: 'fragment', fragment: 'sign' });
  });

  it('only calls a bare policy.xml global at an extract root, and ignores other files', () => {
    expect(scopeFromPath('/r/policy.xml')).toBeUndefined();
    expect(scopeFromPath('/r/policy.xml', (dir) => dir === '/r')).toEqual({ kind: 'global' });
    expect(scopeFromPath('/r/apis/echo/other.xml')).toBeUndefined();
  });

  it('names scopes', () => {
    const all: Scope[] = [
      { kind: 'global' },
      { kind: 'workspace', workspace: 'w' },
      { kind: 'product', product: 'p' },
      { kind: 'api', api: 'a' },
      { kind: 'operation', api: 'a', operation: 'o' },
      { kind: 'fragment', fragment: 'f' },
    ];
    expect(all.map(scopeLabel)).toEqual(['global', 'workspace w', 'product p', 'API a', 'operation a/o', 'fragment f']);
    expect(new Set(all.map(scopeKey)).size).toBe(all.length);
  });
});

describe('instance document paths', () => {
  it('name each policy for what it is, and read back to the same scope', () => {
    const all: Scope[] = [
      { kind: 'global' },
      { kind: 'workspace', workspace: 'w' },
      { kind: 'product', product: 'starter' },
      { kind: 'api', api: 'echo' },
      { kind: 'operation', api: 'echo', operation: 'get-users' },
      { kind: 'fragment', fragment: 'random-user' },
    ];
    expect(all.map((s) => instancePath(s, 'apim1'))).toEqual([
      '/apim1/global.policy.xml',
      '/apim1/workspaces/w.policy.xml',
      '/apim1/products/starter.policy.xml',
      '/apim1/apis/echo.policy.xml',
      '/apim1/apis/echo/get-users.policy.xml',
      '/apim1/fragments/random-user.fragment.xml',
    ]);
    expect(all.map((s) => scopeFromInstancePath(instancePath(s, 'apim1')))).toEqual(all);
  });

  it('reads nothing from other paths, like the folders above a policy', () => {
    for (const p of ['/apim1', '/apim1/apis', '/apim1/apis/echo', '/apim1/fragments/x.policy.xml', '/apim1/apis/.policy.xml', '/apim1/other/x.policy.xml', '/apim1/apis/a/b/c.policy.xml']) {
      expect(scopeFromInstancePath(p), p).toBeUndefined();
    }
  });
});

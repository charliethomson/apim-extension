import { describe, expect, it } from 'vitest';
import { fragmentIdsFor } from '../src/fragmentIds';

describe('fragmentIdsFor', () => {
  it.each([
    ['fragments/rate-limit.policy.xml', ['rate-limit']],
    ['fragments/rate-limit.xml', ['rate-limit']],
    ['policyFragments/rate-limit/policy.xml', ['rate-limit']],
    ['C:\\repo\\policyFragments\\auth\\policy.xml', ['auth']],
    ['policy.xml', []],
  ])('%s', (path, ids) => expect(fragmentIdsFor(path)).toEqual(ids));
});

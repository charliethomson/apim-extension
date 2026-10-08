/**
 * Fragment ids a file could provide, from its path. `rate-limit.policy.xml` and
 * `rate-limit.xml` give `rate-limit`; APIOps' `policyFragments/rate-limit/policy.xml` gives
 * `rate-limit` from the folder.
 */
export function fragmentIdsFor(path: string): string[] {
  const parts = path.split(/[\\/]/);
  const file = parts[parts.length - 1];
  const ids = new Set<string>();
  const stem = file.replace(/\.policy\.xml$/i, '').replace(/\.xml$/i, '');
  if (stem.toLowerCase() === 'policy') {
    if (parts.length >= 2) ids.add(parts[parts.length - 2]);
  } else {
    ids.add(stem);
  }
  return [...ids];
}

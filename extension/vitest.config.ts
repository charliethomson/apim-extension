import { packageConfig } from '../vitest.shared';

// The providers are covered by the integration suite in VS Code (test/integration); these unit
// tests check the grammars and snippets only.
export default packageConfig({ floor: false });

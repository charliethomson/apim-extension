// Lint for the extension, its tests and the bench. Typecheck-aware rules catch what tsc doesn't
// (an unawaited promise, a misused async callback). CI runs it with --max-warnings 0.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'coverage/**', '.vscode-test/**', 'node_modules/**', 'test/grammars/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { parserOptions: { projectService: false }, globals: { process: 'readonly', console: 'readonly' } },
  },
);

// Lint for every package, the extension and the bench. Typecheck-aware rules catch what tsc doesn't
// (an unawaited promise, a misused async callback). CI runs it with --max-warnings 0.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const root = import.meta.dirname;

/** Every workspace: its directory, and the workspace packages it may import. */
const workspaces = [...readdirSync(join(root, 'packages')).map((d) => join('packages', d)), 'extension', 'bench'].map((dir) => {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  return { dir: resolve(root, dir), name: pkg.name, declared: new Set(declared) };
});

/**
 * The package boundaries, which npm can't enforce: it links every workspace package into the root
 * node_modules, so an undeclared import still resolves. A file may import another workspace
 * package only when its package.json declares it, only through that package's exports (never
 * its src/), and never reach outside its own package by a relative path. Only the extension may
 * import `vscode`.
 */
const boundaries = {
  rules: {
    imports: {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const file = context.filename;
        const own = workspaces.find((w) => file.startsWith(w.dir + sep));
        if (!own) return {};
        const check = (node) => {
          const spec = node.source?.value;
          if (typeof spec !== 'string') return;
          const report = (message) => context.report({ node: node.source, message });
          if (spec.startsWith('.')) {
            const target = resolve(dirname(file), spec);
            if (!target.startsWith(own.dir + sep)) report(`'${spec}' reaches outside ${own.name}; import the package that owns it by name.`);
          } else if (spec === 'vscode') {
            if (own.name !== 'apim-policy') report(`Only the extension imports 'vscode'; ${own.name} must work without VS Code.`);
          } else if (spec.startsWith('@apim-policy/')) {
            const name = spec.split('/').slice(0, 2).join('/');
            if (!own.declared.has(name)) report(`${own.name} doesn't declare ${name} in its package.json.`);
            else if (/\/src(\/|$)/.test(spec.slice(name.length))) report(`'${spec}' imports ${name}'s internals; use its exports.`);
          }
        };
        return { ImportDeclaration: check, ExportNamedDeclaration: check, ExportAllDeclaration: check, ImportExpression: check };
      },
    },
  },
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/out/**', '**/coverage/**', '**/.vscode-test/**', '**/node_modules/**', 'extension/test/grammars/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: root },
    },
  },
  {
    files: ['packages/**/*.ts', 'extension/**/*.ts', 'bench/**/*.ts'],
    // Each package's vitest config extends the shared one at the root; that's build config.
    ignores: ['**/vitest.config.mts'],
    plugins: { boundaries },
    rules: { 'boundaries/imports': 'error' },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { parserOptions: { projectService: false }, globals: { process: 'readonly', console: 'readonly' } },
  },
);

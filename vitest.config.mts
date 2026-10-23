import { defineConfig } from 'vitest/config';

// `npx vitest` from the root runs every package's suite; `npm run test:coverage` runs each
// package on its own so each gets its own coverage floor.
export default defineConfig({ test: { projects: ['packages/*', 'extension'] } });

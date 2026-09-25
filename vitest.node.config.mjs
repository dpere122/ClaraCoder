// Node-side unit tests (Electron main, preload, shared, scripts). The renderer suite runs
// separately through the Angular CLI (`npm test`); this config is used by `npm run test:node`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/shared/**/*.spec.ts',
      'src/main/**/*.spec.ts',
      'src/preload/**/*.spec.ts',
      'scripts/**/*.spec.ts',
    ],
    exclude: ['**/node_modules/**', 'dist/**', 'src/renderer/**'],
  },
});

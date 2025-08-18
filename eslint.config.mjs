// @ts-check

import stf from '@shrinktofit/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores([
    '**/node_modules/**/*.*',
    '**/lib/*',
    '**/dist/*',
    '**/.deploy/*',
  ]),
  {
    settings: {
      node: {
        version: '>=22.7.0',
      },
    },
  },
  // @ts-expect-error
  ...stf.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: [
          'tsconfig.json',
          'packages/*/tsconfig.json',
        ],
        projectService: {
          allowDefaultProject: [
            'eslint.config.mjs',
            'vite.config.ts',
            'packages/*/vite.config.ts',
          ],
        },
      },
    },
  },
  {
    rules: {
      'n/no-extraneous-import': 'off',
    },
  },
  {
    files: ['*.vue'],
    rules: {
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
]);

// @ts-check

import stf from '@shrinktofit/eslint-config';
import stfNode from '@shrinktofit/eslint-config/node';
import stfVue from '@shrinktofit/eslint-config/vue';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores([
    '**/node_modules/*',
    '**/lib/*',
    '**/dist/*',
    '**/.deploy/*',
    '**/.vitepress/cache/**',
    // Fixtures intentionally contain invalid syntax and consumer-specific type errors.
    'packages/oms-systemjs/test/fixtures/**',
    'tests/plugin/artifacts/**',
  ]),
  {
    settings: {
      node: {
        version: '>=22.7.0',
      },
    },
  },
  ...stf.configs.recommended,
  ...stfNode.configs.recommended,
  ...stfVue.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: [
          'packages/*/tsconfig.json',
          'packages/*/test/tsconfig.json',
          'packages/build-core/helpers/tsconfig.json',
          'packages/extension/mount/tsconfig.json',
          'tsconfig.eslint.json',
        ],
      },
    },
  },
  {
    rules: {
      'n/no-extraneous-import': 'off',
      // Both APIs exist in the supported Node range; their experimental flags ended later.
      'n/no-unsupported-features/node-builtins': ['error',
        {
          ignores: ['import.meta.dirname', 'readline/promises'],
        }],
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: ['.vue'],
        project: false,
        projectService: true,
      },
    },
    rules: {
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
        },
      ],
    },
  },
]);

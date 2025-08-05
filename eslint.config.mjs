import stf from '@shrinktofit/eslint-plugin';

export default [
  {
    settings: {
      node: {
        version: '>=22.7.0',
      },
    },
  },
  {
    ignores: [
      'node_modules',
      '**/lib',
      '**/dist',
    ],
  },
  ...stf.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: [
          'tsconfig.json',
        ],
        projectService: {
          allowDefaultProject: [
            'eslint.config.mjs',
            'vite.config.mts',
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
];

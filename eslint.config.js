// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'data/**', 'coverage/**', 'assests/**'],
  },
  eslint.configs.recommended,
  {
    // Tooling config files are plain JS and are not part of the TS program, so
    // type-aware rules cannot run on them.
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: { globals: { module: 'writable', require: 'readonly' } },
  },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      // Library code logs through pino. Only the CLI writes to stdout.
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // The DOM lib is enabled for page.evaluate() callbacks, which run in the
      // browser. Using these in Node code typechecks but crashes at runtime, so
      // each legitimate browser-side use disables this rule explicitly.
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'Only inside page.evaluate() — add an eslint-disable there.' },
        { name: 'window', message: 'Only inside page.evaluate() — add an eslint-disable there.' },
        { name: 'navigator', message: 'Only inside page.evaluate() — add an eslint-disable there.' },
        { name: 'location', message: 'Only inside page.evaluate() — add an eslint-disable there.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // Cross-platform: paths must be built with node:path, never string concatenation.
          selector: "BinaryExpression[operator='+'] > Literal[value=/^\\//]",
          message: 'Do not build paths by string concatenation. Use node:path.',
        },
      ],
    },
  },
  {
    // The CLI is the one place allowed to write to stdout directly.
    files: ['src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // Test fixtures are standalone scripts that report through stdout.
      'no-console': 'off',
    },
  },
);

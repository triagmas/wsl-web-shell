import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'out/**',
      'src/splash/**',
      'src/settings/**',
      'src/chrome/**',
      'src/popover/**',
      'src/update/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-control-regex': 'off',
    },
  },
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      parserOptions: { ecmaVersion: 2023 },
      globals: {
        process: 'readonly',
        console: 'readonly',
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);

// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import noLiteralUiStrings from './extension/lint/no-literal-ui-strings.js';

/** Node built-ins that pure packages and extension code must not import (exact names). */
const NODE_BUILTINS = ['fs', 'path', 'zlib', 'crypto', 'buffer'];
/** Their subpath modules (fs/promises, path/posix, ...); anchored, so relative paths never match. */
const NODE_BUILTIN_SUBPATH = `^(?:${NODE_BUILTINS.join('|')})/`;
const PURE_MESSAGE = 'pure packages (core, builders, extension policy) must not use Node built-ins';
const EXTENSION_MESSAGE = 'extension code runs in browsers: no Node built-ins';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-test/**',
      // Root test-coverage output.
      'coverage/**',
      // Git-ignored downloads: e2e browsers (.cache/browsers/), e2e results.
      '.cache/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {...globals.es2025},
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
      // Verified code must never generate code at runtime.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // packages/core and packages/builders are shared by the extension (its
    // build and its local deep verify) and the recompute CLI, and
    // extension/src/policy is the pure verification kernel of the extension.
    // They must stay pure: no Node built-ins, no DOM, no process, no extension
    // APIs.
    files: [
      'packages/core/src/**/*.ts',
      'packages/builders/src/**/*.ts',
      'extension/src/policy/**/*.ts',
    ],
    languageOptions: {
      globals: {
        crypto: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        DecompressionStream: 'readonly',
        ReadableStream: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        // Type only (the chunk type of DecompressionStream).
        BufferSource: 'readonly',
      },
    },
    rules: {
      // Only the globals listed above (plus ECMAScript built-ins) exist here:
      // fetch, setTimeout, navigator, self, location, indexedDB, ... are errors.
      'no-undef': 'error',
      'no-restricted-imports': [
        'error',
        {
          // Bare module names go in `paths` (exact match): as a gitignore-style pattern, 'crypto'
          // would also match relative imports such as '../crypto/webcrypto.ts'.
          paths: NODE_BUILTINS.map(name => ({name, message: PURE_MESSAGE})),
          patterns: [
            {group: ['node:*'], message: PURE_MESSAGE},
            {regex: NODE_BUILTIN_SUBPATH, message: PURE_MESSAGE},
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'process',
        'Buffer',
        'require',
        'chrome',
        'browser',
        // Would reach every host global (globalThis.fetch, globalThis.process).
        'globalThis',
      ],
    },
  },
  {
    // Extension runtime code (background, content scripts, pages). Browser
    // globals only; extension APIs only through extension/src/platform/api.ts
    // (the promise-only `ext` namespace), never through chrome.* / browser.*.
    files: ['extension/src/**/*.ts'],
    // The pure kernel keeps the stricter block above (globals would merge).
    ignores: ['extension/src/policy/**'],
    languageOptions: {
      globals: {...globals.browser},
    },
    rules: {
      'no-undef': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map(name => ({name, message: EXTENSION_MESSAGE})),
          patterns: [
            {group: ['node:*'], message: EXTENSION_MESSAGE},
            {regex: NODE_BUILTIN_SUBPATH, message: EXTENSION_MESSAGE},
            {
              // Test fixtures and helpers never reach a package.
              group: ['@intactwarden/*/test/*', '**/test/**'],
              message: 'test-only helpers must not be imported by extension code',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'process',
        'Buffer',
        'require',
        {name: 'chrome', message: 'use ext from extension/src/platform/api.ts'},
        {name: 'browser', message: 'use ext from extension/src/platform/api.ts'},
      ],
      // Text is set with textContent, never parsed as markup.
      'no-restricted-properties': [
        'error',
        {property: 'innerHTML', message: 'use textContent (no-innerHTML)'},
        {property: 'outerHTML', message: 'use textContent (no-innerHTML)'},
        {property: 'insertAdjacentHTML', message: 'use textContent (no-innerHTML)'},
        {object: 'document', property: 'write', message: 'never write markup'},
        {object: 'document', property: 'writeln', message: 'never write markup'},
      ],
    },
  },
  {
    // Every user-visible string of the UI comes from the i18n catalogue
    // (extension/lint/no-literal-ui-strings.js).
    files: ['extension/src/ui/**/*.ts'],
    plugins: {intactwarden: {rules: {'no-literal-ui-strings': noLiteralUiStrings}}},
    rules: {'intactwarden/no-literal-ui-strings': 'error'},
  },
  {
    // The one place that touches the browser's extension namespace.
    files: ['extension/src/platform/api.ts'],
    rules: {'no-restricted-globals': ['error', 'process', 'Buffer', 'require']},
  },
  {
    files: [
      'packages/*/test/**/*.ts',
      'extension/build/**/*.ts',
      'extension/lint/**/*.js',
      'extension/test/**/*.ts',
      'tools/**/*.ts',
      'vitest.config.ts',
    ],
    languageOptions: {
      globals: {...globals.node},
    },
  },
);

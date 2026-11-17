/**
 * ESLint configuration for package.json only.
 *
 * Oxlint lints everything else (oxlint.config.ts) but cannot lint package.json, so `bun run lint`
 * runs ESLint with this config on that one file. The config is the `package-json` entry point of
 * @hughescr/oxlint-config-default (eslint-plugin-package-json's recommended set, nothing else loaded).
 * ESLint is intentionally retained for this one file (#187).
 */
export { default } from '@hughescr/oxlint-config-default/package-json';

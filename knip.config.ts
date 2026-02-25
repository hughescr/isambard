import type { KnipConfig } from 'knip';

const config: KnipConfig = {
    $schema: 'https://unpkg.com/knip@5/schema.json',
    entry:   [
        '*.config.mjs',
        '*.conf.mjs',
        'tools/**/*.mjs',
        'scripts/**/*.ts',
        'tests/**/*.test.ts',
    ],
    project: [
        'src/**/*.ts',
        'tools/**/*.mjs',
        'scripts/**/*.ts',
    ],
    ignoreDependencies: [
        'eslint-plugin-package-json',
        '@stryker-mutator/bun-runner',
    ],
    bun: true,
};

export default config;

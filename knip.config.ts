import type { KnipConfig } from 'knip';

const config: KnipConfig = {
    $schema: 'https://unpkg.com/knip@6/schema.json',
    // src/index.ts is the app entry point; tests are also entry points.
    // Production code imports across modules via barrels; tests import directly from source files.
    entry:   [
        'src/index.ts',
        '*.config.mjs',
        '*.conf.mjs',
        'tools/**/*.ts',
        'scripts/**/*.ts',
        'tests/**/*.test.ts',
    ],
    project: [
        'src/**/*.ts',
        'tools/**/*.ts',
        'scripts/**/*.ts',
    ],
    ignoreDependencies: [
        'eslint-plugin-package-json',
        '@stryker-mutator/bun-runner',
    ],
    ignoreBinaries: [
        'tools/run-stryker.sh',
        'tools/setup-node-llama-cpp.sh',
    ],
    tags: ['internal'],
    bun:  true,
};

export default config;

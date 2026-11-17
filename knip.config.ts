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
        // Loaded by Stryker's experimentalNativePreview checker, not by application code.
        '@typescript/native',
        // The lint scripts run it by path (`bun node_modules/eslint/bin/eslint.js`, faster than the node shebang) on package.json only.
        'eslint',
    ],
    tags:    ['internal'],
    bun:     true,
    // Parse the config as an entry point, but don't execute its credential-dependent LLM setup.
    stryker: false,
};

export default config;

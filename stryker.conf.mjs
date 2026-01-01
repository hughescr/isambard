const isCI = Boolean(process.env.GITHUB_SHA);

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    packageManager:   'npm', // Stryker doesn't support bun yet, but works via npx
    incremental:      !isCI, // Fast incremental runs locally, full runs in CI
    reporters:        isCI ? ['clear-text', 'progress', 'dashboard'] : ['clear-text', 'progress'],
    testRunner:       'command',
    commandRunner:    { command: 'bun run test' },
    coverageAnalysis: 'perTest',
    mutate:           ['src/**/*.ts', '!src/index.ts'],
    thresholds:       { high: 100, low: 95, 'break': 90 },
    concurrency:      12,
    tempDirName:      '.stryker-tmp',
    ...(isCI && {
        dashboard: {
            project: 'hughescr/isambard',
            module:  'default',
            version: process.env.GITHUB_SHA,
        },
    }),
};

const isCI = Boolean(process.env.GITHUB_SHA);

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    checkers:         ['typescript'],
    packageManager:   'npm', // Stryker doesn't support bun yet, but works via npx
    incremental:      !isCI, // Fast incremental runs locally, full runs in CI
    reporters:        isCI ? ['clear-text', 'progress', 'dashboard'] : ['progress', 'json', 'html'],
    testRunner:       'bun',
    bun:              { inspectorTimeout: isCI ? 30000 : 5000 },
    plugins:          ['@hughescr/stryker-bun-runner', '@stryker-mutator/typescript-checker'],
    coverageAnalysis: 'perTest',
    disableBail:      true, // Do not stop with first failing test, so we can get complete map of mutant:killer-tests
    mutate:           ['src/**/*.ts', '!src/index.ts', '!src/**/*.test.ts'],
    thresholds:       { high: 100, low: 100, 'break': 100 },
    concurrency:      isCI ? 4 : 24,
    tempDirName:      '.stryker-tmp',
    warnings:         { slow: false },
};

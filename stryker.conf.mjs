const isCI = Boolean(process.env.GITHUB_SHA);

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const strykerConfig = {
    checkers:         ['typescript'],
    packageManager:   'npm', // Stryker doesn't support bun yet, but works via npx
    incremental:      !isCI, // Fast incremental runs locally, full runs in CI
    reporters:        isCI ? ['clear-text', 'progress', 'dashboard'] : ['progress', 'json', 'html'],
    testRunner:       'bun',
    bun:              { inspectorTimeout: isCI ? 30_000 : 5000 },
    plugins:          ['@hughescr/stryker-bun-runner', '@stryker-mutator/typescript-checker'],
    coverageAnalysis: 'perTest',
    disableBail:      true, // Do not stop with first failing test, so we can get complete map of mutant:killer-tests
    mutate:           ['src/**/*.ts', '!src/index.ts'], // Do not mutate the entry point
    ignorePatterns:   ['**', '!src/**/*.ts', '!tests/**/*.ts', '!tests/**/*.json', '!tools/**/*.ts', '!bunfig.toml', '!tsconfig.json', '!*.ts', '!*.mjs', '!sst/**/*.ts'], // Only include source and test files in the mutation testing process
    thresholds:       { high: 100, low: 100, 'break': 100 },
    concurrency:      isCI ? 2 : 12,
    tempDirName:      '.stryker-tmp',
    warnings:         { slow: false },
};

export default strykerConfig;

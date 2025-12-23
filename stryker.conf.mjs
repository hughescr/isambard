/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    packageManager: 'npm', // Stryker doesn't support bun yet, but works via npx
    reporters:      ['html', 'clear-text', 'progress'],
    testRunner:     'command',
    commandRunner:  {
        command: 'bun test'
    },
    coverageAnalysis: 'perTest',
    mutate:           [
        'src/**/*.ts',
        '!src/**/*.test.ts',
        '!src/**/*.spec.ts',
        '!src/index.ts'
    ],
    thresholds: {
        high:    100,
        low:     95,
        'break': 90
    },
    concurrency: 12,
    tempDirName: '.stryker-tmp'
};

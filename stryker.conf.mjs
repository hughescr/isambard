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
        high:    80,
        low:     70,
        'break': 60
    },
    concurrency: 4,
    tempDirName: '.stryker-tmp'
};

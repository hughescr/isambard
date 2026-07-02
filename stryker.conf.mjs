// eslint-disable-next-line import-x/no-extraneous-dependencies -- dev-only config file uses devDependencies
import { withLlmMutators } from '@hughescr/stryker-llm-mutator';

const isCI = Boolean(process.env.GITHUB_SHA);

const withMutators = isCI ? async x => x : withLlmMutators;

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const strykerConfig = await withMutators({
    checkers:         ['typescript'],
    packageManager:   'npm', // Stryker doesn't support bun yet, but works via npx
    incremental:      !isCI, // Fast incremental runs locally, full runs in CI
    reporters:        isCI ? ['clear-text', 'progress', 'dashboard'] : ['llm-mutator', 'progress', 'json', 'html'],
    testRunner:       'bun',
    bun:              { inspectorTimeout: isCI ? 30_000 : 5000, timeout: isCI ? 60_000 : 30_000 },
    plugins:          isCI ? ['@hughescr/stryker-bun-runner', '@stryker-mutator/typescript-checker'] : ['@hughescr/stryker-bun-runner', '@stryker-mutator/*', '@hughescr/stryker-llm-mutator'],
    coverageAnalysis: 'perTest',
    disableBail:      true, // Do not stop with first failing test, so we can get complete map of mutant:killer-tests
    mutate:           ['src/**/*.ts', '!src/index.ts', 'tools/**/*.ts'], // Do not mutate the entry point; tools/ included so disable comments take effect
    ignorePatterns:   ['**', '!src/**/*.ts', '!tests/**/*.ts', '!tests/**/*.json', '!tools/**/*.ts', '!bunfig.toml', '!tsconfig.json', '!*.ts', '!*.mjs', '!sst/**/*.ts'], // Only include source and test files in the mutation testing process
    thresholds:       { high: 100, low: 100, 'break': 100 },
    concurrency:      isCI ? 2 : 12,
    tempDirName:      '.stryker-tmp',
    warnings:         { slow: false },
    llmMutator:       {
        heuristics: { enabled: true },
        dynamicLLM: { enabled: !isCI, parallelBatches: 12 },        // costs money, needs credentials
        provider:   'anthropic-agent-sdk',
        cacheDir:   '.stryker-llm-cache',
    },
});

export default strykerConfig;

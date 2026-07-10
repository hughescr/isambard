// eslint-disable-next-line import-x/no-extraneous-dependencies -- dev-only config file uses devDependencies
import { withLlmMutators } from '@hughescr/stryker-llm-mutator';

const isCI = Boolean(process.env.GITHUB_SHA);

const withMutators = isCI ? async x => x : withLlmMutators;

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const strykerConfig = await withMutators({
    checkers:         ['typescript'],
    packageManager:   'npm', // Stryker doesn't support bun yet, but works via npx
    // Incremental everywhere. Locally: reports/stryker-incremental.json (gitignored, never
    // leaves this machine). NOTE a red LOCAL run still writes Survived verdicts into it, and
    // the upstream differ gap — a Survived mutant with ONLY static coverage is never
    // invalidated by an added test — can then hold local red after a genuine fix: delete the
    // file and re-run, or use the surgical jq scrub in ci.yml's runbook. In CI the same file
    // is restored from actions/cache and saved back ONLY from green trusted runs (break=100
    // ⇒ saved baselines contain no Survived verdicts), so a stale or nuked cache degrades to
    // extra work or an honest red, never a false green. Requires
    // @hughescr/stryker-bun-runner >= 1.3.1: earlier versions promoted multi-test-covered
    // mutants to static coverage, blinding the differ to added tests. Keys, save gating,
    // cold-start bootstrap, and the ops runbook: .github/workflows/ci.yml.
    incremental:      true,
    reporters:        isCI ? ['clear-text', 'progress', 'dashboard'] : ['llm-mutator', 'progress', 'json', 'html'],
    testRunner:       'bun',
    bun:              { inspectorTimeout: isCI ? 30_000 : 5000, timeout: isCI ? 60_000 : 30_000 },
    plugins:          isCI ? ['@hughescr/stryker-bun-runner', '@stryker-mutator/typescript-checker'] : ['@hughescr/stryker-bun-runner', '@stryker-mutator/*', '@hughescr/stryker-llm-mutator'],
    coverageAnalysis: 'perTest',
    disableBail:      true, // Do not stop with first failing test, so we can get complete map of mutant:killer-tests
    mutate:           ['src/**/*.ts', '!src/index.ts', 'tools/**/*.ts'], // Do not mutate the entry point; tools/ included so disable comments take effect
    ignorePatterns:   ['**', '!src/**/*.ts', '!tests/**/*.ts', '!tests/**/*.json', '!tools/**/*.ts', '!bunfig.toml', '!tsconfig.json', '!*.ts', '!*.mjs', '!sst/**/*.ts'], // Only include source and test files in the mutation testing process. LOAD-BEARING breadth: these patterns must stay BROADER than any --mutate scope (incl. the CI bootstrap shards) — the incremental differ preserves out-of-scope baseline entries only for files it can still read; narrow this and out-of-scope files look deleted, silently discarding their cached verdicts (degrades to re-execution, not unsoundness).
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

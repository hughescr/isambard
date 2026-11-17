import config, { bunTest, root } from '@hughescr/oxlint-config-default';
import { defineConfig } from 'oxlint';
import boundaries from './boundaries.config.mjs';

/**
 * Oxlint configuration: @hughescr/oxlint-config-default plus Isambard's own policy.
 *
 * Project lint policy (see GitHub issue #187):
 * - `no-restricted-syntax` selectors are ast-grep rules now, run by `bun run check:ast-grep`: the generic
 *   bans (no-silent-catch-undefined, no-test-*) ship in the shared package's ast-grep/ directory;
 *   Isambard's own rules are in .ast-grep/.
 * - package.json is still linted by ESLint (eslint.package-json.config.mjs).
 * - Rule ids of leftover ESLint plugins are aliased (`eslint-core/…`, `unicorn-js/…`, `import-x-js/…`,
 *   `n-js/…`, `jest-js/…`); a disable comment must name the alias to suppress them.
 *
 * Run with Node, never Bun (see `bun run lint`): Bun truncates large piped output (#188). The layer
 * rules come from boundaries.config.mjs and resolve against its own `root`, so any working directory
 * gives the same findings; `bun run lint` runs from the repo root, where the Oxlint config and the
 * ESLint `package.json` check are found.
 */

const boundariesOrderOptions = {
    groups:                        ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
    // bun:* is a builtin under Bun but classified as external under Node; pin it to builtin.
    pathGroups:                    [{ pattern: 'bun:*', group: 'builtin' }],
    pathGroupsExcludedImportTypes: [],
    'newlines-between':            'never',
    alphabetize:                   { order: 'asc', caseInsensitive: true },
};

const discordFenceMessage = 'Discord client/UI code lives in src/integrations/discord or src/app; take wire types from discord-api-types/v10 (#40).';
const lodashPath = { name: 'lodash', message: 'Use lodash-es instead for proper ESM tree-shaking.' };

export default defineConfig({
    // Root-only fields (`env`, base `settings`) do not inherit through `extends`; the shared package's `root` carries them.
    ...root,
    'extends': [config, bunTest, boundaries],

    // Oxlint does not inherit `settings` from extended configs, so the bunTest settings are merged here.
    // The boundaries fragment carries its policy as rule options and adds no settings.
    settings: {
        ...root.settings,
        ...bunTest.settings,
    },

    ignorePatterns: [
        'scratch/', // Izzy's work area
        'running/', // Running worktree

        'dist/',
        'node_modules/',

        '.stryker-tmp/',
        'reports/',

        '.serena/',

        '.claude/',

        '.sst/',
        'sst/',
        'sst.config.ts',
        'sst-env.d.ts',
    ],
    rules: {
        // The generic config's Node resolver cannot follow Bun's extensionless TS imports and aliases.
        'n-js/no-missing-import':     'off',
        'n-js/no-unpublished-import': 'off',
    },
    overrides: [
        {
            // tools/**/*.ts are dev/ops CLIs (backfills, the mutation-directive checker), never shipped
            // runtime code — same category as scripts/**, which the base config already allows.
            files: ['tools/**/*.ts'],
            rules: {
                'import-x-js/no-extraneous-dependencies': ['error', { devDependencies: ['tools/**'] }],
            },
        },
        {
            files: ['boundaries.config.mjs', 'eslint.package-json.config.mjs', 'oxlint.config.ts', 'stryker.conf.mjs'],
            rules: {
                'import-x-js/no-extraneous-dependencies': ['error', {
                    devDependencies: ['boundaries.config.mjs', 'eslint.package-json.config.mjs', 'oxlint.config.ts', 'stryker.conf.mjs'],
                }],
            },
        },
        {
            files: ['src/**/*.ts', 'src/**/*.tsx'],
            rules: {
                // #40 Discord fence: discord.js and @discordjs/* are the Discord client/UI library, so
                // only the Discord layer (src/integrations/discord) and the composition root (src/app)
                // may import them. Everything else takes Discord wire types from discord-api-types/v10,
                // which is deliberately NOT fenced — it is the wire format, not the client (#49).
                // The one exemption is src/agent/discord-mcp-server.ts, the honestly named Discord MCP
                // adapter that src/agent hosts by convention; it carries a single disable comment
                // rather than an ignore entry so the exemption is visible at the import.
                'no-restricted-imports': ['error', {
                    paths: [
                        lodashPath,
                        { name: 'discord.js', message: discordFenceMessage },
                    ],
                    patterns: [{ group: ['@discordjs/*'], message: discordFenceMessage }],
                }],

                'import-x-js/order': ['warn', boundariesOrderOptions],

                // Prefer ?? over || when the left-hand side could be null/undefined
                // (|| swallows 0, '', false which are legitimate values).
                'typescript/prefer-nullish-coalescing': 'error',

                // Bans throwing non-Error values (strings, numbers, plain objects).
                'typescript/only-throw-error': 'error',
            },
        },
        {
            // Discord and the composition root may import discord.js; only the generic lodash ban applies.
            files: ['src/integrations/discord/**/*.ts', 'src/integrations/discord/**/*.tsx', 'src/app/**/*.ts', 'src/app/**/*.tsx'],
            rules: {
                'no-restricted-imports': ['warn', { paths: [lodashPath] }],
            },
        },
        {
            files: ['tests/**/*.ts'],
            rules: {
                // Bun's expect().rejects is thenable at runtime but types don't declare PromiseLike.
                'typescript/await-thenable':               'off',
                // bun-types declares matcher methods as returning `void` even under `.rejects`/`.resolves`,
                // where awaiting them is required (see commit 7deb751).
                'typescript/no-confusing-void-expression': 'off',

                'import-x-js/order': ['warn', boundariesOrderOptions],

                // eslint-plugin-jest rules, for every file under tests/ (bunTest covers only *.test.* files).
                'jest-js/prefer-hooks-on-top':  'error',
                'jest/prefer-hooks-in-order':   'error',
                'jest-js/no-duplicate-hooks':   'error',
                'jest-js/no-standalone-expect': 'error',
                // Custom helper allowlist: expectOk/expectDenied (host-guard.test.ts) and
                // assertValidTruncation (browser-mcp-server.test.ts) each call expect() internally
                // but live in the same file, so the rule must be told to treat them as assertions.
                'jest-js/expect-expect':        ['error', {
                    assertFunctionNames: ['expect', 'expectOk', 'expectDenied', 'assertValidTruncation'],
                }],
                'jest-js/no-focused-tests':    'error',
                'jest-js/no-disabled-tests':   'error',
                'jest/no-commented-out-tests': 'error',
                'jest-js/no-done-callback':    'error',
                'jest/prefer-spy-on':          'warn',
                'jest/prefer-jest-mocked':     'warn',

                // Mocks imported from tests/setup must have their reset helper called in afterEach.
                '@hughescr/test-hygiene/require-mock-reset': ['error', {
                    mocks: {
                        mockFsPromises:  ['resetMockFs', 'resetMockFsPrefix'],
                        mockSstResource: ['resetMockSstResource'],
                        mockHeicConvert: ['resetHeicConvertImpl'],
                    },
                }],
            },
        },
    ],
});

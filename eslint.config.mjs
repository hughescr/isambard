import config from '@hughescr/eslint-config-default';
import moduleBoundariesPlugin from '@hughescr/eslint-plugin-module-boundaries';
import testHygienePlugin from '@hughescr/eslint-plugin-test-hygiene';
import jestPlugin from 'eslint-plugin-jest';
import { boundariesConfig, boundaryElements } from './eslint-boundaries.config.mjs';

/**
 * ESLint Configuration with Architectural Boundaries
 *
 * Boundary Philosophy:
 * - Enforce clean separation of concerns across the codebase
 * - Prevent circular dependencies and tight coupling
 * - Make architectural violations visible during development
 * - Rules represent the IDEAL architecture; violations are tracked with eslint-disable comments
 *   rather than weakening the rules to allow current coupling
 *
 * Module Hierarchy (from independent to dependent):
 * 1. utils      - Pure utilities, no domain knowledge
 * 2. errors     - Error types, minimal dependencies
 * 3. config     - Configuration loading, minimal dependencies
 * 4. storage    - Data layer, independent of application/agent
 * 5. agent      - Platform-agnostic AI agent logic
 * 6. discord    - Discord integration, depends on agent
 *    email      - Email integration, depends on agent
 * 7. app        - Composition root (src/index.ts + src/app/**), wires everything together
 */
const eslintConfig = [
    ...config,
    {
        ignores: [
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
            'sst-env.d.ts'
        ]
    },
    {
        rules: {
            'n/no-missing-import':     'off',
            'n/no-unpublished-import': 'off',
        }
    },
    {
        // tools/**/*.ts are dev/ops CLIs (backfills, the mutation-directive checker), never shipped
        // runtime code — same category as scripts/**, which the base config already allows.
        files: ['tools/**/*.ts'],
        rules: {
            'import-x/no-extraneous-dependencies': ['error', { devDependencies: ['tools/**'] }],
        },
    },
    {
        files: ['eslint.config.mjs', 'eslint-boundaries.config.mjs', 'stryker.conf.mjs'],
        rules: {
            'import-x/no-extraneous-dependencies': ['error', {
                devDependencies: ['eslint.config.mjs', 'eslint-boundaries.config.mjs', 'stryker.conf.mjs'],
            }],
        },
    },
    boundariesConfig,
    {
        // #40 Discord fence: discord.js and @discordjs/* are the Discord client/UI library, so
        // only the Discord layer (src/integrations/discord) and the composition root (src/app)
        // may import them. Everything else takes Discord wire types from discord-api-types/v10,
        // which is deliberately NOT fenced — it is the wire format, not the client (#49).
        // The one exemption is src/agent/discord-mcp-server.ts, the honestly named Discord MCP
        // adapter that src/agent hosts by convention; it carries a single eslint-disable
        // comment rather than an `ignores` entry so the exemption is visible at the import.
        // Tests are outside this block's `files` and so are exempt.
        //
        // Flat config REPLACES (not merges) a rule's options across matching entries for the
        // same file, so this re-states the base config's lodash restriction
        // (@hughescr/eslint-config-default) alongside the fence rather than silently dropping
        // it for every file under src/.
        files:   ['src/**/*.ts'],
        ignores: ['src/integrations/discord/**', 'src/app/**'],
        rules:   {
            'no-restricted-imports': ['error', {
                paths: [
                    { name: 'lodash', message: 'Use lodash-es instead for proper ESM tree-shaking.' },
                    { name: 'discord.js', message: 'Discord client/UI code lives in src/integrations/discord or src/app; take wire types from discord-api-types/v10 (#40).' },
                ],
                patterns: [
                    {
                        group:   ['@discordjs/*'],
                        message: 'Discord client/UI code lives in src/integrations/discord or src/app; take wire types from discord-api-types/v10 (#40).',
                    },
                ],
            }],
        },
    },
    {
        files:           ['src/**/*.ts', 'src/**/*.tsx'],
        languageOptions: {
            parserOptions: {
                projectService:  false,
                project:         './tsconfig.src.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: {
            '@hughescr/module-boundaries': moduleBoundariesPlugin,
        },
        rules: {
            '@hughescr/module-boundaries/no-cross-module-internal':       ['error', { modules: boundaryElements }],
            '@hughescr/module-boundaries/no-internal-in-barrel':          'error',
            '@hughescr/module-boundaries/no-star-export-from-non-barrel': 'error',

            // Base config's import-x/order leaves pathGroupsExcludedImportTypes at its plugin
            // default (['builtin', 'external', 'object']), which always skips pathGroups for
            // anything already classified builtin/external — so it can never pin `bun:*`
            // consistently: import-x classifies `bun:sqlite` as builtin under Bun's own
            // module list but external under Node's, so `bun:*` vs `node:*` order flipped
            // between `bun --bun eslint` and plain `node eslint` on the same source. Clearing
            // pathGroupsExcludedImportTypes lets the pathGroups match apply regardless of the
            // runtime-dependent classification, pinning `bun:*` to the builtin group under both.
            'import-x/order': ['warn', {
                groups:                        ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
                pathGroups:                    [{ pattern: 'bun:*', group: 'builtin' }],
                pathGroupsExcludedImportTypes: [],
                'newlines-between':            'never',
                alphabetize:                   { order: 'asc', caseInsensitive: true },
            }],

            // Prefer ?? over || when the left-hand side could be null/undefined
            // (|| swallows 0, '', false which are legitimate values).
            // Exception: use eslint-disable when '' should map to undefined (e.g. name || undefined).
            '@typescript-eslint/prefer-nullish-coalescing': 'error',

            // Bans throwing non-Error values (strings, numbers, plain objects).
            // throw new Error('...') is still allowed by this rule — requiring IsambardError
            // specifically is a stricter convention enforced by code review, not lint.
            // Tests are exempt (see base config test overrides which keep this off for test files).
            '@typescript-eslint/only-throw-error': 'error',

            // Ban empty catch blocks in production code — every caught error must be logged
            // or explicitly re-thrown. Add eslint-disable-next-line with a reason when a
            // truly comment-only catch is legitimately intentional (e.g. best-effort shutdown).
            'no-empty': ['error', { allowEmptyCatch: false }],

            // Ban `.catch(() => undefined)` — silent promise error swallowing.
            // Use `.catch((err) => { logger.warn({ err }, '...'); })` instead.
            'no-restricted-syntax': [
                'error',
                {
                    selector: "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression > Identifier.body[name='undefined']",
                    message:  "Silent .catch(() => undefined) swallows errors. Use .catch((err) => { logger.warn({ err }, '...'); }) instead.",
                },
            ],
        }
    },
    {
        files:   ['tests/**/*.ts'],
        plugins: {
            jest:                     jestPlugin,
            '@hughescr/test-hygiene': testHygienePlugin,
        },
        settings: {
            jest: {
                // Tell eslint-plugin-jest that bun:test is the test framework import source.
                // Without this, the plugin defaults to '@jest/globals' and silently ignores
                // all `it`/`test` calls imported from 'bun:test', making rules like
                // jest/expect-expect, jest/no-focused-tests etc. inert.
                globalPackage: 'bun:test',
            },
        },
        rules: {
            // Bun's expect().rejects is thenable at runtime but types don't declare PromiseLike
            '@typescript-eslint/await-thenable':               'off',
            // bun-types declares matcher methods (toThrow, toBeInstanceOf, etc.) as returning
            // `void`, even under `.rejects`/`.resolves` where they are actually async at runtime
            // (see await-thenable override above). `no-confusing-void-expression` has no option
            // that exempts a void-typed expression used as the operand of `await` — every
            // ancestor branch it special-cases (arrow shorthand, void operator, return statement)
            // is inapplicable here, so `await expect(p).rejects.toThrow(x)` is flagged as if the
            // void value were misused, when awaiting it is in fact required: leaving the
            // assertion unawaited lets the test finish before the rejection settles, so a failed
            // expectation can report AFTER the test body returns (bun then reports an anonymous
            // "1 tests failed") — see commit 7deb751 for the mechanism. Disabled for test files
            // only; production code has no reason to await a void-returning call.
            '@typescript-eslint/no-confusing-void-expression': 'off',
            // bun:* is a builtin under Bun but classified as external under Node; force it to builtin
            'import-x/order':                                  ['warn', {
                groups:                        ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
                pathGroups:                    [{ pattern: 'bun:*', group: 'builtin' }],
                pathGroupsExcludedImportTypes: [],
                'newlines-between':            'never',
                alphabetize:                   { order: 'asc', caseInsensitive: true },
            }],

            // ── Phase 1: ban real-timer primitives in tests ──────────────────────────
            // Real timers make tests slow (each macrotask ≥1ms). Use jest.useFakeTimers()
            // and jest.advanceTimersByTime() instead.
            'no-restricted-syntax': [
                'error',
                {
                    selector: "CallExpression[callee.name='setTimeout']",
                    message:  "Don't use real setTimeout in tests — use jest.useFakeTimers() + jest.advanceTimersByTime().",
                },
                {
                    selector: "CallExpression[callee.name='setInterval']",
                    message:  "Don't use real setInterval in tests — use jest.useFakeTimers() + jest.advanceTimersByTime().",
                },
                {
                    selector: "CallExpression[callee.name='setImmediate']",
                    message:  "Don't use real setImmediate in tests — use await Promise.resolve() for microtask flushing.",
                },
                {
                    selector: "CallExpression[callee.name='queueMicrotask']",
                    message:  "Don't use queueMicrotask in tests — use await Promise.resolve() for microtask flushing.",
                },
                {
                    selector: "MemberExpression[object.name='process'][property.name='nextTick']",
                    message:  "Don't use process.nextTick in tests — use await Promise.resolve() for microtask flushing.",
                },
                {
                    // Catches new Promise(r => setTimeout(r, N)) — the microtask-flush anti-pattern
                    selector: "NewExpression[callee.name='Promise'] CallExpression[callee.name='setTimeout']",
                    message:  "Don't wrap setTimeout in a Promise in tests — use await Promise.resolve() for microtask flushing or jest.useFakeTimers() + jest.advanceTimersByTime() for real delays.",
                },
                {
                    // Dynamic await import() inside test bodies — expensive (~50ms) per invocation
                    selector: 'AwaitExpression > ImportExpression',
                    message:  "Don't use dynamic await import() in tests — use static imports at file scope and spyOn() to override module exports.",
                },
            ],

            // ── Phase 2: eslint-plugin-jest rules ────────────────────────────────────
            // Hook-ordering and structure rules
            'jest/prefer-hooks-on-top':   'error',
            'jest/prefer-hooks-in-order': 'error',
            'jest/no-duplicate-hooks':    'error',
            // Setup code must live in hooks, not bare in describe bodies.
            // Disabled: 569 existing violations across test files — the project uses
            // module-level mock setup (mock.module, Object.assign on mocks) that this rule
            // cannot accommodate. Requires a separate refactoring campaign.
            // 'jest/require-hook': 'error',
            // Expect correctness
            'jest/no-standalone-expect':  'error',
            // Require at least one assertion in every test body.
            // Custom helper allowlist: expectOk/expectDenied (host-guard.test.ts) and
            // assertValidTruncation (browser-mcp-server.test.ts) each call expect() internally
            // but live in the same file, so the rule must be told to treat them as assertions.
            'jest/expect-expect':         ['error', {
                assertFunctionNames: [
                    'expect',
                    'expectOk',
                    'expectDenied',
                    'assertValidTruncation',
                ],
            }],
            // Disabled: 390 existing violations across test files — the project uses
            // `if (!result.ok) { expect(result.reason)... }` TypeScript type-narrowing patterns
            // throughout. Fixing those requires a separate campaign to restructure expect calls.
            // This rule was silently off before jest.globalPackage was corrected.
            // 'jest/no-conditional-expect': 'error',
            // Test hygiene
            'jest/no-focused-tests':       'error',
            'jest/no-disabled-tests':      'error',
            'jest/no-commented-out-tests': 'error',
            // Anti-pattern: done callback (CLAUDE.md anti-pattern #4)
            'jest/no-done-callback':       'error',
            // Prefer jest.spyOn over manual mock assignment
            'jest/prefer-spy-on':          'warn',
            // Prefer jest.mocked() type helper over manual `as jest.Mock` casts
            'jest/prefer-jest-mocked':     'warn',

            // ── Phase 3: custom hygiene rules ────────────────────────────────────────
            // Ban mock.module() outside tests/setup.ts — it is global and order-dependent
            '@hughescr/test-hygiene/no-mock-module-in-test-body': 'error',
            // Every useFakeTimers() in a hook or test body must have matching useRealTimers()
            '@hughescr/test-hygiene/require-fake-timers-cleanup': 'error',
            // Mocks imported from tests/setup must have their reset helper called in afterEach
            '@hughescr/test-hygiene/require-mock-reset':          ['error', {
                mocks: {
                    mockFsPromises:  ['resetMockFs', 'resetMockFsPrefix'],
                    mockSstResource: ['resetMockSstResource'],
                    mockHeicConvert: ['resetHeicConvertImpl'],
                },
            }],
            // Every spyOn() must be paired with restoreAllMocks() or mockRestore() in afterEach
            '@hughescr/test-hygiene/require-mock-cleanup': 'error',
        },
    }
];

export default eslintConfig;

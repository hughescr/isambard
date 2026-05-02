// eslint-disable-next-line import-x/no-extraneous-dependencies -- dev-only config file uses devDependencies
import config from '@hughescr/eslint-config-default';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- dev-only config file uses devDependencies
import moduleBoundariesPlugin from '@hughescr/eslint-plugin-module-boundaries';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- dev-only config file uses devDependencies
import testHygienePlugin from '@hughescr/eslint-plugin-test-hygiene';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- dev-only config file uses devDependencies
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
    boundariesConfig,
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
            '@typescript-eslint/await-thenable': 'off',
            // bun:* is a builtin under Bun but classified as external under Node; force it to builtin
            'import-x/order':                    ['warn', {
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

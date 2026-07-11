# Isambard Development Instructions

## Project Overview
Isambard is a self-improving agentic thought partner using Claude Agent SDK, TypeScript, and Bun.

## Hands-Off Directories
- **`running/`** — live deployment directory. Only Craig merges and deploys here. Never edit.
- **`scratch/`** and **`scratch/izzy-codebase/`** — live runtime working directory for Izzy, with its own separate git repo. Only Craig and Izzy manage files there. Never edit from this repo. Note: Izzy's `process.cwd()` is `scratch/` at runtime, so relative-path config defaults resolve inside it.

Production code goes in `src/`, tests in `tests/`, both git-tracked at the repo root.

## Development Workflow

### TDD Mandate (RED-GREEN-REFACTOR)
1. **RED**: Write a failing test first
2. **GREEN**: Write minimal code to pass the test
3. **REFACTOR**: Clean up while keeping tests green

Never write production code without a failing test. Tests are not optional.

### Quality Gates
Before any PR or commit:
- [ ] All tests pass (`bun test`)
- [ ] Zero TypeScript errors (`bun run typecheck`)
- [ ] Zero lint warnings (`bun run lint`)
- [ ] Mutation score = 100% (`bun mutate` — incremental over the full mutate glob, so only mutants your change affects re-execute; not `bun run mutate` or `npx stryker`. `reports/stryker-incremental.json` is sandbox-protected; use `dangerouslyDisableSandbox: true`.)

### Test Performance Anti-Patterns
Since Stryker runs each test potentially hundreds of times, even small per-test overhead compounds dramatically. Every test should target <1ms execution. Avoid these patterns:

1. **Real wall-clock delays** — Never use `Date.now()` elapsed time assertions or `setTimeout` with real timers in tests. Always use `jest.useFakeTimers()` + `jest.advanceTimersByTime()`. *(enforced by ESLint: `no-restricted-syntax` bans `setTimeout`/`setInterval` in test files)*
2. **`setTimeout(resolve, 0)` for microtask flushing** — Use `await Promise.resolve()` instead (nanoseconds vs 1-4ms macrotask minimum). *(enforced indirectly: `setTimeout` and `new Promise(r => setTimeout(r, N))` are both banned by `no-restricted-syntax`)*
3. **Dynamic `await import()` per test** — Import modules once at file scope with `import * as mod from '...'`, then `spyOn(mod, 'fn')` in each test. Dynamic imports trigger ESM re-evaluation (~50ms each). *(enforced by ESLint: `no-restricted-syntax` bans `AwaitExpression > ImportExpression` in test files)*
4. **`done` callback + real `setTimeout`** — Use fake timers: `jest.advanceTimersByTime(N)` instead of waiting real milliseconds. *(enforced by ESLint: `jest/no-done-callback` plus the `setTimeout` ban)*
5. **Real delays in mock implementations** — Mock implementations should resolve immediately (`async () => 'result'`), not `await new Promise(r => setTimeout(r, 10))`. *(not statically lint-enforced; rely on code review)*
6. **Unawaited `.rejects`/`.resolves` assertions** — always `await` them. Left unawaited, the assertion races its own rejection chain past the end of the test: a losing race lets the test body return before a failed expectation reports, which Bun then surfaces as an anonymous `1 tests failed:` with no test name, and the still-settling promise chain can bleed mutation coverage into whichever test runs next. *(bun-types declares `.rejects`/`.resolves` matcher methods as returning `void` even though they're thenable at runtime, so `await`-ing one trips `@typescript-eslint/no-confusing-void-expression`; that rule (alongside the existing `@typescript-eslint/await-thenable: 'off'` override for the same reason) is turned off for `tests/**/*.ts` in `eslint.config.mjs` to unblock the required `await`.)*

### Test Hygiene Enforcement
Mechanized via ESLint (sources: `~/code/hughescr/eslint-plugin-test-hygiene`, `~/code/hughescr/eslint-plugin-module-boundaries`).

- `@hughescr/test-hygiene/require-fake-timers-cleanup` — pair every `jest.useFakeTimers()` with `jest.useRealTimers()` in cleanup
- `@hughescr/test-hygiene/require-mock-cleanup` — pair every `jest.spyOn()` with `jest.restoreAllMocks()`/`mockRestore()` in `afterEach`
- `@hughescr/test-hygiene/require-mock-reset` — call configured reset helpers for setup-module mocks in `afterEach`
- `@hughescr/test-hygiene/no-mock-module-in-test-body` — `mock.module()` only in `tests/setup.ts`, never in describe/it
- `@hughescr/module-boundaries/no-internal-in-barrel` — barrel `index.ts` must not re-export `@internal` symbols
- `@hughescr/module-boundaries/no-cross-module-internal` — production code must not import `@internal` from another module
- `@hughescr/module-boundaries/no-star-export-from-non-barrel` — barrel `index.ts` must not `export *` from a non-barrel file (`export *` between barrels is allowed)
- `eslint-plugin-jest` — hook ordering, no-done-callback, no-focused-tests, expect correctness

**Bypass**: `// eslint-disable-next-line <rule-name> -- <specific reason>` (description after `--` required by `eslint-comments/require-description`).

**Intentionally disabled**: `jest/require-hook` — conflicts with the module-level `mock.module()` setup pattern. See `eslint.config.mjs`.

### Self-Modification Protocol
Isambard can propose improvements to its own code:
1. Changes are submitted as PRs
2. All PRs require human approval
3. CI must pass before merge
4. No direct commits to main

## Architecture
See [../docs/architecture.md](../docs/architecture.md) for the subsystem map and key patterns. Read it on demand when you need orientation — don't trust it blindly; verify file paths against the source.

## Roadmaps
- [Short-term (Weeks 1-2)](../roadmaps/short-term.md)
- [Mid-term (Weeks 3-8)](../roadmaps/mid-term.md)
- [Long-term (Months 3+)](../roadmaps/long-term.md)

## Commands
```bash
bun run dev:sst      # Development with SST shell and hot reload
bun run dev:docker   # Full stack with DynamoDB containers
bun test             # Run tests
bun run mutate       # Mutation testing
bun run lint         # Check linting
bun run typecheck    # TypeScript validation
bun run backfill:contact-lookup-gsi2  # Backfill GSI2 keys on existing CONTACT_LOOKUP rows
```

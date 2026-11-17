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
- [ ] All tests pass (`bun run test`)
- [ ] Zero TypeScript errors (`bun run typecheck`)
- [ ] Zero lint warnings and zero ast-grep findings (`bun run lint` runs Oxlint, the package.json ESLint check, the ast-grep scan and the Stryker directive check)
- [ ] Mutation score = 100% (`bun mutate` — incremental over the full mutate glob, so only mutants your change affects re-execute; not `bun run mutate` or `npx stryker`. `reports/stryker-incremental.json` is sandbox-protected; use `dangerouslyDisableSandbox: true`.)

### Test Performance Anti-Patterns
Since Stryker runs each test potentially hundreds of times, even small per-test overhead compounds dramatically. Every test should target <1ms execution. Avoid these patterns:

1. **Real wall-clock delays** — Never use `Date.now()` elapsed time assertions or `setTimeout` with real timers in tests. Always use `jest.useFakeTimers()` + `jest.advanceTimersByTime()`. *(setTimeout/setInterval enforced by ast-grep: `no-test-set-timeout`, `no-test-set-interval`; `Bun.sleep` by `no-test-bun-sleep`. `Date.now()` elapsed-time assertions are not statically enforced; rely on code review.)*
2. **`setTimeout(resolve, 0)` for microtask flushing** — Use `await Promise.resolve()` instead (nanoseconds vs 1-4ms macrotask minimum). *(enforced by ast-grep: `no-test-set-timeout` and `no-test-promise-wrapped-set-timeout`, plus `no-test-set-immediate`, `no-test-process-next-tick` and `no-test-queue-microtask` for the other macrotask/microtask-queue shortcuts)*
3. **Dynamic `await import()` per test** — Import modules once at file scope with `import * as mod from '...'`, then `spyOn(mod, 'fn')` in each test. Dynamic imports trigger ESM re-evaluation (~50ms each). *(enforced by ast-grep: `no-test-dynamic-await-import`)*
4. **`done` callback + real `setTimeout`** — Use fake timers: `jest.advanceTimersByTime(N)` instead of waiting real milliseconds. *(enforced by Oxlint `jest-js/no-done-callback` plus ast-grep `no-test-set-timeout`)*
5. **Real delays in mock implementations** — Mock implementations should resolve immediately (`async () => 'result'`), not `await new Promise(r => setTimeout(r, 10))`. *(the `setTimeout` form is caught by `no-test-set-timeout` and `no-test-promise-wrapped-set-timeout`; other delay mechanisms are not statically enforced, rely on code review)*
6. **Unawaited `.rejects`/`.resolves` assertions** — always `await` them. Left unawaited, the assertion races its own rejection chain past the end of the test: a losing race lets the test body return before a failed expectation reports, which Bun then surfaces as an anonymous `1 tests failed:` with no test name, and the still-settling promise chain can bleed mutation coverage into whichever test runs next. *(bun-types declares `.rejects`/`.resolves` matcher methods as returning `void` even though they're thenable at runtime, so `await`-ing one trips `typescript/no-confusing-void-expression`; that rule (alongside `typescript/await-thenable`) is turned off for `tests/**/*.ts` in `oxlint.config.ts` to unblock the required `await`.)*

### Test Hygiene Enforcement
Mechanized via Oxlint (`oxlint.config.ts`, extending the published `@hughescr/oxlint-config-default`, its `bunTest` export and the `boundaries.config.mjs` policy fragment; JS-plugin sources: `~/code/hughescr/eslint-plugin-test-hygiene`, `~/code/hughescr/oxlint-plugin-module-boundaries`) and ast-grep (`sgconfig.yml` loads Isambard's `.ast-grep/*.yml` plus the shared package's `ast-grep/` rules; run by `bun run check:ast-grep`). ESLint remains only for `package.json` (`eslint.package-json.config.mjs`).

- `@hughescr/test-hygiene/require-fake-timers-cleanup` — pair every `jest.useFakeTimers()` with `jest.useRealTimers()` in cleanup
- `@hughescr/test-hygiene/require-mock-cleanup` — pair every `jest.spyOn()` with `jest.restoreAllMocks()`/`mockRestore()` in `afterEach`
- `@hughescr/test-hygiene/require-mock-reset` — call configured reset helpers for setup-module mocks in `afterEach` (options in `oxlint.config.ts`)
- `@hughescr/test-hygiene/no-mock-module-in-test-body` — `mock.module()` only in `tests/setup.ts`, never in describe/it
- `@hughescr/module-boundaries/no-internal-in-barrel` — barrel `index.ts` must not re-export `@internal` symbols
- `@hughescr/module-boundaries/no-cross-module-internal` — production code must not import `@internal` from another module (modules come from `boundaries.config.mjs`)
- `@hughescr/module-boundaries/no-star-export-from-non-barrel` — barrel `index.ts` must not `export *` from a non-barrel file (`export *` between barrels is allowed)
- `@hughescr/module-boundaries/dependencies` (policy in `boundaries.config.mjs`, built with `defineBoundaries` from `@hughescr/oxlint-config-default`) — layered import allow-list, barrel-only entry into each module, and every file under `src/` belonging to a module; `no-restricted-imports` carries the #40 Discord fence
- eslint-plugin-jest rules (hook ordering, no-done-callback, no-focused-tests, expect correctness), under the `jest-js/` alias where Oxlint has a native `jest/` namesake
- ast-grep syntax bans (each rule id is the name to use in an ignore comment): Isambard's `.ast-grep/` owns `no-foreach-async`, `no-throw-new-error`, `no-raw-console`, `no-process-env-outside-config`, `no-unwrapped-json-parse`, `no-optional-chain-non-null-assertion`, `no-as-branded-type`, `no-module-level-let-in-mcp-servers`, `require-comment-on-double-cast`, `directive-no-whole-file-disable-in-src`; the shared package owns `no-test-*`, `no-silent-catch-undefined`, the five directive/disable rules below, the `sonar-*` ports and the `security-*` literal tripwires. Shared rules (and the project directive rule) use the base id in `.ts`, `<id>-javascript` in JS/JSX/`.mjs`, `<id>-tsx` in TSX; suppress with the matching variant id.

**Bypass**:
- Oxlint rules: `// eslint-disable-next-line <rule-name> -- <specific reason>` (Oxlint honours the ESLint syntax). Leftover ESLint-plugin rules are loaded under aliases and must be suppressed by the alias: `eslint-core/…`, `unicorn-js/…`, `import-x-js/…`, `n-js/…`, `jest-js/…`. Unused disable directives are warnings, which `--deny-warnings` fails, so delete a directive once it stops being needed.
- Directive policy (ast-grep `eslint-disable-bare`, `eslint-disable-needs-description`, `directive-block-disable-not-at-top`, `directive-no-enable`, `directive-no-inline-config`, `directive-no-whole-file-disable-in-src`): `disable-next-line`/`disable-line` anywhere, each with a rule list and ` -- <reason>`; a block `eslint-disable`/`oxlint-disable` only at the very top of a file (before any code) and never under `src/`; no `eslint-enable`/`oxlint-enable`; no inline `eslint`/`global`/`globals`/`exported`/`eslint-env` config comments. Both `/* */` and `//` forms are checked. A next-line disable under a whole-file disable is not flagged as redundant.
- ast-grep rules: `// ast-grep-ignore: <rule-id> -- <specific reason>` directly above the offending line (for example `// ast-grep-ignore: no-test-dynamic-await-import -- query makes this a fresh in-process entrypoint evaluation.`).

**Intentionally not enabled**: `jest/require-hook` — conflicts with the module-level `mock.module()` setup pattern. There is no `no-restricted-syntax` for syntax bans; those are ast-grep rules.

### Session Architecture Rules
- `src/agent/session/` (the conductor, ledger, journal, envelope builders) stays mutation-measured at 100% like everything else — never add a `// Stryker disable all` region there to sidestep the gate.
- Any new session open path (a new conductor role, a new way of calling `Conductor.open()`/`submit()`) must be verified against the real Claude Agent SDK CLI, not only against the test fakes, before it ships: with a streaming-input prompt the SDK emits nothing at all — not even the `system/init` frame carrying the session id — until it has read a first user message, so a silent/empty open never resolves against the real SDK even though a fake happily returns. This is the `[BOOT]` handshake lesson (found the hard way on the first production conductor start, 2026-09-06); `src/agent/session/index.ts`'s handshake envelope is the fix, and any future session-open path needs the same real-SDK check, not just green fakes.

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
bun run test         # Run tests
bun mutate           # Mutation testing (incremental; see Quality Gates)
bun run lint         # Oxlint (node, type-aware, --deny-warnings) + ESLint on package.json + ast-grep scan + Stryker directive check
bun run lint:fix     # Oxlint --fix + ESLint --fix on package.json
bun run lint:overview # Same checks as lint, with Oxlint's grouped output for triage
bun run check:ast-grep # ast-grep syntax bans (.ast-grep/ plus the shared package's rules, via sgconfig.yml)
bun run typecheck    # TypeScript validation (root tsconfig.json, then src/tsconfig.json)
bun run backfill:contact-lookup-gsi2  # Backfill GSI2 keys on existing CONTACT_LOOKUP rows
```

- Oxlint runs under Node (`node node_modules/oxlint/bin/oxlint`), never Bun (Bun truncates large piped output; #188 tracks the return). `bun run lint` runs from the repo root; the boundaries rules resolve against the `root` in `boundaries.config.mjs`, so their findings do not depend on the working directory.
- Type-aware rules (tsrs) use the nearest `tsconfig.json` to each file: `src/` against `src/tsconfig.json`, everything else against the root one.

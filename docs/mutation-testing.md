# Mutation Testing: Gate vs Discovery

Two `stryker.conf.mjs` runs share one config and one incremental cache but differ in whether the LLM mutator is allowed to propose new mutants.

## The two commands

| Command | LLM mutator | Use |
|---|---|---|
| `bun mutate` (`bun run mutate`) / `bun run mutate:wait` | **Frozen** — cache-only, no new proposals | The commit/CI gate. Deterministic: the same source tree always yields the same mutant set, so the gate converges instead of chasing a moving target. |
| `bun run mutate:discover` / `bun run mutate:discover:wait` | **Unfrozen** — proposes new mutants within a per-run budget ($5 / 500 new functions) | Grows the cached mutant set. Run manually, and automatically after Craig promotes `develop` onto `running` (a consequence of promotion, not a gate on it — promotion itself never waits on discovery). |

Both go through `tools/run-stryker.sh`, which holds the file lock on `reports/.stryker.lock` so a discovery run and a gate run never corrupt the incremental cache by racing each other; `--wait` blocks for the lock instead of failing fast. `mutate:discover` sets `MUTATE_DISCOVER=1`, which `stryker.conf.mjs` reads as `frozen: !process.env.MUTATE_DISCOVER` — the frozen flag is the only difference between the two paths.

Cached functions cost nothing in either mode: a function whose fingerprint is already in `.stryker-llm-cache` is replayed for free regardless of which command is running. The budget in `mutate:discover` is spent only on functions that are new or have changed since their last proposal — that's what "discovery" grows.

## Why generation is frozen at the gate

The mutator used to key its cache on the verbatim function text sent in the prompt, and select which functions to propose for by a top-N-per-run risk window. Both were unstable across runs: adding a `// Stryker disable` comment or reformatting a function invalidated its cache entry even though its behavior hadn't changed, and the top-500 window slid on every invocation as other files' risk scores shifted — so a clean gate run could still spend budget re-proposing mutants for code nobody touched, and could still turn up a "new" survivor with no corresponding diff to blame. Freezing the gate removes both sources of drift: it never proposes, so it can never re-key or re-window anything, and a red gate always traces to an actual change in the diff.

## Cache keying and migration

`.stryker-llm-cache` is keyed by a structural AST fingerprint (comments, whitespace, and literal spelling ignored; identifiers, literal values, operators, and tree shape kept) computed by `@hughescr/stryker-llm-mutator` — requires the release that ships fingerprint-keyed caching (post-1.2.1; check the installed version against that plugin's changelog before assuming this applies). Upgrading across that boundary requires a one-time cache migration with the plugin's own `scripts/migrate-cache-fingerprint.ts`, run once against `.stryker-llm-cache` after the `bun.lock` bump — skipping it leaves every cached entry keyed the old way, so `mutate:discover` treats every function as new and re-spends its whole budget re-discovering mutants it already had.

## Related gates

- **Directive placement**: `bun run lint` runs `tools/stryker-directive-check.ts`, which enforces where a `// Stryker disable` comment may legally sit; a misplaced directive is a lint failure, not a silent no-op.
- **Static survivor pruning**: `tools/prune-static-survivors.ts` drops module-level (static-coverage-only) mutant verdicts from the incremental cache before each local run, so a static survivor from an unrelated file can't hold a local gate red after the actual fix landed.

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

## CI baseline

CI's `mutate` job runs the full mutate glob incrementally against a baseline in `actions/cache`: `reports/stryker-incremental.json` plus `reports/stryker-baseline-meta.json`, a provenance file written by `tools/mutation-baseline.ts`. The mutate files are split into 14 slices by path hash, and the meta file records, for each slice, the toolchain fingerprint (runner OS, Bun version, `bun.lock` hash) and the time of its last forced refresh.

- **Inherit.** A run prefers the newest baseline saved under its own fingerprint and otherwise inherits the newest one saved under any fingerprint. A Bun bump (edit `.bun-version`) or a dependency change therefore costs no re-seed; the inherited verdicts are trusted until their slices are refreshed.
- **Nightly refresh.** `.github/workflows/mutation-baseline.yml` refreshes 2 slices a night, so every slice is re-run under the current toolchain about once a week. The picker's order: never-refreshed slices first, then slices inherited from another toolchain, then slices on the current toolchain; oldest refresh first within each group. A refresh re-runs every mutant in its slice with `--force`, deletes any Survived/NoCoverage entries before saving (saved baselines never contain survivors), and stamps the slice. A slot is red, and saves nothing, unless Stryker completed (exit 0, or non-zero with its final "under breaking threshold" line in the log) and the log shows no inspector-stream truncation; a save that does not land in the cache also turns the slot red.
- **Only the default branch saves.** Pull requests and non-default branches (including a `mutation-baseline.yml` dispatch on a feature ref, which runs as a warned dry run) restore but never save, so they always read the default branch's baseline. GitHub searches a ref's own caches before the default branch's, so a save from any other ref would shadow the refreshed baseline for that ref.
- **Known residual.** The gate's "newer baseline?" recheck and its save are not atomic, so a refresh that saves in the few seconds between them can be overwritten. The overwritten slice keeps its older stamp, so the rotation picks it again and re-exposes any survivor within the week.
- **Provenance summary.** Every gate run writes the matched cache key, the current fingerprint and a per-slice table (state: `current`, `inherited from <fingerprint>` or `never refreshed`; refresh date; age in whole days) to the job summary. The gate and the slice picker only read the meta file; only a slice refresh writes it.
- **A second toolchain change during a catch-up.** Nothing restarts. The rotation is a round-robin in the order above, so slices not yet on the current toolchain go before any that are, oldest refresh first, straight to the newest toolchain; seven nights after the latest change every slice is on it. Each slice's own refresh date is its overdue clock, so a later change cannot reset it.

Red states:

| State | Meaning | Action |
|---|---|---|
| Refresh survivor | A refresh slot found Survived/NoCoverage mutants under the current toolchain. They were removed from the saved baseline, so every gate run re-executes them and stays red. | Kill them with tests; the slot summary lists each one. |
| Baseline incomplete | A non-empty slice has never been refreshed: a seed is running or needed. | Wait for the seed, or start one. |
| Baseline overdue | A slice is stamped with another fingerprint and was last refreshed more than 10 days ago (the message names each such slice, its fingerprint and its refresh date): the nightly refresh is failing or not running. A slice on the current fingerprint is never overdue, however old. A pull request that changes `bun.lock` or `.bun-version` sees every slice as inherited, so it is overdue only if some slice is also more than 10 days old, i.e. only when develop's rotation has stalled. | Fix the refresh, then dispatch extra slots (`-f slots=<n>`). |

Seed (first time, or after a cache nuke; ≈13 h, an estimate, as 14 serialized slots):

```bash
gh workflow run mutation-baseline.yml --ref develop -f slots=14
```

The full runbook (nuke, rollout, triage) is the comment above the `mutate` job in `.github/workflows/ci.yml`.

## Related gates

- **Directive placement**: `bun run lint` (after Oxlint and the `package.json` ESLint pass) runs `tools/stryker-directive-check.ts`, which enforces where a `// Stryker disable` comment may legally sit; a misplaced directive is a lint failure, not a silent no-op.
- **Static survivor pruning**: `tools/prune-static-survivors.ts` drops module-level (static-coverage-only) mutant verdicts from the incremental cache before each local run, so a static survivor from an unrelated file can't hold a local gate red after the actual fix landed.

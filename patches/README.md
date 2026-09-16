# Dependency patches

`package.json` and `bun.lock` declare the patches in this directory. Bun applies
them during a locked install.

## TypeScript checker grouping

`@stryker-mutator/typescript-checker@10.0.0.patch` memoizes each
`TSFileNode`'s complete parent-reference set for one `createGroups` call. The
checker revisits those sets for every candidate mutant, so this removes repeated
graph traversals without changing greedy group order or sharing graph state
between calls. The map is deliberately local to `createGroups`: TypeScript file
graphs can change between calls, and cached sets must not live on nodes.

When upgrading the checker, remove this patch only after confirming upstream
contains an equivalent call-local cache and rerunning the grouping fixture plus
a fresh `bun install --frozen-lockfile --ignore-scripts`. If upstream lacks the
fix, recreate and review the patch against that exact version.

## Core checker IPC batching

`@stryker-mutator/core@10.0.0.patch` caps each checker `group` call at 4,096
mutants while retaining Core's existing ten-second partial-buffer flush. A
synchronous 68,698-plan stream previously became one serialized IPC call. The
cap preserves the generic checker contract and exact mutant membership, though
grouping independently across chunks can change grouping performance.

This is a bounded-risk mitigation rather than a proven root-cause fix. A
representative 30.5 MB call succeeds in an otherwise clean Bun process, so the
observed native `worker.send` out-of-memory failure also depends on the mutation
run's surrounding memory or runtime state. The patch limits representative
calls to roughly 1.8 MB; because the cap counts mutants, it is not a strict byte
limit and does not bound the executor's total queued-plan memory.

Both Core's TypeScript source and published JavaScript under `dist/` are patched.
When upgrading Core, remove this patch only after confirming upstream bounds
checker grouping calls equivalently, then rerun the checker-batch fixture and a
forced `bun install --force --frozen-lockfile --ignore-scripts`. If upstream
lacks the mitigation, recreate and review both source and `dist` changes against
that exact Core version.

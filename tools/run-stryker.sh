#!/usr/bin/env sh
# Run Stryker mutation testing with OS-appropriate low-priority scheduling and a file lock
# to prevent concurrent runs from corrupting the incremental cache.
set -e

# CI path (GITHUB_SHA is set — the same isCI signal stryker.conf.mjs uses): run stryker directly.
#  - `op` (1Password CLI) does not exist on GitHub-hosted runners, and the token it fetches
#    is only consumed by the LLM mutator, which stryker.conf.mjs disables in CI.
#  - The lock protects a developer machine from concurrent `bun mutate` runs; a CI job is an
#    isolated ephemeral VM with nothing to contend with (and `lockf` is BSD/macOS-only anyway).
#  - No nice/ionice: a single-tenant runner gains nothing from deprioritization.
if [ -n "${GITHUB_SHA:-}" ]; then
  exec stryker run "$@"
fi

LOCKFILE="reports/.stryker.lock"
CLAUDE_CODE_OAUTH_TOKEN=$(op read "op://Private/Anthropic/Isambard API Key")
export CLAUDE_CODE_OAUTH_TOKEN

# Parse optional --wait flag (must be first arg).
# Without --wait: non-blocking (-t 0); exits 75 if lock is held.
# With --wait:    blocking; waits until the current run finishes.
WAIT="-t 0"
if [ "${1-}" = "--wait" ]; then
  WAIT=""
  shift
fi

# Ensure lock file exists before lockf tries to open it.
mkdir -p reports
touch "$LOCKFILE"

# Select low-priority scheduler for the platform.
case "$(uname)" in
  Darwin) NICE="taskpolicy -c utility" ;;
  Linux)  NICE="nice -n 19 ionice -c 3" ;;
  *)      NICE="" ;;
esac

# Prune stale cached verdicts for *static* mutants before running Stryker. Stryker core's
# incremental differ only invalidates a cached Survived/NoCoverage mutant when a NEW test
# covers it — but a static (module-level) mutant has no covering tests at all, so once it
# survives once, that verdict is reused forever even after a killing test is added. See
# tools/prune-static-survivors.ts for the full diagnosis.
#
# This runs INSIDE the lock (via the `sh -c` wrapper below), not before it: pruning
# reports/stryker-incremental.json outside the lock could race a concurrent `bun mutate`
# that is actively reading or writing that same file, which is exactly what the lock
# exists to prevent. The prune step is idempotent and cheap (~30 entries), so paying for
# it on every locked run costs nothing measurable.
#
# `sh -c "$INNER" sh "$@"` is the standard way to hand a constructed script both a name
# for $0 and the caller's positional args for "$@" inside that script.
INNER='bun tools/prune-static-survivors.ts && exec '"$NICE"' stryker run "$@"'

# $WAIT is intentionally unquoted: empty expands to nothing, not an empty argument.
# shellcheck disable=SC2086
lockf $WAIT "$LOCKFILE" sh -c "$INNER" sh "$@" || {
  ec=$?
  if [ "$ec" -eq 75 ]; then
    echo "Another \`bun mutate\` holds the lock; use \`bun mutate:wait\` to wait for it instead of failing." >&2
  fi
  exit "$ec"
}

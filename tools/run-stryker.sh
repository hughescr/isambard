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

# $WAIT and $NICE are intentionally unquoted: empty expands to nothing,
# and multi-word values must split into separate arguments.
# shellcheck disable=SC2086
lockf $WAIT "$LOCKFILE" $NICE stryker run "$@" || {
  ec=$?
  if [ "$ec" -eq 75 ]; then
    echo "Another \`bun mutate\` holds the lock; use \`bun mutate:wait\` to wait for it instead of failing." >&2
  fi
  exit "$ec"
}

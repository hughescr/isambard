#!/usr/bin/env sh
# Run Stryker mutation testing with OS-appropriate low-priority scheduling and a file lock
# to prevent concurrent runs from corrupting the incremental cache.
set -e

LOCKFILE="reports/.stryker.lock"

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

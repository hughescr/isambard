#!/bin/bash
# PreToolUse hook: Protect critical configuration files from accidental modification.
# Returns "ask" disposition when Edit or Write targets a protected config file.
# This prompts the user for confirmation before the modification proceeds.

# Read JSON input from stdin
INPUT=$(cat)

# Extract the tool name
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Only check Edit and Write tools
if [[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" ]]; then
  exit 0
fi

# Extract the file path from tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# If no file path, skip
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Get just the filename (basename)
BASENAME=$(basename "$FILE_PATH")

# Protected config files
PROTECTED_FILES=(
  "eslint.config.mjs"
  "eslint-boundaries.config.mjs"
  "tsconfig.json"
  "bunfig.toml"
  "stryker.conf.mjs"
  "knip.json"
)

# Check if the file is protected
for PROTECTED in "${PROTECTED_FILES[@]}"; do
  if [[ "$BASENAME" == "$PROTECTED" ]]; then
    # Output JSON to request confirmation
    echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": "Modifying protected config file: '"$BASENAME"'. This file controls build/lint/test infrastructure."}}'
    exit 0
  fi
done

# Not a protected file, allow
exit 0

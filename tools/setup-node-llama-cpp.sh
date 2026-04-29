#!/usr/bin/env bash
# setup-node-llama-cpp.sh
#
# Idempotent postinstall script: downloads llama.cpp source and builds the
# node-llama-cpp native binary, applying two patches required as of
# node-llama-cpp 3.x + llama.cpp >= b8950.
#
# Invoked automatically by `bun install` / `npm install` via the postinstall
# hook in package.json.  Safe to run manually at any time — it exits
# immediately (no-op) when the bundled llama.cpp is already >= b8950.
#
# WHY THE 8950 FLOOR:
#   The Qwen3 non-causal embedding bug (present in b8390) was fixed in b8950.
#   Production must use a binary built from llama.cpp >= b8950 for correct
#   embeddings.  b8953 is the confirmed-working release.
#
# IDEMPOTENCY:
#   The script reads node_modules/node-llama-cpp/llama/llama.cpp.info.json
#   (JSON: { "tag": "b8953", ... }) and skips the full download+patch+build
#   when the numeric build number is already >= 8950.  Future node-llama-cpp
#   releases that bundle a newer llama.cpp will also skip automatically.
#
# Patch 1 — addon.cpp atomic copy-constructor fix
#   File: node_modules/node-llama-cpp/llama/addon/addon.cpp
#   Problem: `static std::atomic_bool loaded = false;` uses copy-init syntax
#            which is deleted under Apple's libcxx (macOS 26 SDK is stricter).
#   Fix:     Change to constructor-call syntax: `static std::atomic_bool loaded(false);`
#
# Patch 2 — CMakeLists common library rename
#   File: node_modules/node-llama-cpp/llama/CMakeLists.txt
#   Problem: NLC links against `"common"` but llama.cpp >= b8950 renamed the
#            CMake target from `common` to `llama-common`.
#   Fix:     Change `target_link_libraries(... "common")` to `"llama-common"`.
#
# Manual invocation:
#   bash tools/setup-node-llama-cpp.sh
#
# Prerequisites:
#   - bun installed
#   - Xcode Command Line Tools installed (clang, cmake)
#   - node_modules installed (bun install)

set -euo pipefail

NLC_DIR="node_modules/node-llama-cpp"
NLC_INFO_FILE="$NLC_DIR/llama/llama.cpp.info.json"
ADDON_CPP="$NLC_DIR/llama/addon/addon.cpp"
CMAKELISTS="$NLC_DIR/llama/CMakeLists.txt"
MINIMUM_BUILD=8950

if [ ! -d "$NLC_DIR" ]; then
    echo "ERROR: $NLC_DIR not found. Run 'bun install' first." >&2
    exit 1
fi

# Skip the full download+patch+build if bundled llama.cpp is already current enough.
if [ -f "$NLC_INFO_FILE" ]; then
    # Use bun (already required by this project) instead of jq, which isn't a project dep.
    # Reads the JSON, extracts the trailing digits of `.tag` (e.g. "b8953" → "8953"); empty on any error.
    current_build=$(bun -p "(p=>{try{const t=JSON.parse(require('node:fs').readFileSync(p,'utf-8')).tag;return(t&&t.match(/\\d+$/)||[''])[0]}catch{return ''}})('$NLC_INFO_FILE')" 2>/dev/null || true)
    if [ -n "$current_build" ] && [ "$current_build" -ge "$MINIMUM_BUILD" ]; then
        echo "node-llama-cpp's bundled llama.cpp is already at b${current_build} (>= ${MINIMUM_BUILD}) — no rebuild needed"
        exit 0
    fi
    echo "Found bundled llama.cpp at b${current_build:-unknown}, below ${MINIMUM_BUILD} floor — rebuilding..."
fi

# Pin to b8953: confirmed-working release. NLC 3.18.x's addon code references
# symbols (e.g. cpu_get_num_math) that newer llama.cpp tags have renamed/removed,
# so 'latest' fails to build. b8953 is past the b8950 floor for the Qwen3
# non-causal embedding fix and known-compatible with NLC 3.18.x's addon.
TARGET_TAG="b8953"
echo "==> Downloading llama.cpp source (pinned to ${TARGET_TAG})..."
bunx node-llama-cpp source download --release "$TARGET_TAG" --skipBuild

echo "==> Applying Patch 1: addon.cpp atomic copy-constructor fix..."
# perl -i works identically on BSD and GNU; sed -i differs and is fragile under Homebrew GNU sed.
perl -i -pe 's/static std::atomic_bool loaded = false;/static std::atomic_bool loaded(false);/' \
    "$ADDON_CPP"

# Verify patch 1 applied (or was already applied — both are OK)
if grep -q 'static std::atomic_bool loaded = false;' "$ADDON_CPP"; then
    echo "ERROR: Patch 1 failed to apply — 'loaded = false' still present in $ADDON_CPP" >&2
    exit 1
fi
echo "   Patch 1 applied OK."

echo "==> Applying Patch 2: CMakeLists llama-common library rename..."
perl -i -pe 's/target_link_libraries\(\$\{PROJECT_NAME\} "common"\)/target_link_libraries(\${PROJECT_NAME} "llama-common")/' \
    "$CMAKELISTS"

# Verify patch 2 applied (or was already applied)
if grep -q 'target_link_libraries(${PROJECT_NAME} "common")' "$CMAKELISTS"; then
    echo "ERROR: Patch 2 failed to apply — '\"common\"' still present in $CMAKELISTS" >&2
    exit 1
fi
echo "   Patch 2 applied OK."

echo "==> Building node-llama-cpp from source..."
bunx node-llama-cpp source build

echo ""
echo "==> Build complete. Running smoke test..."
bun -e "
import { getLlama } from 'node-llama-cpp';
const llama = await getLlama({ logLevel: 'warn' });
console.log('node-llama-cpp loaded OK, backend:', llama.gpu ?? 'cpu');
await llama.dispose();
"

echo ""
echo "All done. node-llama-cpp native binary is ready."

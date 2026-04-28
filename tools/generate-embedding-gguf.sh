#!/usr/bin/env bash
# generate-embedding-gguf.sh — Produce a patched non-causal GGUF for pplx-embed-v1
#
# Usage:
#   tools/generate-embedding-gguf.sh <slug> <quant> [--force] [--keep-intermediates]
#
#   slug:  0.6b | 4b
#   quant: Q8_0 | Q4_K_M | Q4_K_S | Q5_K_M | IQ4_NL | IQ4_XS | F16
#
# Output: ~/Library/Caches/llama.cpp/local_pplx-embed-v1-<slug>_<quant_lower>-noncausal.gguf
#
# Idempotent: exits 0 immediately if target exists (use --force to override).

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
SLUG=""
QUANT=""
FORCE=0
KEEP_INTERMEDIATES=0

for arg in "$@"; do
  case "$arg" in
    --force)              FORCE=1 ;;
    --keep-intermediates) KEEP_INTERMEDIATES=1 ;;
    --*)
      echo "Unknown flag: $arg" >&2
      exit 1
      ;;
    *)
      if [[ -z "$SLUG" ]]; then
        SLUG="$arg"
      elif [[ -z "$QUANT" ]]; then
        QUANT="$arg"
      else
        echo "Extra argument: $arg" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$SLUG" || -z "$QUANT" ]]; then
  echo "Usage: $0 <slug> <quant> [--force] [--keep-intermediates]" >&2
  echo "  slug:  0.6b | 4b" >&2
  echo "  quant: Q8_0 | Q4_K_M | Q4_K_S | Q5_K_M | IQ4_NL | IQ4_XS | F16" >&2
  exit 1
fi

# Validate slug
case "$SLUG" in
  0.6b|4b) ;;
  *) echo "Unknown slug '$SLUG'. Must be one of: 0.6b, 4b" >&2; exit 1 ;;
esac

# Validate quant
QUANT_UPPER="${QUANT^^}"
case "$QUANT_UPPER" in
  Q8_0|Q4_K_M|Q4_K_S|Q5_K_M|IQ4_NL|IQ4_XS|F16) ;;
  *) echo "Unknown quant '$QUANT'. Must be one of: Q8_0 Q4_K_M Q4_K_S Q5_K_M IQ4_NL IQ4_XS F16" >&2; exit 1 ;;
esac
QUANT_LOWER="${QUANT_UPPER,,}"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="$HOME/Library/Caches/llama.cpp"
DEST_NAME="local_pplx-embed-v1-${SLUG}_${QUANT_LOWER}-noncausal.gguf"
DEST="$CACHE_DIR/$DEST_NAME"
PATCHER="$SCRIPT_DIR/patch-gguf-noncausal.py"

# llama.cpp converter source cache (pinned to b8953, matching NLC build target)
LLAMA_TAG="b8953"
CONVERTER_CACHE="$HOME/.cache/llama-cpp-converter/$LLAMA_TAG"
CONVERTER="$CONVERTER_CACHE/convert_hf_to_gguf.py"

# HF repo
HF_REPO="perplexity-ai/pplx-embed-v1-${SLUG}"
HF_BASE="https://huggingface.co/${HF_REPO}/resolve/main"

# Working temp dir — unique per invocation, cleaned up on exit
WORK_DIR="${TMPDIR:-/tmp}/pplx-gguf-$$"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
ts() { date "+%H:%M:%S"; }
stage_start() { echo; echo "$(ts) === $* ==="; STAGE_START=$(date +%s); }
stage_done()  { local elapsed=$(( $(date +%s) - STAGE_START )); echo "$(ts)     done in ${elapsed}s"; }

die() { echo "$(ts) ERROR: $*" >&2; exit 1; }

cleanup() {
  if [[ $KEEP_INTERMEDIATES -eq 0 && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  elif [[ -d "$WORK_DIR" ]]; then
    echo "$(ts) Keeping intermediates in: $WORK_DIR"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Idempotency check
# ---------------------------------------------------------------------------
if [[ -f "$DEST" && $FORCE -eq 0 ]]; then
  echo "$(ts) Target already exists — skipping (use --force to rebuild):"
  echo "       $DEST"
  exit 0
fi

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
stage_start "Checking dependencies"

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    die "$1 not found. $2"
  fi
}

check_cmd curl  "Install with: brew install curl"
check_cmd git   "Install with: brew install git"
check_cmd python3 "Install Python 3: https://www.python.org/"
check_cmd jq    "Install with: brew install jq"

if ! command -v llama-quantize &>/dev/null; then
  die "llama-quantize not found. Install llama.cpp: brew install llama.cpp"
fi

if ! command -v llama-embedding &>/dev/null && ! command -v llama-cli &>/dev/null; then
  die "Neither llama-embedding nor llama-cli found. Install: brew install llama.cpp"
fi

# Check Python deps
python3 -c "import gguf" 2>/dev/null || {
  echo "$(ts) Installing missing Python package: gguf"
  pip install --user gguf
}
KMP_DUPLICATE_LIB_OK=TRUE python3 -c "import numpy, safetensors, transformers, torch" 2>/dev/null || {
  echo "$(ts) Installing missing Python packages for convert_hf_to_gguf.py..."
  pip install --user numpy safetensors transformers torch
}

if [[ ! -f "$PATCHER" ]]; then
  die "Patcher script not found: $PATCHER"
fi

stage_done

# ---------------------------------------------------------------------------
# Clone llama.cpp converter (cached at LLAMA_TAG)
# ---------------------------------------------------------------------------
stage_start "Ensuring llama.cpp converter at $LLAMA_TAG"

if [[ ! -f "$CONVERTER" ]]; then
  echo "$(ts) Cloning llama.cpp at $LLAMA_TAG into $CONVERTER_CACHE ..."
  mkdir -p "$(dirname "$CONVERTER_CACHE")"
  git clone \
    --depth 1 \
    --branch "$LLAMA_TAG" \
    https://github.com/ggerganov/llama.cpp \
    "$CONVERTER_CACHE"
  echo "$(ts) Clone complete."
else
  echo "$(ts) Converter already cached at $CONVERTER_CACHE"
fi

stage_done

# ---------------------------------------------------------------------------
# Discover HF model files via the HF API
# ---------------------------------------------------------------------------
stage_start "Discovering HF model files for $HF_REPO"

HF_API="https://huggingface.co/api/models/${HF_REPO}"
echo "$(ts) Fetching file list from $HF_API"
SIBLINGS=$(curl -fsSL "$HF_API" | jq -r '.siblings[].rfilename')

# Files needed: safetensors, tokenizer, config files (not .onnx, not .git*)
DOWNLOAD_FILES=()
while IFS= read -r f; do
  case "$f" in
    *.safetensors|config.json|tokenizer*.json|vocab.json|merges.txt|special_tokens_map.json|added_tokens.json)
      DOWNLOAD_FILES+=("$f")
      ;;
    1_Pooling/config.json)
      DOWNLOAD_FILES+=("$f")
      ;;
  esac
done <<< "$SIBLINGS"

if [[ ${#DOWNLOAD_FILES[@]} -eq 0 ]]; then
  die "No files found in HF repo $HF_REPO — check slug and network access"
fi

echo "$(ts) Files to download: ${#DOWNLOAD_FILES[@]}"
for f in "${DOWNLOAD_FILES[@]}"; do echo "       $f"; done

stage_done

# ---------------------------------------------------------------------------
# Download HF model files
# ---------------------------------------------------------------------------
stage_start "Downloading model files"

mkdir -p "$WORK_DIR/hf"

download_file() {
  local rel_path="$1"
  local url="$HF_BASE/$rel_path"
  local dest="$WORK_DIR/hf/$rel_path"
  local dest_partial="${dest}.partial"

  mkdir -p "$(dirname "$dest")"

  if [[ -f "$dest" ]]; then
    echo "$(ts)   [skip] $rel_path (already downloaded)"
    return 0
  fi

  echo "$(ts)   [download] $rel_path"

  # Download, following redirects. --write-out gives actual bytes written.
  local size_downloaded
  size_downloaded=$(curl -fL --progress-bar -o "$dest_partial" \
    --write-out "%{size_download}" "$url")

  # Basic sanity: file must not be empty
  if [[ -z "$size_downloaded" || "$size_downloaded" -eq 0 ]]; then
    die "Download produced empty file for $rel_path"
  fi

  mv "$dest_partial" "$dest"
  echo "$(ts)   [ok] $rel_path ($(numfmt --to=iec-i --suffix=B "$size_downloaded" 2>/dev/null || echo "${size_downloaded} bytes"))"
}

export -f download_file
export WORK_DIR HF_BASE

# Download in parallel (background jobs)
PIDS=()
for f in "${DOWNLOAD_FILES[@]}"; do
  download_file "$f" &
  PIDS+=($!)
done

# Wait for all downloads and check for failures
FAILED=0
for pid in "${PIDS[@]}"; do
  if ! wait "$pid"; then
    FAILED=1
  fi
done

if [[ $FAILED -ne 0 ]]; then
  die "One or more downloads failed"
fi

stage_done

# ---------------------------------------------------------------------------
# Patch config.json: rename model_type and architectures for convert_hf_to_gguf.py
# ---------------------------------------------------------------------------
stage_start "Patching config.json (model_type + architectures)"

CONFIG="$WORK_DIR/hf/config.json"
CONFIG_PATCHED="$WORK_DIR/hf/config.json"

# Read and patch in Python for robustness (jq can't easily handle array replacement)
python3 - "$CONFIG" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    cfg = json.load(f)

original_type = cfg.get("model_type", "")
original_arch = cfg.get("architectures", [])

# Only patch if it's the pplx bidirectional variant
if cfg.get("model_type") == "bidirectional_pplx_qwen3":
    cfg["model_type"] = "qwen3"
    cfg["architectures"] = ["Qwen3Model"]
    # Remove auto_map that references the custom PPLXQwen3 classes
    cfg.pop("auto_map", None)
    print(f"Patched: model_type {original_type!r} -> 'qwen3'")
    print(f"Patched: architectures {original_arch!r} -> ['Qwen3Model']")
elif cfg.get("model_type") == "qwen3":
    print("config.json already has model_type='qwen3' — no patch needed")
else:
    print(f"WARNING: Unexpected model_type={cfg.get('model_type')!r}, patching anyway to qwen3")
    cfg["model_type"] = "qwen3"
    cfg["architectures"] = ["Qwen3Model"]
    cfg.pop("auto_map", None)

with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
PYEOF

stage_done

# ---------------------------------------------------------------------------
# Convert HF → F16 GGUF
# ---------------------------------------------------------------------------
stage_start "Converting HF model to F16 GGUF"

F16_GGUF="$WORK_DIR/model-f16.gguf"

KMP_DUPLICATE_LIB_OK=TRUE python3 "$CONVERTER" \
  --outtype f16 \
  --outfile "$F16_GGUF" \
  "$WORK_DIR/hf"

if [[ ! -f "$F16_GGUF" ]]; then
  die "Conversion failed — F16 GGUF not produced"
fi

echo "$(ts) F16 GGUF size: $(du -sh "$F16_GGUF" | cut -f1)"

stage_done

# ---------------------------------------------------------------------------
# Patch GGUF metadata: set causal=false, pooling_type=MEAN
# ---------------------------------------------------------------------------
stage_start "Patching GGUF metadata (non-causal attention + MEAN pooling)"

PATCHED_F16_GGUF="$WORK_DIR/model-f16-noncausal.gguf"

KMP_DUPLICATE_LIB_OK=TRUE python3 "$PATCHER" "$F16_GGUF" "$PATCHED_F16_GGUF"

if [[ ! -f "$PATCHED_F16_GGUF" ]]; then
  die "GGUF patch failed — patched file not produced"
fi

stage_done

# ---------------------------------------------------------------------------
# Quantize (skip if requesting F16 — the patched F16 is the output)
# ---------------------------------------------------------------------------
if [[ "$QUANT_UPPER" == "F16" ]]; then
  echo "$(ts) Quant=F16 requested — skipping quantization step"
  FINAL_GGUF="$PATCHED_F16_GGUF"
else
  stage_start "Quantizing to $QUANT_UPPER"

  QUANT_GGUF="$WORK_DIR/model-${QUANT_LOWER}-noncausal.gguf"

  llama-quantize "$PATCHED_F16_GGUF" "$QUANT_GGUF" "$QUANT_UPPER"

  if [[ ! -f "$QUANT_GGUF" ]]; then
    die "Quantization failed — output GGUF not found"
  fi

  echo "$(ts) Quantized GGUF size: $(du -sh "$QUANT_GGUF" | cut -f1)"
  FINAL_GGUF="$QUANT_GGUF"

  stage_done
fi

# ---------------------------------------------------------------------------
# Install to cache
# ---------------------------------------------------------------------------
stage_start "Installing to $CACHE_DIR"

mkdir -p "$CACHE_DIR"
cp "$FINAL_GGUF" "$DEST.partial"
mv "$DEST.partial" "$DEST"

echo "$(ts) Installed: $DEST"
echo "$(ts) Size: $(du -sh "$DEST" | cut -f1)"

stage_done

# ---------------------------------------------------------------------------
# Clean intermediates (unless --keep-intermediates)
# ---------------------------------------------------------------------------
if [[ $KEEP_INTERMEDIATES -eq 0 ]]; then
  echo "$(ts) Cleaning up work directory..."
  rm -rf "$WORK_DIR"
  echo "$(ts) Cleaned."
fi

# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------
stage_start "Smoke test: loading model"

LLAMA_EMB_BIN=""
if command -v llama-embedding &>/dev/null; then
  LLAMA_EMB_BIN="llama-embedding"
elif command -v llama-cli &>/dev/null; then
  LLAMA_EMB_BIN="llama-cli"
else
  die "No llama binary found for smoke test"
fi

echo "$(ts) Using binary: $LLAMA_EMB_BIN"

# Build command based on binary type:
# - llama-embedding: dedicated embedding binary, no --embedding flag needed
# - llama-cli: general binary, needs --embedding -no-cnv flags
if [[ "$LLAMA_EMB_BIN" == "llama-embedding" ]]; then
  SMOKE_CMD=("$LLAMA_EMB_BIN" -m "$DEST" -ngl 99 --pooling mean)
else
  SMOKE_CMD=("$LLAMA_EMB_BIN" -m "$DEST" -ngl 99 --pooling mean --embedding -no-cnv)
fi

echo "$(ts) Command: echo 'Hello world' | ${SMOKE_CMD[*]}"
echo

# Run; we just want to confirm the model loads without error
set +e
SMOKE_OUTPUT=$(echo "Hello world" | "${SMOKE_CMD[@]}" 2>&1 | head -30)
SMOKE_EXIT=$?
set -e

echo "$SMOKE_OUTPUT"
echo

if [[ $SMOKE_EXIT -eq 0 ]]; then
  echo "$(ts) Smoke test PASSED (exit 0, model loaded)"
elif echo "$SMOKE_OUTPUT" | grep -qE "embedding|load_backend|llama_model"; then
  echo "$(ts) Smoke test OK (model loaded, llama.cpp output detected)"
else
  echo "$(ts) WARNING: Smoke test exit code $SMOKE_EXIT — check output above" >&2
fi

stage_done

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo
echo "$(ts) ================================================================"
echo "$(ts) DONE: $DEST"
echo "$(ts) ================================================================"

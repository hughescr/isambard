#!/usr/bin/env python3
"""
Patch a GGUF file produced by convert_hf_to_gguf.py to enable non-causal
(bidirectional) attention and MEAN pooling.

This is required for embedding models like pplx-embed-v1 that use the Qwen3
architecture but with bidirectional attention. The converter script does not
auto-detect the use_bidirectional_attention flag for Qwen3 (only for the
Reranker subclass), so the produced GGUF defaults to causal attention and
produces incorrect embeddings without this patch.

Changes applied:
  qwen3.attention.causal = false  (GGUFValueType.BOOL, type 7)
  qwen3.pooling_type = 1          (GGUFValueType.UINT32, MEAN = 1)

Usage:
  python3 patch-gguf-noncausal.py <input.gguf> <output.gguf>
  python3 patch-gguf-noncausal.py <input.gguf>   (overwrites in-place via tmp+rename)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger("patch-gguf-noncausal")


def copy_with_patches(
    reader: Any,  # gguf.GGUFReader
    writer: Any,  # gguf.GGUFWriter
    override_keys: dict[str, tuple[Any, Any]],  # key -> (value, GGUFValueType)
) -> None:
    """Copy all fields and tensors from reader to writer, overriding specific keys."""
    import gguf

    for field in reader.fields.values():
        # Suppress virtual fields and fields written by GGUFWriter internally
        if field.name == gguf.Keys.General.ARCHITECTURE or field.name.startswith("GGUF."):
            logger.debug("Suppressing virtual field: %s", field.name)
            continue

        if field.name in override_keys:
            new_val, new_type = override_keys[field.name]
            old_val = field.parts[field.data[0]][0]
            logger.info("Patching %s: %r -> %r", field.name, old_val, new_val)
            writer.add_key_value(field.name, new_val, new_type)
            del override_keys[field.name]
        else:
            val_type = field.types[0]
            sub_type = field.types[-1] if val_type == gguf.GGUFValueType.ARRAY else None
            val = field.contents()
            if val is not None:
                logger.debug("Copying field: %s", field.name)
                writer.add_key_value(field.name, val, val_type, sub_type=sub_type)

    # Add any override keys that weren't in the original file
    for key, (new_val, new_type) in override_keys.items():
        logger.info("Adding new field %s = %r", key, new_val)
        writer.add_key_value(key, new_val, new_type)

    for tensor in reader.tensors:
        writer.add_tensor_info(
            tensor.name,
            tensor.data.shape,
            tensor.data.dtype,
            tensor.data.nbytes,
            tensor.tensor_type,
        )

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_ti_data_to_file()

    for tensor in reader.tensors:
        writer.write_tensor_data(tensor.data, tensor_endianess=reader.endianess)


def patch_gguf(input_path: Path, output_path: Path) -> None:
    import gguf

    logger.info("Reading: %s", input_path)
    reader = gguf.GGUFReader(str(input_path), "r")

    arch_field = reader.get_field(gguf.Keys.General.ARCHITECTURE)
    if arch_field is None:
        raise ValueError("GGUF file has no general.architecture field")
    arch = arch_field.contents()
    logger.info("Architecture: %s", arch)

    causal_key = gguf.Keys.Attention.CAUSAL.format(arch=arch)
    pooling_key = gguf.Keys.LLM.POOLING_TYPE.format(arch=arch)
    logger.info("Keys to patch: %s, %s", causal_key, pooling_key)

    override_keys = {
        causal_key: (False, gguf.GGUFValueType.BOOL),
        pooling_key: (gguf.PoolingType.MEAN.value, gguf.GGUFValueType.UINT32),
    }

    # Write atomically via temp file in the same directory
    output_dir = output_path.parent
    output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(
        dir=output_dir,
        prefix=output_path.name + ".partial.",
        delete=False,
        suffix=".gguf",
    ) as tmp_f:
        tmp_path = Path(tmp_f.name)

    try:
        logger.info("Writing to temp file: %s", tmp_path)
        writer = gguf.GGUFWriter(str(tmp_path), arch=arch, endianess=reader.endianess)

        alignment = reader.get_field(gguf.Keys.General.ALIGNMENT)
        if alignment is not None:
            writer.data_alignment = alignment.contents()

        copy_with_patches(reader, writer, override_keys)
        writer.close()

        logger.info("Renaming to: %s", output_path)
        os.replace(tmp_path, output_path)
    except Exception:
        # Clean up temp file on error
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise

    logger.info("Done: %s", output_path)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    parser = argparse.ArgumentParser(
        description=(
            "Patch a GGUF file to use non-causal (bidirectional) attention "
            "and MEAN pooling. Required for pplx-embed-v1 models."
        )
    )
    parser.add_argument("input", type=Path, help="Input GGUF file (F16 from convert_hf_to_gguf.py)")
    parser.add_argument(
        "output",
        type=Path,
        nargs="?",
        help="Output GGUF file (default: overwrite input in-place via atomic rename)",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    input_path = args.input.resolve()
    if not input_path.exists():
        logger.error("Input file not found: %s", input_path)
        sys.exit(1)

    output_path = args.output.resolve() if args.output else input_path

    patch_gguf(input_path, output_path)


if __name__ == "__main__":
    main()

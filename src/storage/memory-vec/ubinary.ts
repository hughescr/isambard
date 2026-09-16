/**
 * Sign-bit packing: converts float32 vectors to packed binary (ubinary) format.
 *
 * Each positive value becomes a 1-bit, each non-positive value becomes a 0-bit.
 * Bits are packed MSB-first within each byte.
 *
 * This matches the ubinary format used by FAISS and common ANN libraries.
 * 1024 floats → 128 bytes (1024 bits).
 */

import { InvariantViolationError } from '@/errors';

const BIT_POSITIONS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/**
 * Packs sign bits from a float32 array into a compact Uint8Array.
 *
 * @param input - Float32Array with layout [batch_0_dim_0, ..., batch_0_dim_{dim-1}, batch_1_dim_0, ...]
 * @param batchSize - Number of vectors in the batch
 * @param dim - Dimensionality of each vector (must be a multiple of 8)
 * @returns Uint8Array of length (batchSize * dim / 8)
 * @throws Error if dim is not a positive multiple of 8
 */
export function packSignBits(input: Float32Array, batchSize: number, dim: number): Uint8Array {
    const bytesPerVector = dim / 8;
    if(bytesPerVector <= 0 || !Number.isInteger(bytesPerVector)) {
        throw new InvariantViolationError('packSignBits', `dim must be a positive multiple of 8, got ${dim}`);
    }
    const output = new Uint8Array(batchSize * bytesPerVector);

    // The flattened byte index already incorporates both the batch and vector offsets.
    for(const [outputIndex] of output.entries()) {
        let byte = 0;
        const inputOffset = outputIndex * 8;
        for(const bit of BIT_POSITIONS) {
            // Missing trailing floats retain their old zero-bit behavior.
            const value = input[inputOffset + bit];
            if(value !== undefined && value > 0) {
                // eslint-disable-next-line no-bitwise -- sign-bit packing requires bitwise OR and left-shift; this is the canonical ubinary implementation
                byte |= (1 << (7 - bit));
            }
        }
        output[outputIndex] = byte;
    }

    return output;
}

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
    if(dim <= 0 || dim % 8 !== 0) {
        // Stryker disable next-line StringLiteral: location and message strings are debug-only metadata — the throw itself is tested
        throw new InvariantViolationError('packSignBits', `dim must be a positive multiple of 8, got ${dim}`);
    }
    const bytesPerVector = dim / 8;
    const output = new Uint8Array(batchSize * bytesPerVector);

    // Stryker disable next-line EqualityOperator,UpdateOperator: b <= batchSize processes an OOB iteration (no-op); b-- causes an infinite loop — neither changes output for valid inputs
    for(let b = 0; b < batchSize; b++) {
        // Offsets into the flat input/output arrays for this batch
        const inputOffset = b * dim;           // start of batch b's floats in input
        const outputOffset = bytesPerVector * b; // start of batch b's bytes in output

        // Stryker disable next-line EqualityOperator,UpdateOperator: byteIdx <= bytesPerVector writes an OOB byte (no-op); byteIdx-- causes an infinite loop — neither changes output
        for(let byteIdx = 0; byteIdx < bytesPerVector; byteIdx++) {
            let byte = 0;
            const bitBase = byteIdx * 8;
            // Stryker disable next-line EqualityOperator,UpdateOperator: bit <= 8 reads a 9th bit that truncates to 0; bit-- causes an infinite loop — neither changes packed output
            for(let bit = 0; bit < 8; bit++) {
                // MSB-first: first value maps to bit 7, last to bit 0
                const value = input[inputOffset + bitBase + bit];
                // Stryker disable next-line ConditionalExpression: `value !== undefined` → true is an equivalent mutant — undefined > 0 is already false in JS (NaN comparison), so removing the undefined check produces identical behavior
                if(value !== undefined && value > 0) {
                    // eslint-disable-next-line no-bitwise -- sign-bit packing requires bitwise OR and left-shift; this is the canonical ubinary implementation
                    byte |= (1 << (7 - bit));
                }
            }
            output[outputOffset + byteIdx] = byte;
        }
    }

    return output;
}

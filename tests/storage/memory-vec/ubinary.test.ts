/**
 * Tests for ubinary.ts — sign-bit packing (1024 floats → 128 bytes)
 */
import { describe, expect, it } from 'bun:test';
import { packSignBits } from '@/storage/memory-vec/ubinary';

describe('packSignBits', () => {
    it('produces output length of (batchSize * dim / 8) bytes', () => {
        const input = new Float32Array(1024).fill(1); // all positive
        const result = packSignBits(input, 1, 1024);
        expect(result.length).toBe(128);
    });

    it('produces output length of (batchSize * dim / 8) bytes for batch size 2', () => {
        const input = new Float32Array(2048).fill(1); // 2 batches of 1024
        const result = packSignBits(input, 2, 1024);
        expect(result.length).toBe(256);
    });

    it('returns all 0xFF bytes when all input values are positive', () => {
        const input = new Float32Array(1024).fill(1);
        const result = packSignBits(input, 1, 1024);
        for(const element of result) {
            expect(element).toBe(0xFF);
        }
    });

    it('returns all 0x00 bytes when all input values are negative', () => {
        const input = new Float32Array(1024).fill(-1);
        const result = packSignBits(input, 1, 1024);
        for(const element of result) {
            expect(element).toBe(0x00);
        }
    });

    it('packs bits MSB-first within each byte', () => {
        // First 8 values: [+, -, +, -, +, -, +, -]
        // MSB-first: 1,0,1,0,1,0,1,0 = 0xAA
        const input = new Float32Array(8);
        input[0] = 1;   // bit 7 (MSB) = 1
        input[1] = -1;  // bit 6 = 0
        input[2] = 1;   // bit 5 = 1
        input[3] = -1;  // bit 4 = 0
        input[4] = 1;   // bit 3 = 1
        input[5] = -1;  // bit 2 = 0
        input[6] = 1;   // bit 1 = 1
        input[7] = -1;  // bit 0 (LSB) = 0
        const result = packSignBits(input, 1, 8);
        expect(result.length).toBe(1);
        expect(result[0]).toBe(0xAA);
    });

    it('packs bits MSB-first — alternate pattern 01010101 = 0x55', () => {
        const input = new Float32Array(8);
        input[0] = -1;  // bit 7 (MSB) = 0
        input[1] = 1;   // bit 6 = 1
        input[2] = -1;  // bit 5 = 0
        input[3] = 1;   // bit 4 = 1
        input[4] = -1;  // bit 3 = 0
        input[5] = 1;   // bit 2 = 1
        input[6] = -1;  // bit 1 = 0
        input[7] = 1;   // bit 0 (LSB) = 1
        const result = packSignBits(input, 1, 8);
        expect(result[0]).toBe(0x55);
    });

    it('treats 0.0 as non-positive (bit = 0)', () => {
        const input = new Float32Array(8).fill(0);
        const result = packSignBits(input, 1, 8);
        expect(result[0]).toBe(0x00);
    });

    it('correctly packs second byte using values [8..15]', () => {
        // Byte 0: all positive = 0xFF
        // Byte 1: all negative = 0x00
        const input = new Float32Array(16);
        input.fill(1, 0, 8);   // first 8 = positive
        input.fill(-1, 8, 16); // next 8 = negative
        const result = packSignBits(input, 1, 16);
        expect(result.length).toBe(2);
        expect(result[0]).toBe(0xFF);
        expect(result[1]).toBe(0x00);
    });

    it('handles multiple batches correctly — each batch is independent', () => {
        // Batch 0: all positive → 0xFF per byte
        // Batch 1: all negative → 0x00 per byte
        const input = new Float32Array(16);
        input.fill(1, 0, 8);    // batch 0, dim=8 → 1 byte = 0xFF
        input.fill(-1, 8, 16);  // batch 1, dim=8 → 1 byte = 0x00
        const result = packSignBits(input, 2, 8);
        expect(result.length).toBe(2);
        expect(result[0]).toBe(0xFF);
        expect(result[1]).toBe(0x00);
    });

    it('batch 1 of 1024-dim — all positive — produces 0xFF bytes (catches wrong inputOffset arithmetic)', () => {
        // Uses dim=1024 so b/dim and b*dim diverge for b=1 (1/1024≠1*1024)
        // Also catches wrong outputOffset: b/bytesPerVector = 1/128 ≠ b*bytesPerVector = 128
        const input = new Float32Array(2 * 1024);
        input.fill(-1, 0, 1024);   // batch 0: all negative → 0x00
        input.fill(1, 1024, 2048); // batch 1: all positive → 0xFF
        const result = packSignBits(input, 2, 1024);
        expect(result.length).toBe(256);
        // batch 0 bytes (indices 0..127)
        for(let i = 0; i < 128; i++) {
            expect(result[i]).toBe(0x00);
        }
        // batch 1 bytes (indices 128..255) — must be 0xFF
        for(let i = 128; i < 256; i++) {
            expect(result[i]).toBe(0xFF);
        }
    });

    it('batch 2 of 3-batch 1024-dim — output at correct third-slot offset 256 (catches b/bytesPerVector arithmetic)', () => {
        // With 3 batches, mutant `b/bytesPerVector` for b=2: 128/2=64 (wrong, should be 256)
        // Batch 2 data would land at output[64..191] instead of output[256..383] with the mutant
        const input = new Float32Array(3 * 1024);
        input.fill(-1, 0, 2048);   // batches 0+1: all negative → 0x00
        input.fill(1, 2048, 3072); // batch 2: all positive → 0xFF
        const result = packSignBits(input, 3, 1024);
        expect(result.length).toBe(384);
        // batch 2 bytes must be at indices 256..383, NOT at 64..191
        for(let i = 256; i < 384; i++) {
            expect(result[i]).toBe(0xFF);
        }
        // batch 0 and 1 bytes (indices 0..255) must be 0x00
        for(let i = 0; i < 256; i++) {
            expect(result[i]).toBe(0x00);
        }
    });

    it('throws when dim is not a multiple of 8', () => {
        const input = new Float32Array(7);
        expect(() => packSignBits(input, 1, 7)).toThrow('dim must be a positive multiple of 8, got 7');
    });

    it('throws when dim is 0', () => {
        const input = new Float32Array(0);
        expect(() => packSignBits(input, 1, 0)).toThrow('dim must be a positive multiple of 8, got 0');
    });

    it('produces identical output for identical input (deterministic)', () => {
        const input = new Float32Array(1024);
        for(let i = 0; i < 1024; i++) {
            input[i] = Math.sin(i); // pseudo-random but deterministic
        }
        const r1 = packSignBits(input, 1, 1024);
        const r2 = packSignBits(input, 1, 1024);
        expect(r1).toEqual(r2);
    });

    it('correctly handles dim=8 with a single positive value at each position', () => {
        // One bit set at a time — test each position
        for(let pos = 0; pos < 8; pos++) {
            const input = new Float32Array(8).fill(-1);
            input[pos] = 1;
            const result = packSignBits(input, 1, 8);
            // MSB-first: position 0 = bit 7, position 7 = bit 0
            const expectedBit = 7 - pos;
            // eslint-disable-next-line no-bitwise -- computing expected bit mask for MSB-first assertion
            expect(result[0]).toBe(1 << expectedBit);
        }
    });
});

import { describe, test, expect, afterEach } from 'bun:test';
import { mockHeicConvert, resetHeicConvertImpl } from '../../../../setup';
import { needsConversion, convert } from '@/utils/media/converters/heic';

describe('HEIC Image Converter', () => {
    afterEach(() => {
        resetHeicConvertImpl();
    });
    describe('needsConversion', () => {
        test('returns true for image/heic', () => {
            expect(needsConversion('image/heic')).toBe(true);
        });

        test('returns true for image/heif', () => {
            expect(needsConversion('image/heif')).toBe(true);
        });

        test('returns false for image/jpeg', () => {
            expect(needsConversion('image/jpeg')).toBe(false);
        });

        test('returns false for image/png', () => {
            expect(needsConversion('image/png')).toBe(false);
        });

        test('returns false for image/gif', () => {
            expect(needsConversion('image/gif')).toBe(false);
        });

        test('returns false for image/webp', () => {
            expect(needsConversion('image/webp')).toBe(false);
        });

        test('returns false for non-image types', () => {
            expect(needsConversion('application/pdf')).toBe(false);
            expect(needsConversion('text/plain')).toBe(false);
            expect(needsConversion('video/mp4')).toBe(false);
        });
    });

    describe('convert', () => {
        test('converts HEIC buffer to PNG buffer', async () => {
            const inputBuffer = Buffer.from('fake-heic-data');

            const result = await convert(inputBuffer, 'image/heic');

            expect(result.buffer).toBeInstanceOf(Buffer);
            expect(result.buffer.toString()).toBe('fake-png-data');
            expect(result.mediaType).toBe('image/png');
        });

        test('converts HEIF buffer to PNG buffer', async () => {
            const inputBuffer = Buffer.from('fake-heif-data');

            const result = await convert(inputBuffer, 'image/heif');

            expect(result.buffer).toBeInstanceOf(Buffer);
            expect(result.buffer.toString()).toBe('fake-png-data');
            expect(result.mediaType).toBe('image/png');
        });

        test('throws error for unsupported image types', async () => {
            const inputBuffer = Buffer.from('fake-jpeg-data');

            expect(convert(inputBuffer, 'image/jpeg')).rejects.toThrow(
                'Unsupported content type for conversion: image/jpeg'
            );
        });

        test('throws error for non-image types', async () => {
            const inputBuffer = Buffer.from('pdf-data');

            expect(convert(inputBuffer, 'application/pdf')).rejects.toThrow(
                'Unsupported content type for conversion: application/pdf'
            );
        });

        test('wraps heicConvert errors with context', async () => {
            mockHeicConvert.mockRejectedValueOnce(new Error('Invalid HEIC data'));

            const inputBuffer = Buffer.from('corrupt-heic-data');

            expect(convert(inputBuffer, 'image/heic')).rejects.toThrow(
                'HEIC conversion failed: Invalid HEIC data'
            );
        });

        test('preserves original error as cause on heicConvert failure', async () => {
            // This test kills the ObjectLiteral mutant: { cause: error } → {}
            // Without cause, err.cause would be undefined
            const originalError = new Error('Underlying HEIC parse failure');
            mockHeicConvert.mockRejectedValueOnce(originalError);

            const inputBuffer = Buffer.from('corrupt-heic-data');

            let caughtError: Error | undefined;
            try {
                await convert(inputBuffer, 'image/heic');
            } catch (err) {
                caughtError = err as Error;
            }

            expect(caughtError).toBeDefined();
            expect(caughtError?.message).toBe('HEIC conversion failed: Underlying HEIC parse failure');
            expect(caughtError?.cause).toBe(originalError);
        });
    });
});

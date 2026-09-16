import { describe, test, expect, afterEach } from 'bun:test';
import { mockHeicConvert, resetHeicConvertImpl } from '../../../../setup';
import { MediaProcessingError } from '@/errors';
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

        test('throws MediaProcessingError for unsupported image types', async () => {
            const inputBuffer = Buffer.from('fake-jpeg-data');

            let caughtError: unknown;
            try {
                await convert(inputBuffer, 'image/jpeg');
            } catch (err) {
                caughtError = err;
            }

            expect(caughtError).toBeInstanceOf(MediaProcessingError);
            expect((caughtError as MediaProcessingError).message).toBe('Unsupported content type for conversion: image/jpeg');
            expect((caughtError as MediaProcessingError).context.operation).toBe('heic-convert');
        });

        test('throws error for non-image types', async () => {
            const inputBuffer = Buffer.from('pdf-data');

            await expect(convert(inputBuffer, 'application/pdf')).rejects.toThrow(
                'Unsupported content type for conversion: application/pdf'
            );
        });

        test('throws MediaProcessingError and wraps heicConvert errors with context', async () => {
            mockHeicConvert.mockRejectedValueOnce(new Error('Invalid HEIC data'));

            const inputBuffer = Buffer.from('corrupt-heic-data');

            let caughtError: unknown;
            try {
                await convert(inputBuffer, 'image/heic');
            } catch (err) {
                caughtError = err;
            }

            expect(caughtError).toBeInstanceOf(MediaProcessingError);
            expect((caughtError as MediaProcessingError).message).toBe('HEIC conversion failed: Invalid HEIC data');
            expect((caughtError as MediaProcessingError).context.operation).toBe('heic-convert');
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

        test('wraps the input in a plain Uint8Array copy rather than passing the Buffer through', async () => {
            // Kills the llm mutant that drops `new Uint8Array(buffer)` down to bare `buffer`:
            // a Buffer is-a Uint8Array, so a type check alone can't tell them apart — but
            // Buffer.isBuffer distinguishes the wrapped copy (plain Uint8Array) from the
            // original Buffer instance flowing straight through unwrapped.
            const inputBuffer = Buffer.from('fake-heic-data');

            await convert(inputBuffer, 'image/heic');

            expect(mockHeicConvert).toHaveBeenCalledTimes(1);
            const passedBuffer = mockHeicConvert.mock.calls[0][0].buffer;
            expect(Buffer.isBuffer(passedBuffer)).toBe(false);
            expect(passedBuffer).toBeInstanceOf(Uint8Array);
            expect([...(passedBuffer as unknown as Uint8Array)]).toEqual([...inputBuffer]);
        });

        test('reports the stringified error when heicConvert rejects with a non-Error value', async () => {
            // Kills the llm mutant that replaces `String(error)` with `''` in the catch
            // branch's non-Error fallback: a rejection that isn't an Error instance must
            // still surface its stringified value in the wrapped error message.
            mockHeicConvert.mockRejectedValueOnce('raw string failure');

            const inputBuffer = Buffer.from('corrupt-heic-data');

            let caughtError: unknown;
            try {
                await convert(inputBuffer, 'image/heic');
            } catch (err) {
                caughtError = err;
            }

            expect(caughtError).toBeInstanceOf(MediaProcessingError);
            expect((caughtError as MediaProcessingError).message).toBe('HEIC conversion failed: raw string failure');
        });
    });
});

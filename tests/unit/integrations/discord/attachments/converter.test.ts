import { describe, test, expect, afterEach } from 'bun:test';
import { needsConversion, convert } from '@/integrations/discord/attachments/converter';
import { mockHeicConvert, resetHeicConvertImpl } from '../../../../setup';

describe('Image Converter', () => {
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

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
            await expect(convert(inputBuffer, 'image/jpeg')).rejects.toThrow(
                'Unsupported content type for conversion: image/jpeg'
            );
        });

        test('throws error for non-image types', async () => {
            const inputBuffer = Buffer.from('pdf-data');

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
            await expect(convert(inputBuffer, 'application/pdf')).rejects.toThrow(
                'Unsupported content type for conversion: application/pdf'
            );
        });

        test('wraps heicConvert errors with context', async () => {
            mockHeicConvert.mockRejectedValueOnce(new Error('Invalid HEIC data'));

            const inputBuffer = Buffer.from('corrupt-heic-data');

            // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
            await expect(convert(inputBuffer, 'image/heic')).rejects.toThrow(
                'HEIC conversion failed: Invalid HEIC data'
            );
        });
    });
});

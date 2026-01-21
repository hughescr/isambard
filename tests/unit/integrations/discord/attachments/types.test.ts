import { describe, test, expect } from 'bun:test';
import {
    NATIVE_IMAGE_TYPES,
    CONVERTIBLE_IMAGE_TYPES,
    SUPPORTED_IMAGE_TYPES,
    MAX_IMAGE_SIZE_BYTES,
    AttachmentMetadataSchema,
    FetchedImageSchema,
    StoredAttachmentSchema,
    isNativeImageType,
    isConvertibleImageType,
    isSupportedImageType
} from '@/integrations/discord/attachments/types';

describe('Discord Attachment Types', () => {
    describe('Constants', () => {
        test('NATIVE_IMAGE_TYPES contains correct MIME types', () => {
            expect(NATIVE_IMAGE_TYPES).toEqual(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
        });

        test('CONVERTIBLE_IMAGE_TYPES contains correct MIME types', () => {
            expect(CONVERTIBLE_IMAGE_TYPES).toEqual(['image/heic', 'image/heif']);
        });

        test('SUPPORTED_IMAGE_TYPES is union of native and convertible types', () => {
            expect(SUPPORTED_IMAGE_TYPES).toEqual([
                'image/jpeg',
                'image/png',
                'image/gif',
                'image/webp',
                'image/heic',
                'image/heif',
            ]);
        });

        test('MAX_IMAGE_SIZE_BYTES is 20MB', () => {
            expect(MAX_IMAGE_SIZE_BYTES).toBe(20 * 1024 * 1024);
        });
    });

    describe('AttachmentMetadataSchema', () => {
        test('validates correct attachment metadata', () => {
            const validData = {
                url:         'https://cdn.discord.com/attachments/123/456/image.png',
                filename:    'image.png',
                contentType: 'image/png',
                size:        1024,
                width:       800,
                height:      600,
            };

            const result = AttachmentMetadataSchema.safeParse(validData);
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data).toEqual(validData);
            }
        });

        test('validates metadata without optional width/height', () => {
            const validData = {
                url:         'https://cdn.discord.com/attachments/123/456/file.pdf',
                filename:    'file.pdf',
                contentType: 'application/pdf',
                size:        2048,
            };

            const result = AttachmentMetadataSchema.safeParse(validData);
            expect(result.success).toBe(true);
        });

        test('rejects invalid URL', () => {
            const invalidData = {
                url:         'not-a-url',
                filename:    'image.png',
                contentType: 'image/png',
                size:        1024,
            };

            const result = AttachmentMetadataSchema.safeParse(invalidData);
            expect(result.success).toBe(false);
        });

        test('rejects negative size', () => {
            const invalidData = {
                url:         'https://cdn.discord.com/attachments/123/456/image.png',
                filename:    'image.png',
                contentType: 'image/png',
                size:        -1,
            };

            const result = AttachmentMetadataSchema.safeParse(invalidData);
            expect(result.success).toBe(false);
        });

        test('rejects missing required fields', () => {
            const invalidData = {
                url: 'https://cdn.discord.com/attachments/123/456/image.png',
            };

            const result = AttachmentMetadataSchema.safeParse(invalidData);
            expect(result.success).toBe(false);
        });
    });

    describe('FetchedImageSchema', () => {
        test('validates correct fetched image', () => {
            const validData = {
                filename:     'image.png',
                mediaType:    'image/png' as const,
                base64Data:   'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                originalSize: 1024,
                width:        800,
                height:       600,
            };

            const result = FetchedImageSchema.safeParse(validData);
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data).toEqual(validData);
            }
        });

        test('validates fetched image without optional dimensions', () => {
            const validData = {
                filename:     'image.jpg',
                mediaType:    'image/jpeg' as const,
                base64Data:   'base64string',
                originalSize: 2048,
            };

            const result = FetchedImageSchema.safeParse(validData);
            expect(result.success).toBe(true);
        });

        test('accepts all native media types', () => {
            const mediaTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

            for(const mediaType of mediaTypes) {
                const data = {
                    filename:     'test.img',
                    mediaType,
                    base64Data:   'data',
                    originalSize: 100,
                };

                const result = FetchedImageSchema.safeParse(data);
                expect(result.success).toBe(true);
            }
        });

        test('rejects unsupported media types', () => {
            const invalidData = {
                filename:     'image.heic',
                mediaType:    'image/heic',
                base64Data:   'data',
                originalSize: 100,
            };

            const result = FetchedImageSchema.safeParse(invalidData);
            expect(result.success).toBe(false);
        });

        test('rejects negative originalSize', () => {
            const invalidData = {
                filename:     'image.png',
                mediaType:    'image/png' as const,
                base64Data:   'data',
                originalSize: -1,
            };

            const result = FetchedImageSchema.safeParse(invalidData);
            expect(result.success).toBe(false);
        });
    });

    describe('StoredAttachmentSchema', () => {
        test('validates correct stored attachment', () => {
            const validData = {
                localPath:        '/tmp/attachments/file-123.pdf',
                originalFilename: 'document.pdf',
                contentType:      'application/pdf',
                size:             4096,
            };

            const result = StoredAttachmentSchema.safeParse(validData);
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data).toEqual(validData);
            }
        });

        test('rejects negative size', () => {
            const invalidData = {
                localPath:        '/tmp/file.pdf',
                originalFilename: 'file.pdf',
                contentType:      'application/pdf',
                size:             -100,
            };

            const result = StoredAttachmentSchema.safeParse(invalidData);
            expect(result.success).toBe(false);
        });

        test('rejects missing required fields', () => {
            const invalidData = {
                localPath: '/tmp/file.pdf',
            };

            const result = StoredAttachmentSchema.safeParse(invalidData);
            expect(result.success).toBe(false);
        });
    });

    describe('Type Guards', () => {
        describe('isNativeImageType', () => {
            test('returns true for native image types', () => {
                expect(isNativeImageType('image/jpeg')).toBe(true);
                expect(isNativeImageType('image/png')).toBe(true);
                expect(isNativeImageType('image/gif')).toBe(true);
                expect(isNativeImageType('image/webp')).toBe(true);
            });

            test('returns false for convertible image types', () => {
                expect(isNativeImageType('image/heic')).toBe(false);
                expect(isNativeImageType('image/heif')).toBe(false);
            });

            test('returns false for non-image types', () => {
                expect(isNativeImageType('application/pdf')).toBe(false);
                expect(isNativeImageType('text/plain')).toBe(false);
                expect(isNativeImageType('video/mp4')).toBe(false);
            });
        });

        describe('isConvertibleImageType', () => {
            test('returns true for convertible image types', () => {
                expect(isConvertibleImageType('image/heic')).toBe(true);
                expect(isConvertibleImageType('image/heif')).toBe(true);
            });

            test('returns false for native image types', () => {
                expect(isConvertibleImageType('image/jpeg')).toBe(false);
                expect(isConvertibleImageType('image/png')).toBe(false);
                expect(isConvertibleImageType('image/gif')).toBe(false);
                expect(isConvertibleImageType('image/webp')).toBe(false);
            });

            test('returns false for non-image types', () => {
                expect(isConvertibleImageType('application/pdf')).toBe(false);
                expect(isConvertibleImageType('text/plain')).toBe(false);
            });
        });

        describe('isSupportedImageType', () => {
            test('returns true for all native image types', () => {
                expect(isSupportedImageType('image/jpeg')).toBe(true);
                expect(isSupportedImageType('image/png')).toBe(true);
                expect(isSupportedImageType('image/gif')).toBe(true);
                expect(isSupportedImageType('image/webp')).toBe(true);
            });

            test('returns true for all convertible image types', () => {
                expect(isSupportedImageType('image/heic')).toBe(true);
                expect(isSupportedImageType('image/heif')).toBe(true);
            });

            test('returns false for unsupported types', () => {
                expect(isSupportedImageType('application/pdf')).toBe(false);
                expect(isSupportedImageType('text/plain')).toBe(false);
                expect(isSupportedImageType('video/mp4')).toBe(false);
                expect(isSupportedImageType('image/svg+xml')).toBe(false);
            });
        });
    });
});

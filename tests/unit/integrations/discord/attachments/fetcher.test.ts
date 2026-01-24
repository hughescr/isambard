/* eslint-disable n/no-unsupported-features/node-builtins -- Bun runtime supports fetch and Response */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { fetchImage, fetchImages, saveNonImageAttachment } from '@/integrations/discord/attachments/fetcher';
import type { AttachmentMetadata } from '@/integrations/discord/attachments/types';
import { MAX_IMAGE_SIZE_BYTES } from '@/integrations/discord/attachments/types';

// Mock heic-convert (the converter will use this mock)
void mock.module('heic-convert', () => ({
    'default': mock(async (_options: { buffer: ArrayBufferLike, format: string }) => {
        return Buffer.from('converted-png-data');
    }),
}));

// Mock fs operations
const mockMkdir = mock(async (_path: string, _options?: { recursive?: boolean }) => undefined);
const mockWriteFile = mock(async (_path: string, _data: Buffer) => undefined);

void mock.module('node:fs/promises', () => ({
    mkdir:     mockMkdir,
    writeFile: mockWriteFile,
}));

// Mock global fetch
const mockFetch = mock(async (_url: string, _options?: RequestInit): Promise<Response> => {
    throw new Error('Fetch not mocked for this test');
});

// Store original fetch
const originalFetch = globalThis.fetch;

describe('Attachment Fetcher', () => {
    beforeEach(() => {
        mockMkdir.mockClear();
        mockWriteFile.mockClear();
        mockFetch.mockClear();
        // Replace global fetch with our mock for testing
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- Testing mock needs to override global fetch type
        globalThis.fetch = mockFetch as any;
    });

    afterEach(() => {
        // Restore original fetch
        globalThis.fetch = originalFetch;
    });

    describe('fetchImage', () => {
        test('fetches and returns native image (jpeg) as base64', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/image.jpg',
                filename:    'image.jpg',
                contentType: 'image/jpeg',
                size:        1024,
                width:       800,
                height:      600,
            };

            const imageData = Buffer.from('fake-jpeg-data');
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => imageData.buffer,
            } as Response);

            const result = await fetchImage(metadata);

            expect(result).not.toBeNull();
            expect(result?.success).toBe(true);
            if(result?.success) {
                expect(result.image.filename).toBe('image.jpg');
                expect(result.image.mediaType).toBe('image/jpeg');
                expect(result.image.base64Data).toBe(imageData.toString('base64'));
                expect(result.image.originalSize).toBe(1024);
                expect(result.image.width).toBe(800);
                expect(result.image.height).toBe(600);
            }
            // Native image types don't need conversion
        });

        test('fetches and returns native image (png) as base64', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/image.png',
                filename:    'image.png',
                contentType: 'image/png',
                size:        2048,
            };

            const imageData = Buffer.from('fake-png-data');
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => imageData.buffer,
            } as Response);

            const result = await fetchImage(metadata);

            expect(result).not.toBeNull();
            expect(result?.success).toBe(true);
            if(result?.success) {
                expect(result.image.filename).toBe('image.png');
                expect(result.image.mediaType).toBe('image/png');
                expect(result.image.base64Data).toBe(imageData.toString('base64'));
                expect(result.image.originalSize).toBe(2048);
            }
            // Native image types don't need conversion
        });

        test('fetches and returns native image (gif) as base64', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/image.gif',
                filename:    'image.gif',
                contentType: 'image/gif',
                size:        512,
            };

            const imageData = Buffer.from('fake-gif-data');
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => imageData.buffer,
            } as Response);

            const result = await fetchImage(metadata);

            expect(result).not.toBeNull();
            expect(result?.success).toBe(true);
            if(result?.success) {
                expect(result.image.filename).toBe('image.gif');
                expect(result.image.mediaType).toBe('image/gif');
                expect(result.image.base64Data).toBe(imageData.toString('base64'));
            }
            // Native image types don't need conversion
        });

        test('fetches and returns native image (webp) as base64', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/image.webp',
                filename:    'image.webp',
                contentType: 'image/webp',
                size:        1536,
            };

            const imageData = Buffer.from('fake-webp-data');
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => imageData.buffer,
            } as Response);

            const result = await fetchImage(metadata);

            expect(result).not.toBeNull();
            expect(result?.success).toBe(true);
            if(result?.success) {
                expect(result.image.filename).toBe('image.webp');
                expect(result.image.mediaType).toBe('image/webp');
                expect(result.image.base64Data).toBe(imageData.toString('base64'));
            }
            // Native image types don't need conversion
        });

        test('fetches HEIC, converts to PNG, returns as base64', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/image.heic',
                filename:    'image.heic',
                contentType: 'image/heic',
                size:        2048,
                width:       1024,
                height:      768,
            };

            const heicData = Buffer.from('fake-heic-data');
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => heicData.buffer,
            } as Response);

            const result = await fetchImage(metadata);

            expect(result).not.toBeNull();
            expect(result?.success).toBe(true);
            if(result?.success) {
                expect(result.image.filename).toBe('image.heic');
                expect(result.image.mediaType).toBe('image/png');
                expect(result.image.base64Data).toBe(Buffer.from('converted-png-data').toString('base64'));
                expect(result.image.originalSize).toBe(2048);
                expect(result.image.width).toBe(1024);
                expect(result.image.height).toBe(768);
            }
        });

        test('fetches HEIF, converts to PNG, returns as base64', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/image.heif',
                filename:    'image.heif',
                contentType: 'image/heif',
                size:        3072,
            };

            const heifData = Buffer.from('fake-heif-data');
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => heifData.buffer,
            } as Response);

            const result = await fetchImage(metadata);

            expect(result).not.toBeNull();
            expect(result?.success).toBe(true);
            if(result?.success) {
                expect(result.image.filename).toBe('image.heif');
                expect(result.image.mediaType).toBe('image/png');
                expect(result.image.base64Data).toBe(Buffer.from('converted-png-data').toString('base64'));
            }
        });

        test('allows images exactly at MAX_IMAGE_SIZE_BYTES', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/exact-size.jpg',
                filename:    'exact-size.jpg',
                contentType: 'image/jpeg',
                size:        MAX_IMAGE_SIZE_BYTES, // Exactly at limit, not over
            };

            const imageData = Buffer.from('fake-jpeg-data');
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => imageData.buffer,
            } as Response);

            const result = await fetchImage(metadata);

            expect(result).not.toBeNull();
            expect(result?.success).toBe(true);
            if(result?.success) {
                expect(result.image.filename).toBe('exact-size.jpg');
                expect(result.image.mediaType).toBe('image/jpeg');
                expect(result.image.base64Data).toBe(imageData.toString('base64'));
            }
        });

        test('skips images exceeding MAX_IMAGE_SIZE_BYTES', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/huge.jpg',
                filename:    'huge.jpg',
                contentType: 'image/jpeg',
                size:        MAX_IMAGE_SIZE_BYTES + 1,
            };

            const result = await fetchImage(metadata);

            expect(result).toBeNull();
            expect(mockFetch).not.toHaveBeenCalled();
        });

        test('skips non-image attachments', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/document.pdf',
                filename:    'document.pdf',
                contentType: 'application/pdf',
                size:        1024,
            };

            const result = await fetchImage(metadata);

            expect(result).toBeNull();
            expect(mockFetch).not.toHaveBeenCalled();
        });

        test('returns failure info on fetch error', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/image.jpg',
                filename:    'image.jpg',
                contentType: 'image/jpeg',
                size:        1024,
            };

            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            const result = await fetchImage(metadata);

            expect(result).not.toBeNull();
            expect(result?.success).toBe(false);
            if(result && !result.success) {
                expect(result.failure.filename).toBe('image.jpg');
                expect(result.failure.contentType).toBe('image/jpeg');
                expect(result.failure.size).toBe(1024);
                expect(result.failure.error).toContain('Network error');
            }
        });

        test('returns failure info on non-ok response', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/image.jpg',
                filename:    'image.jpg',
                contentType: 'image/jpeg',
                size:        1024,
            };

            const arrayBufferMock = mock(async () => {
                throw new Error('arrayBuffer should not be called when response.ok is false');
            });

            mockFetch.mockResolvedValueOnce({
                ok:          false,
                status:      404,
                statusText:  'Not Found',
                arrayBuffer: arrayBufferMock,
            } as unknown as Response);

            const result = await fetchImage(metadata);

            expect(result).not.toBeNull();
            expect(result?.success).toBe(false);
            if(result && !result.success) {
                expect(result.failure.filename).toBe('image.jpg');
                expect(result.failure.contentType).toBe('image/jpeg');
                expect(result.failure.size).toBe(1024);
                expect(result.failure.error).toContain('HTTP');
            }
            expect(arrayBufferMock).not.toHaveBeenCalled();
        });

        test('returns failure info when HEIC conversion fails', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/image.heic',
                filename:    'image.heic',
                contentType: 'image/heic',
                size:        2048,
            };

            const heicData = Buffer.from('corrupt-heic-data');
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => heicData.buffer,
            } as Response);

            // Make heic-convert throw
            const heicConvert = (await import('heic-convert')).default as unknown as ReturnType<typeof mock>;
            heicConvert.mockRejectedValueOnce(new Error('Invalid HEIC data'));

            const result = await fetchImage(metadata);

            expect(result).not.toBeNull();
            expect(result?.success).toBe(false);
            if(result && !result.success) {
                expect(result.failure.filename).toBe('image.heic');
                expect(result.failure.error).toContain('Invalid HEIC data');
            }
        });

        // Note: Conversion error handling is tested in converter.test.ts
        // The fetcher will catch any errors from the converter and return failure info
    });

    describe('fetchImages', () => {
        test('processes multiple attachments in parallel', async () => {
            const attachments: AttachmentMetadata[] = [
                {
                    url:         'https://example.com/image1.jpg',
                    filename:    'image1.jpg',
                    contentType: 'image/jpeg',
                    size:        1024,
                },
                {
                    url:         'https://example.com/image2.png',
                    filename:    'image2.png',
                    contentType: 'image/png',
                    size:        2048,
                },
                {
                    url:         'https://example.com/image3.gif',
                    filename:    'image3.gif',
                    contentType: 'image/gif',
                    size:        512,
                },
            ];

            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => Buffer.from('jpeg-data').buffer,
            } as Response);
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => Buffer.from('png-data').buffer,
            } as Response);
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => Buffer.from('gif-data').buffer,
            } as Response);

            const result = await fetchImages(attachments);

            expect(result.images).toHaveLength(3);
            expect(result.failures).toHaveLength(0);
            expect(result.images[0]?.filename).toBe('image1.jpg');
            expect(result.images[1]?.filename).toBe('image2.png');
            expect(result.images[2]?.filename).toBe('image3.gif');
        });

        test('separates successful fetches from skipped attachments', async () => {
            const attachments: AttachmentMetadata[] = [
                {
                    url:         'https://example.com/image1.jpg',
                    filename:    'image1.jpg',
                    contentType: 'image/jpeg',
                    size:        1024,
                },
                {
                    url:         'https://example.com/image2.jpg',
                    filename:    'image2.jpg',
                    contentType: 'image/jpeg',
                    size:        MAX_IMAGE_SIZE_BYTES + 1, // Too large - skipped
                },
                {
                    url:         'https://example.com/image3.jpg',
                    filename:    'image3.jpg',
                    contentType: 'image/jpeg',
                    size:        2048,
                },
            ];

            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => Buffer.from('jpeg-data-1').buffer,
            } as Response);
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => Buffer.from('jpeg-data-3').buffer,
            } as Response);

            const result = await fetchImages(attachments);

            expect(result.images).toHaveLength(2);
            expect(result.failures).toHaveLength(0); // Skipped items don't appear in failures
            expect(result.images[0]?.filename).toBe('image1.jpg');
            expect(result.images[1]?.filename).toBe('image3.jpg');
        });

        test('separates successful fetches from failures', async () => {
            const attachments: AttachmentMetadata[] = [
                {
                    url:         'https://example.com/image1.jpg',
                    filename:    'image1.jpg',
                    contentType: 'image/jpeg',
                    size:        1024,
                },
                {
                    url:         'https://example.com/image2.jpg',
                    filename:    'image2.jpg',
                    contentType: 'image/jpeg',
                    size:        2048,
                },
            ];

            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => Buffer.from('jpeg-data-1').buffer,
            } as Response);
            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            const result = await fetchImages(attachments);

            expect(result.images).toHaveLength(1);
            expect(result.failures).toHaveLength(1);
            expect(result.images[0]?.filename).toBe('image1.jpg');
            expect(result.failures[0]?.filename).toBe('image2.jpg');
            expect(result.failures[0]?.error).toContain('Network error');
        });

        test('returns empty arrays when all fetches are skipped', async () => {
            const attachments: AttachmentMetadata[] = [
                {
                    url:         'https://example.com/image1.jpg',
                    filename:    'image1.jpg',
                    contentType: 'image/jpeg',
                    size:        MAX_IMAGE_SIZE_BYTES + 1, // Too large
                },
                {
                    url:         'https://example.com/document.pdf',
                    filename:    'document.pdf',
                    contentType: 'application/pdf',
                    size:        1024, // Not an image
                },
            ];

            const result = await fetchImages(attachments);

            expect(result.images).toHaveLength(0);
            expect(result.failures).toHaveLength(0);
        });

        test('returns empty arrays for empty input', async () => {
            const result = await fetchImages([]);

            expect(result.images).toHaveLength(0);
            expect(result.failures).toHaveLength(0);
        });
    });

    describe('saveNonImageAttachment', () => {
        test('downloads file to scratch directory', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/document.pdf',
                filename:    'document.pdf',
                contentType: 'application/pdf',
                size:        4096,
            };

            const fileData = Buffer.from('pdf-content');
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => fileData.buffer,
            } as Response);

            const result = await saveNonImageAttachment(metadata, '/tmp/scratch', 'msg123');

            expect(result).not.toBeNull();
            expect(result?.localPath).toBe('/tmp/scratch/attachments/msg123/document.pdf');
            expect(result?.originalFilename).toBe('document.pdf');
            expect(result?.contentType).toBe('application/pdf');
            expect(result?.size).toBe(4096);

            expect(mockMkdir).toHaveBeenCalledWith('/tmp/scratch/attachments/msg123', { recursive: true });
            expect(mockWriteFile).toHaveBeenCalledWith('/tmp/scratch/attachments/msg123/document.pdf', fileData);
        });

        test('creates nested directory structure', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/archive.zip',
                filename:    'archive.zip',
                contentType: 'application/zip',
                size:        8192,
            };

            const fileData = Buffer.from('zip-content');
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => fileData.buffer,
            } as Response);

            await saveNonImageAttachment(metadata, '/some/deep/path', 'msg456');

            expect(mockMkdir).toHaveBeenCalledWith('/some/deep/path/attachments/msg456', { recursive: true });
        });

        test('handles fetch errors gracefully (returns null)', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/document.pdf',
                filename:    'document.pdf',
                contentType: 'application/pdf',
                size:        4096,
            };

            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            const result = await saveNonImageAttachment(metadata, '/tmp/scratch', 'msg123');

            expect(result).toBeNull();
        });

        test('handles non-ok response (returns null)', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/document.pdf',
                filename:    'document.pdf',
                contentType: 'application/pdf',
                size:        4096,
            };

            const arrayBufferMock = mock(async () => {
                throw new Error('arrayBuffer should not be called when response.ok is false');
            });

            mockFetch.mockResolvedValueOnce({
                ok:          false,
                arrayBuffer: arrayBufferMock,
            } as unknown as Response);

            const result = await saveNonImageAttachment(metadata, '/tmp/scratch', 'msg123');

            expect(result).toBeNull();
            expect(arrayBufferMock).not.toHaveBeenCalled();
        });

        test('handles filesystem errors gracefully (returns null)', async () => {
            const metadata: AttachmentMetadata = {
                url:         'https://example.com/document.pdf',
                filename:    'document.pdf',
                contentType: 'application/pdf',
                size:        4096,
            };

            const fileData = Buffer.from('pdf-content');
            mockFetch.mockResolvedValueOnce({
                ok:          true,
                arrayBuffer: async () => fileData.buffer,
            } as Response);

            mockWriteFile.mockRejectedValueOnce(new Error('Write failed'));

            const result = await saveNonImageAttachment(metadata, '/tmp/scratch', 'msg123');

            expect(result).toBeNull();
        });
    });
});

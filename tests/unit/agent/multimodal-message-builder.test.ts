import { describe, test, expect } from 'bun:test';
import _ from 'lodash';
import { buildMultimodalContent, hasImages } from '@/agent/multimodal-message-builder';
import type { PlatformImage } from '@/agent/types';

describe.concurrent('multimodal-message-builder', () => {
    describe('buildMultimodalContent', () => {
        test('should return single text block when no images provided', () => {
            const text = 'Hello, world!';
            const result = buildMultimodalContent(text);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'text', text: 'Hello, world!' });
            // Verify no image blocks exist (kills ConditionalExpression mutant)
            expect(_.filter(result, { type: 'image' })).toHaveLength(0);
        });

        test('should return single text block when images array is empty', () => {
            // Mutant 1423: images.length > 0 → images.length >= 0
            // If mutated, empty array (length=0) would match >= 0 and try to iterate
            const text = 'Hello, world!';
            const result = buildMultimodalContent(text, []);

            // Should have exactly 1 block (text only)
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'text', text: 'Hello, world!' });
            // Verify no image blocks exist
            expect(_.filter(result, { type: 'image' })).toHaveLength(0);
            // Verify all blocks are text
            expect(_.every(result, { type: 'text' })).toBe(true);
        });

        test('should not add image blocks when images is undefined', () => {
            const result = buildMultimodalContent('test', undefined);
            expect(result).toHaveLength(1);
            expect(_.every(result, { type: 'text' })).toBe(true);
        });

        test('should skip image loop when images is undefined', () => {
            // Mutant 1422: if(images && images.length > 0) → if(true)
            // If mutated, would execute for loop with undefined images causing TypeError
            const result = buildMultimodalContent('test', undefined);
            // Result should have exactly 1 block (text only, no images)
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('text');
            // Verify no image blocks were added
            const imageBlocks = _.filter(result, { type: 'image' });
            expect(imageBlocks).toHaveLength(0);
        });

        test('should return image blocks then text block when images provided', () => {
            const text = 'Check out this image!';
            const images: PlatformImage[] = [
                {
                    filename:     'test.jpg',
                    mediaType:    'image/jpeg',
                    base64Data:   'base64encodeddata',
                    originalSize: 1024,
                    width:        800,
                    height:       600,
                },
            ];

            const result = buildMultimodalContent(text, images);

            expect(result).toEqual([
                {
                    type:   'image',
                    source: {
                        type:       'base64',
                        media_type: 'image/jpeg',
                        data:       'base64encodeddata',
                    },
                },
                { type: 'text', text: 'Check out this image!' },
            ]);
        });

        test('should handle multiple images and preserve order', () => {
            const text = 'Multiple images';
            const images: PlatformImage[] = [
                {
                    filename:     'first.png',
                    mediaType:    'image/png',
                    base64Data:   'first-image-data',
                    originalSize: 2048,
                },
                {
                    filename:     'second.gif',
                    mediaType:    'image/gif',
                    base64Data:   'second-image-data',
                    originalSize: 512,
                },
                {
                    filename:     'third.webp',
                    mediaType:    'image/webp',
                    base64Data:   'third-image-data',
                    originalSize: 1536,
                },
            ];

            const result = buildMultimodalContent(text, images);

            expect(result).toHaveLength(4); // 3 images + 1 text
            expect(result[0]).toEqual({
                type:   'image',
                source: {
                    type:       'base64',
                    media_type: 'image/png',
                    data:       'first-image-data',
                },
            });
            expect(result[1]).toEqual({
                type:   'image',
                source: {
                    type:       'base64',
                    media_type: 'image/gif',
                    data:       'second-image-data',
                },
            });
            expect(result[2]).toEqual({
                type:   'image',
                source: {
                    type:       'base64',
                    media_type: 'image/webp',
                    data:       'third-image-data',
                },
            });
            expect(result[3]).toEqual({
                type: 'text',
                text: 'Multiple images',
            });
        });

        test('should handle images without optional width/height properties', () => {
            const text = 'Image without dimensions';
            const images: PlatformImage[] = [
                {
                    filename:     'no-dims.jpg',
                    mediaType:    'image/jpeg',
                    base64Data:   'image-data',
                    originalSize: 1024,
                },
            ];

            const result = buildMultimodalContent(text, images);

            expect(result).toEqual([
                {
                    type:   'image',
                    source: {
                        type:       'base64',
                        media_type: 'image/jpeg',
                        data:       'image-data',
                    },
                },
                { type: 'text', text: 'Image without dimensions' },
            ]);
        });
    });

    describe('hasImages', () => {
        test('should return false when images is undefined', () => {
            expect(hasImages(undefined)).toBe(false);
        });

        test('should return false when images array is empty', () => {
            expect(hasImages([])).toBe(false);
        });

        test('should return true when images array is non-empty', () => {
            const images: PlatformImage[] = [
                {
                    filename:     'test.jpg',
                    mediaType:    'image/jpeg',
                    base64Data:   'data',
                    originalSize: 1024,
                },
            ];
            expect(hasImages(images)).toBe(true);
        });

        test('should return true when images array has multiple items', () => {
            const images: PlatformImage[] = [
                {
                    filename:     'test1.jpg',
                    mediaType:    'image/jpeg',
                    base64Data:   'data1',
                    originalSize: 1024,
                },
                {
                    filename:     'test2.png',
                    mediaType:    'image/png',
                    base64Data:   'data2',
                    originalSize: 2048,
                },
            ];
            expect(hasImages(images)).toBe(true);
        });
    });
});

/**
 * Multimodal message builder for constructing Anthropic API content blocks.
 *
 * Handles building message content that combines text and images for Claude's multimodal capabilities.
 */

import type { PlatformImage } from './types';

/**
 * Anthropic text content block.
 */
interface TextContentBlock {
    type: 'text'
    text: string
}

/**
 * Anthropic image content block with base64-encoded image data.
 */
interface ImageContentBlock {
    type:   'image'
    source: {
        type:       'base64'
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
        data:       string
    }
}

/**
 * Union type for all content block types.
 */
type ContentBlock = TextContentBlock | ImageContentBlock;

/**
 * Build multimodal content blocks for Anthropic API.
 *
 * Images are placed before the text block as this is optimal for Claude's processing.
 * The order matches Anthropic's best practices for multimodal input.
 *
 * @param text The text content
 * @param images Optional array of fetched images to include
 * @returns Array of content blocks (images first, then text)
 */
export function buildMultimodalContent(
    text: string,
    images?: PlatformImage[]
): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    // Add image blocks first (better for Claude's processing)
    // Stryker disable next-line EqualityOperator,ConditionalExpression: EqualityOperator >= 0 is equivalent (empty array loop runs 0 times); ConditionalExpression → true survives (concurrent test framework doesn't propagate TypeError to Stryker)
    if(images && images.length > 0) {
        for(const image of images) {
            blocks.push({
                type:   'image',
                source: {
                    type:       'base64',
                    media_type: image.mediaType,
                    data:       image.base64Data,
                },
            });
        }
    }

    // Add text block
    blocks.push({
        type: 'text',
        text,
    });

    return blocks;
}

/**
 * Check if images array contains any images.
 *
 * @param images Optional array of fetched images
 * @returns true if images array is non-empty, false otherwise
 */
export function hasImages(images?: PlatformImage[]): boolean {
    return images !== undefined && images.length > 0;
}

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
    // Stryker disable next-line llm: used only as an if condition; both forms are falsy for undefined and [], and truthy for every non-empty array.
    if(images?.length) {
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
    // Stryker disable next-line llm: images is typed PlatformImage[] | undefined, so `!= null` and the extra `!== null` conjunct agree with `!== undefined` on undefined and on every array; only a type-forbidden null differs.
    return images !== undefined && images.length > 0;
}

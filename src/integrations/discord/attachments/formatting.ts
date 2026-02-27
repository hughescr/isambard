import map from 'lodash/map';
import type { DiscordMessageContext } from '../types';

/**
 * Format bytes as human-readable string (e.g. "1.5MB", "245KB")
 */
export function formatBytes(bytes: number): string {
    if(bytes === 0) {
        return '0B';
    }
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${Math.round(bytes / k ** i)}${sizes[i]}`;
}

/**
 * Modifies message contexts to include attachment file path information.
 * Appends attachment descriptions to the first context's content only.
 *
 * @param contexts - Original message contexts
 * @param contentAdditions - Attachment descriptions to add
 * @returns Modified contexts with attachment info
 */
export function addAttachmentInfoToContexts(
    contexts: DiscordMessageContext[],
    contentAdditions: string[]
): DiscordMessageContext[] {
    if(contentAdditions.length === 0) {
        return contexts;
    }

    return map(contexts, (ctx, idx) => {
        // Only add attachment info to the first context
        if(idx === 0) {
            return {
                ...ctx,
                content: `${ctx.content}\n\n${contentAdditions.join('\n')}`,
            };
        }
        return ctx;
    });
}

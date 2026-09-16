import { logger } from '@hughescr/logger';
import type { ContextBuilder } from '@/agent';

/**
 * Loads identity context for presence idle status generation.
 *
 * Uses the context builder's core identity if available, falling back
 * to a default string. Returns undefined if no OAuth token is provided
 * (identity context requires API access).
 *
 * @param oauthToken - OAuth token (identity loading skipped if falsy)
 * @param contextBuilder - Optional context builder for loading from memory
 * @returns Identity context string, or undefined if no OAuth token
 */
export async function loadIdentityContext(
    oauthToken: string | undefined,
    contextBuilder?: ContextBuilder
): Promise<string | undefined> {
    if(!oauthToken) {
        return undefined;
    }

    // Try to load identity context from memory system
    if(contextBuilder) {
        try {
            return await contextBuilder.loadCoreIdentity() || 'Isambard - AI Assistant';
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn(`Failed to load identity context: ${errorMessage}`);
            return 'Isambard - AI Assistant';
        }
    }

    return 'Isambard - AI Assistant';
}

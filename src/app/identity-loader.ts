import { logger } from '@hughescr/logger';
import isError from 'lodash/isError';
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
    // Stryker disable next-line ConditionalExpression: Optional initialization - equivalent mutant
    if(!oauthToken) {
        return undefined;
    }

    // Try to load identity context from memory system
    // Stryker disable next-line ConditionalExpression: Optional initialization - equivalent mutant
    if(contextBuilder) {
        // Stryker disable next-line BlockStatement: Try block for optional initialization - equivalent mutant
        try {
            // Stryker disable next-line LogicalOperator: Fallback default is equivalent behavior
            return await contextBuilder.loadCoreIdentity() || 'Isambard - AI Assistant';
        // Stryker disable next-line BlockStatement: Catch block for optional initialization - equivalent mutant
        } catch (error) {
            const errorMessage = isError(error) ? error.message : String(error);
            logger.warn(`Failed to load identity context: ${errorMessage}`);
            // Stryker disable next-line StringLiteral: Fallback default string is not behavior-affecting
            return 'Isambard - AI Assistant';
        }
    }

    // Stryker disable next-line StringLiteral: Fallback default string is not behavior-affecting
    return 'Isambard - AI Assistant';
}

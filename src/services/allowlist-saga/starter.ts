import type { AllowlistSagaPlatform } from './types';

/**
 * Minimal interface for kicking off an allowlist saga from an approval handler.
 * Implemented by AllowlistInteractionHandler in the discord layer.
 *
 * This interface lives in services so that email and bsky approval handlers
 * can depend on it without creating a circular boundary violation
 * (email/bsky → discord is not permitted by the architecture).
 */
export interface AllowlistSagaStarter {
    /**
     * Kick off the allowlist saga for a given identifier.
     * Must be called AFTER deferUpdate() has already been issued by the caller.
     * Sends a followUp message to the interaction if a name is needed.
     */
    startFromApproval(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural duck type for Discord interaction; discord.js followUp overload doesn't match exact structural type
        interaction: { followUp: (options: any) => Promise<unknown> },
        platform: AllowlistSagaPlatform,
        identifierValue: string,
        displayNameHint?: string
    ): Promise<{ allowlistSuffix: string }>
}

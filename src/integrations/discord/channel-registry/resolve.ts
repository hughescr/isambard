import { createChannelId, type ChannelId } from '../../discord/types';
import type { ChannelRegistryManager } from './manager';

/**
 * Resolves a channel identifier to a numeric channel ID.
 *
 * Accepts either a numeric ID or a channel name with # prefix.
 * - If input starts with #, looks up the channel by name in the registry
 * - Otherwise, assumes the input is already a numeric ID and returns it as-is
 *
 * This enables tools to accept user-friendly channel names (e.g., #general)
 * instead of only numeric IDs (e.g., 1451694737026449581).
 *
 * @param input - Channel identifier (numeric ID or #channel-name)
 * @param channelRegistry - Channel registry manager for name lookups
 * @returns Resolved channel ID
 * @throws {Error} If channel name cannot be resolved
 *
 * @example
 * ```typescript
 * // Resolve by name
 * const id = resolveChannelId('#general', registry);
 * // Returns: '1451694737026449581'
 *
 * // Pass-through numeric ID
 * const id = resolveChannelId('1451694737026449581', registry);
 * // Returns: '1451694737026449581'
 * ```
 */
export function resolveChannelId(input: string, channelRegistry: ChannelRegistryManager): ChannelId {
    // If doesn't start with #, assume it's a numeric ID
    if(!input.startsWith('#')) {
        return createChannelId(input);
    }

    // Strip # and look up by name
    const channelName = input.slice(1);
    const allChannels = channelRegistry.getAllChannels();

    const matchingChannel = allChannels.find(ch => ch.channelName === channelName);

    if(!matchingChannel) {
        throw new Error(`Channel not found: ${channelName}`);
    }

    return matchingChannel.channelId;
}

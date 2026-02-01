/**
 * Admin script to mark Discord channels as well-known.
 *
 * Usage:
 *   bun run scripts/mark-well-known-channels.ts <guildId> <channelName> <type>
 *   bun run scripts/mark-well-known-channels.ts <guildId> --all
 *
 * Types: general, catch-up, perch-time
 *
 * Examples:
 *   # Mark #general as the default channel
 *   bun run scripts/mark-well-known-channels.ts 1451694736166359194 general general
 *
 *   # Mark #catch-up for catch-up session routing
 *   bun run scripts/mark-well-known-channels.ts 1451694736166359194 catch-up catch-up
 *
 *   # Mark #perch-time for perch session routing
 *   bun run scripts/mark-well-known-channels.ts 1451694736166359194 perch-time perch-time
 *
 *   # Mark all three default channels at once
 *   bun run scripts/mark-well-known-channels.ts 1451694736166359194 --all
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { ChannelRegistryBackend } from '../src/integrations/discord/channel-registry/backend';
import { createGuildId, type GuildId } from '../src/integrations/discord/types';
import { type WellKnownChannel, WELL_KNOWN_CHANNELS } from '../src/integrations/discord/channel-registry/types';

class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

class ChannelNotFoundError extends Error {
    constructor(channelName: string) {
        super(`Channel #${channelName} not found in guild. Has it been discovered yet? Hint: Send a message in the channel first to trigger discovery.`);
        this.name = 'ChannelNotFoundError';
    }
}

const DEFAULT_CHANNEL_NAMES: Record<WellKnownChannel, string> = {
    general:      'general',
    'catch-up':   'catch-up',
    'perch-time': 'perch-time',
};

async function main() {
    const args = process.argv.slice(2);

    if(args.length < 2) {
        throw new UsageError(
            'Usage: bun run scripts/mark-well-known-channels.ts <guildId> <channelName> <type>\n'
            + '       bun run scripts/mark-well-known-channels.ts <guildId> --all\n\n'
            + 'Types: general, catch-up, perch-time'
        );
    }

    const guildId = createGuildId(args[0]);
    const tableName = process.env.DYNAMODB_TABLE_NAME ?? 'IsambardTable';
    const region = process.env.AWS_REGION ?? 'us-west-2';

    logger.info({ tableName, region, msg: 'Connecting to DynamoDB' });

    // Create DynamoDB client
    const client = new DynamoDBClient({ region });
    const docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: {
            removeUndefinedValues:     true,
            convertClassInstanceToMap: true,
        },
        unmarshallOptions: {
            wrapNumbers: false,
        },
    });
    const backend = new ChannelRegistryBackend(docClient, tableName);

    if(args[1] === '--all') {
        // Mark all default well-known channels
        logger.info({ msg: 'Marking all default well-known channels' });
        for(const type of WELL_KNOWN_CHANNELS) {
            await markChannel(backend, guildId, DEFAULT_CHANNEL_NAMES[type], type);
        }
        logger.info({ msg: 'All default channels marked successfully' });
    } else {
        // Mark specific channel
        const channelName = args[1];
        const type = args[2] as WellKnownChannel;

        if(!type || !WELL_KNOWN_CHANNELS.includes(type)) {
            throw new UsageError(`Invalid type: ${type}. Must be one of: ${WELL_KNOWN_CHANNELS.join(', ')}`);
        }

        await markChannel(backend, guildId, channelName, type);
    }
}

async function markChannel(
    backend: ChannelRegistryBackend,
    guildId: GuildId,
    channelName: string,
    type: WellKnownChannel
): Promise<void> {
    logger.info({ channelName, guildId, msg: 'Looking for channel' });

    // Find the channel by name in the guild
    const channels = await backend.getChannelByName(channelName, guildId);

    if(channels.length === 0) {
        throw new ChannelNotFoundError(channelName);
    }

    if(channels.length > 1) {
        logger.warn({ channelName, count: channels.length, msg: 'Multiple channels found with same name, using first match' });
    }

    const channel = channels[0];
    logger.info({ channelId: channel.channelId, msg: 'Found channel' });

    // Mark as well-known
    await backend.markAsWellKnown(channel.channelId, type);
    logger.info({ channelName, type, channelId: channel.channelId, msg: 'Marked channel as well-known' });
}

main().catch((error: unknown) => {
    if(error instanceof UsageError) {
        logger.error({ msg: error.message });
    } else if(error instanceof ChannelNotFoundError) {
        logger.error({ msg: error.message });
    } else {
        logger.error({ error, msg: 'Unexpected error' });
    }
    throw error;
});

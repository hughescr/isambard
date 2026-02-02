/**
 * Admin script to mark Discord channels as well-known.
 *
 * Usage:
 *   bun run scripts/mark-well-known-channels.ts <channelId> <type>
 *
 * Types: general, catch-up, perch-time, fallback
 *
 * Examples:
 *   # Mark a channel as the default general channel
 *   bun run scripts/mark-well-known-channels.ts 1451694736166359197 general
 *
 *   # Mark a channel for catch-up session routing
 *   bun run scripts/mark-well-known-channels.ts 1451694736166359198 catch-up
 *
 *   # Mark a channel for perch session routing
 *   bun run scripts/mark-well-known-channels.ts 1451694736166359199 perch-time
 *
 *   # Mark a channel for fallback routing
 *   bun run scripts/mark-well-known-channels.ts 1451694736166359200 fallback
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { ChannelRegistryBackend } from '../src/integrations/discord/channel-registry/backend';
import { createChannelId, type ChannelId } from '../src/integrations/discord/types';
import { type WellKnownChannel, WELL_KNOWN_CHANNELS } from '../src/integrations/discord/channel-registry/types';

class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

class ChannelNotFoundError extends Error {
    constructor(channelId: ChannelId) {
        super(`Channel ${channelId} not found. Has it been discovered yet? Hint: Send a message in the channel first to trigger discovery.`);
        this.name = 'ChannelNotFoundError';
    }
}

async function main() {
    const args = process.argv.slice(2);

    if(args.length < 2) {
        throw new UsageError(
            'Usage: bun run scripts/mark-well-known-channels.ts <channelId> <type>\n\n'
            + 'Types: general, catch-up, perch-time, fallback'
        );
    }

    const channelId = createChannelId(args[0]);
    const type = args[1] as WellKnownChannel;

    if(!type || !WELL_KNOWN_CHANNELS.includes(type)) {
        throw new UsageError(`Invalid type: ${type}. Must be one of: ${WELL_KNOWN_CHANNELS.join(', ')}`);
    }

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

    await markChannel(backend, channelId, type);
}

async function markChannel(
    backend: ChannelRegistryBackend,
    channelId: ChannelId,
    type: WellKnownChannel
): Promise<void> {
    logger.info({ channelId, msg: 'Looking for channel' });

    // Verify channel exists in backend
    const channel = await backend.getChannel(channelId);

    if(!channel) {
        throw new ChannelNotFoundError(channelId);
    }

    logger.info({ channelId, guildId: channel.guildId, msg: 'Found channel' });

    // Mark as well-known
    await backend.markAsWellKnown(channelId, type);
    logger.info({ type, channelId, msg: 'Marked channel as well-known' });
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

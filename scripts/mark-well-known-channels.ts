/**
 * Admin script to mark Discord channels as well-known.
 *
 * Usage:
 *   sst shell -- bun run scripts/mark-well-known-channels.ts <channelId> <guildId> <type>
 *
 * Types: general, catch-up, perch-time, fallback
 *
 * Examples:
 *   # Mark a channel as the default general channel
 *   sst shell -- bun run scripts/mark-well-known-channels.ts 1451694736166359197 1451694736166359196 general
 *
 *   # Mark a channel for catch-up session routing
 *   sst shell -- bun run scripts/mark-well-known-channels.ts 1451694736166359198 1451694736166359196 catch-up
 *
 *   # Mark a channel for perch session routing
 *   sst shell -- bun run scripts/mark-well-known-channels.ts 1451694736166359199 1451694736166359196 perch-time
 *
 *   # Mark a channel for fallback routing
 *   sst shell -- bun run scripts/mark-well-known-channels.ts 1451694736166359200 1451694736166359196 fallback
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { Resource } from 'sst';
import { ChannelRegistryBackend } from '../src/integrations/discord/channel-registry/backend';
import { createChannelId, createGuildId, type ChannelId, type GuildId } from '../src/integrations/discord/types';
import { type WellKnownChannel, WELL_KNOWN_CHANNELS } from '../src/integrations/discord/channel-registry/types';
import { loadDynamoDBConfig, type DynamoDBResourceProvider } from '../src/config/loader';

class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

async function main() {
    const args = process.argv.slice(2);

    if(args.length < 3) {
        throw new UsageError(
            'Usage: sst shell -- bun run scripts/mark-well-known-channels.ts <channelId> <guildId> <type>\n\n'
            + 'Types: general, catch-up, perch-time, fallback'
        );
    }

    const channelId = createChannelId(args[0]);
    const guildId = createGuildId(args[1]);
    const type = args[2] as WellKnownChannel;

    if(!type || !WELL_KNOWN_CHANNELS.includes(type)) {
        throw new UsageError(`Invalid type: ${type}. Must be one of: ${WELL_KNOWN_CHANNELS.join(', ')}`);
    }

    // Load DynamoDB config from SST resources
    const dynamoConfig = loadDynamoDBConfig(Resource as unknown as DynamoDBResourceProvider);

    logger.info({ tableName: dynamoConfig.tableName, msg: 'Connecting to DynamoDB' });

    // Create DynamoDB client with default configuration
    const client = new DynamoDBClient({
        maxAttempts: 3,
    });
    const docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: {
            removeUndefinedValues:     true,
            convertClassInstanceToMap: true,
        },
        unmarshallOptions: {
            wrapNumbers: false,
        },
    });
    const backend = new ChannelRegistryBackend(docClient, dynamoConfig.tableName);

    await markChannel(backend, channelId, guildId, type);
}

async function markChannel(
    backend: ChannelRegistryBackend,
    channelId: ChannelId,
    guildId: GuildId,
    type: WellKnownChannel
): Promise<void> {
    logger.info({ channelId, guildId, type, msg: 'Pre-registering channel as well-known' });

    // Create channel storage record with well-known designation
    const now = new Date().toISOString();
    const record = {
        channelId,
        guildId,
        isMuted:     false,
        isWellKnown: type,
        createdAt:   now,
        updatedAt:   now,
    };

    // Upsert directly (will create if not exists, update if exists)
    await backend.upsertChannel(record);
    logger.info({ type, channelId, guildId, msg: 'Successfully pre-registered channel as well-known' });
}

main().catch((error: unknown) => {
    if(error instanceof UsageError) {
        logger.error({ msg: error.message });
    } else {
        logger.error({ error, msg: 'Unexpected error' });
    }
    throw error;
});

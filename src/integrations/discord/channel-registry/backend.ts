import {
    DynamoDBDocumentClient,
    PutCommand,
    GetCommand,
    QueryCommand,
    UpdateCommand,
    DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import _ from 'lodash';
import { withDynamoTimeout } from '@/storage';
import { stripDynamoKeys } from '@/utils';
import { ItemNotFoundError, ValidationError } from '@/errors';
import { createChannelId, type ChannelId, type GuildId } from '../types';
import {
    type ChannelStorageRecord,
    type WellKnownChannel,
    channelStorageRecordSchema,
    WELL_KNOWN_CHANNELS
} from './types';
import { ChannelRegistryKeyGenerator, type ChannelRegistryKeys } from './key-generator';

/**
 * DynamoDB backend for Discord channel registry.
 * Provides CRUD operations for channel metadata with well-known channel support.
 */
export class ChannelRegistryBackend {
    constructor(
        private readonly docClient: DynamoDBDocumentClient,
        private readonly tableName: string,
        private readonly timeoutMs = 10000
    ) {}

    /**
     * Upserts a channel (create or update).
     * Generates all necessary DynamoDB keys and stores the minimal metadata.
     * Note: Only stores Izzy-specific data (mute status, well-known designation).
     *
     * @param record - Channel storage record (minimal data)
     * @throws {ValidationError} If record is invalid
     */
    async upsertChannel(record: ChannelStorageRecord): Promise<void> {
        // Validate storage record
        const validationResult = channelStorageRecordSchema.safeParse(record);
        if(!validationResult.success) {
            throw new ValidationError(validationResult.error.issues);
        }

        const validated = validationResult.data;

        // Generate keys
        const keys = ChannelRegistryKeyGenerator.createKeys(
            validated.channelId,
            validated.guildId
        );

        // Add well-known keys if applicable
        let item: ChannelStorageRecord & ChannelRegistryKeys = {
            ...validated,
            ...keys,
        };

        if(validated.isWellKnown) {
            const wellKnownKeys = ChannelRegistryKeyGenerator.createWellKnownKeys(validated.isWellKnown);
            item = {
                ...item,
                ...wellKnownKeys,
            };
        }

        const command = new PutCommand({
            TableName: this.tableName,
            Item:      item,
        });

        await withDynamoTimeout(
            () => this.docClient.send(command),
            {
                timeoutMs: this.timeoutMs,
                operation: 'ChannelRegistry.upsertChannel',
            }
        );
    }

    /**
     * Gets a channel storage record by ID.
     * Returns minimal stored data (mute status, well-known designation).
     * Manager layer is responsible for merging with Discord API data.
     *
     * @param channelId - Discord channel ID
     * @returns Channel storage record or null if not found
     */
    async getChannel(channelId: ChannelId): Promise<ChannelStorageRecord | null> {
        const keys = {
            PK: `CHANNEL#${channelId}`,
            SK: 'METADATA',
        };

        const command = new GetCommand({
            TableName: this.tableName,
            Key:       keys,
        });

        const result = await withDynamoTimeout(
            () => this.docClient.send(command),
            {
                timeoutMs: this.timeoutMs,
                operation: 'ChannelRegistry.getChannel',
            }
        );

        if(!result.Item) {
            return null;
        }

        return stripDynamoKeys(result.Item) as ChannelStorageRecord;
    }

    /**
     * Gets all channel storage records in a guild.
     * Uses GSI1 to query by guild ID.
     * Manager layer is responsible for merging with Discord API data.
     *
     * @param guildId - Discord guild ID
     * @returns Array of channel storage records
     */
    async getChannelsByGuild(guildId: GuildId): Promise<ChannelStorageRecord[]> {
        const command = new QueryCommand({
            TableName:                 this.tableName,
            IndexName:                 'GSI1',
            KeyConditionExpression:    'GSI1PK = :guildPk AND begins_with(GSI1SK, :channelPrefix)',
            ExpressionAttributeValues: {
                ':guildPk':       `GUILD#${guildId}`,
                ':channelPrefix': 'CHANNEL#',
            },
        });

        const result = await withDynamoTimeout(
            () => this.docClient.send(command),
            {
                timeoutMs: this.timeoutMs,
                operation: 'ChannelRegistry.getChannelsByGuild',
            }
        );

        return _.map(result.Items ?? [], item => stripDynamoKeys(item) as ChannelStorageRecord);
    }

    /**
     * Gets a well-known channel storage record by type.
     * Uses GSI2 for efficient lookup, then fetches full record from main table.
     * Manager layer is responsible for merging with Discord API data.
     *
     * @param type - Well-known channel type
     * @returns Channel storage record or null if not found
     */
    async getWellKnownChannel(type: WellKnownChannel): Promise<ChannelStorageRecord | null> {
        // Step 1: Query GSI2 to find the channel PK
        const command = new QueryCommand({
            TableName:                 this.tableName,
            IndexName:                 'GSI2',
            KeyConditionExpression:    'GSI2PK = :wellKnownPk AND GSI2SK = :channelSk',
            ExpressionAttributeValues: {
                ':wellKnownPk': `WELLKNOWN#${type}`,
                ':channelSk':   'CHANNEL',
            },
            Limit: 1, // Should only be one well-known channel of each type
        });

        const result = await withDynamoTimeout(
            () => this.docClient.send(command),
            {
                timeoutMs: this.timeoutMs,
                operation: 'ChannelRegistry.getWellKnownChannel.gsi2Query',
            }
        );

        if(!result.Items || result.Items.length === 0) {
            return null;
        }

        // Step 2: Extract channelId from PK and fetch full record
        const pk = result.Items[0].PK as string;
        const channelId = createChannelId(_.replace(pk, 'CHANNEL#', ''));

        return this.getChannel(channelId);
    }

    /**
     * Gets all well-known channel storage records.
     * Uses GSI2 scan to find all well-known channels, then BatchGetItem to fetch full records.
     * Manager layer is responsible for merging with Discord API data.
     *
     * @returns Array of well-known channel storage records
     */
    async getAllWellKnownChannels(): Promise<ChannelStorageRecord[]> {
        const results = await Promise.all(
            _.map(WELL_KNOWN_CHANNELS, type => this.getWellKnownChannel(type))
        );
        return _.filter(results, (item): item is ChannelStorageRecord => item !== null);
    }

    /**
     * Mutes a channel.
     *
     * @param channelId - Discord channel ID
     * @throws {ItemNotFoundError} If channel doesn't exist
     */
    async muteChannel(channelId: ChannelId): Promise<void> {
        const now = new Date().toISOString();

        const command = new UpdateCommand({
            TableName: this.tableName,
            Key:       {
                PK: `CHANNEL#${channelId}`,
                SK: 'METADATA',
            },
            UpdateExpression:          'SET isMuted = :muted, updatedAt = :now',
            ExpressionAttributeValues: {
                ':muted': true,
                ':now':   now,
            },
            ConditionExpression: 'attribute_exists(PK)', // Ensure channel exists
        });

        try {
            await withDynamoTimeout(
                () => this.docClient.send(command),
                {
                    timeoutMs: this.timeoutMs,
                    operation: 'ChannelRegistry.muteChannel',
                }
            );
        } catch (error) {
            if(_.isObject(error) && 'name' in error && error.name === 'ConditionalCheckFailedException') {
                throw new ItemNotFoundError(channelId);
            }
            throw error;
        }
    }

    /**
     * Unmutes a channel.
     *
     * @param channelId - Discord channel ID
     * @throws {ItemNotFoundError} If channel doesn't exist
     */
    async unmuteChannel(channelId: ChannelId): Promise<void> {
        const now = new Date().toISOString();

        const command = new UpdateCommand({
            TableName: this.tableName,
            Key:       {
                PK: `CHANNEL#${channelId}`,
                SK: 'METADATA',
            },
            UpdateExpression:          'SET isMuted = :muted, updatedAt = :now',
            ExpressionAttributeValues: {
                ':muted': false,
                ':now':   now,
            },
            ConditionExpression: 'attribute_exists(PK)', // Ensure channel exists
        });

        try {
            await withDynamoTimeout(
                () => this.docClient.send(command),
                {
                    timeoutMs: this.timeoutMs,
                    operation: 'ChannelRegistry.unmuteChannel',
                }
            );
        } catch (error) {
            if(_.isObject(error) && 'name' in error && error.name === 'ConditionalCheckFailedException') {
                throw new ItemNotFoundError(channelId);
            }
            throw error;
        }
    }

    /**
     * Marks a channel as well-known (admin operation).
     * Updates both the isWellKnown attribute and adds GSI2 keys.
     *
     * @param channelId - Discord channel ID
     * @param type - Well-known channel type
     * @throws {ItemNotFoundError} If channel doesn't exist
     */
    async markAsWellKnown(channelId: ChannelId, type: WellKnownChannel): Promise<void> {
        const now = new Date().toISOString();
        const wellKnownKeys = ChannelRegistryKeyGenerator.createWellKnownKeys(type);

        const command = new UpdateCommand({
            TableName: this.tableName,
            Key:       {
                PK: `CHANNEL#${channelId}`,
                SK: 'METADATA',
            },
            UpdateExpression:          'SET isWellKnown = :type, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk, updatedAt = :now',
            ExpressionAttributeValues: {
                ':type':   type,
                ':gsi2pk': wellKnownKeys.GSI2PK,
                ':gsi2sk': wellKnownKeys.GSI2SK,
                ':now':    now,
            },
            ConditionExpression: 'attribute_exists(PK)', // Ensure channel exists
        });

        try {
            await withDynamoTimeout(
                () => this.docClient.send(command),
                {
                    timeoutMs: this.timeoutMs,
                    operation: 'ChannelRegistry.markAsWellKnown',
                }
            );
        } catch (error) {
            if(_.isObject(error) && 'name' in error && error.name === 'ConditionalCheckFailedException') {
                throw new ItemNotFoundError(channelId);
            }
            throw error;
        }
    }

    /**
     * Removes well-known designation from a channel (admin operation).
     * Removes the isWellKnown attribute and GSI2 keys.
     *
     * @param channelId - Discord channel ID
     * @throws {ItemNotFoundError} If channel doesn't exist
     */
    async unmarkAsWellKnown(channelId: ChannelId): Promise<void> {
        const now = new Date().toISOString();

        const command = new UpdateCommand({
            TableName: this.tableName,
            Key:       {
                PK: `CHANNEL#${channelId}`,
                SK: 'METADATA',
            },
            UpdateExpression:          'REMOVE isWellKnown, GSI2PK, GSI2SK SET updatedAt = :now',
            ExpressionAttributeValues: {
                ':now': now,
            },
            ConditionExpression: 'attribute_exists(PK)', // Ensure channel exists
        });

        try {
            await withDynamoTimeout(
                () => this.docClient.send(command),
                {
                    timeoutMs: this.timeoutMs,
                    operation: 'ChannelRegistry.unmarkAsWellKnown',
                }
            );
        } catch (error) {
            if(_.isObject(error) && 'name' in error && error.name === 'ConditionalCheckFailedException') {
                throw new ItemNotFoundError(channelId);
            }
            throw error;
        }
    }

    /**
     * Deletes a channel (for cleanup).
     *
     * @param channelId - Discord channel ID
     */
    async deleteChannel(channelId: ChannelId): Promise<void> {
        const command = new DeleteCommand({
            TableName: this.tableName,
            Key:       {
                PK: `CHANNEL#${channelId}`,
                SK: 'METADATA',
            },
        });

        await withDynamoTimeout(
            () => this.docClient.send(command),
            {
                timeoutMs: this.timeoutMs,
                operation: 'ChannelRegistry.deleteChannel',
            }
        );
    }
}

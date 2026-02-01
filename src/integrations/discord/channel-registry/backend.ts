import {
    DynamoDBDocumentClient,
    PutCommand,
    GetCommand,
    QueryCommand,
    UpdateCommand,
    DeleteCommand,
    ScanCommand
} from '@aws-sdk/lib-dynamodb';
import _ from 'lodash';
import { stripDynamoKeys } from '@/storage/utils/index.js';
import { withDynamoTimeout } from '@/storage/dynamo-retry';
import { ItemNotFoundError, ValidationError } from '@/storage/errors';
import type { ChannelId, GuildId } from '../types';
import { type ChannelMetadata, type WellKnownChannel, channelMetadataSchema } from './types';
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
     * Generates all necessary DynamoDB keys and stores the metadata.
     *
     * @param metadata - Channel metadata to store
     * @throws {ValidationError} If metadata is invalid
     */
    async upsertChannel(metadata: ChannelMetadata): Promise<void> {
        // Validate metadata
        const validationResult = channelMetadataSchema.safeParse(metadata);
        if(!validationResult.success) {
            throw new ValidationError(validationResult.error.issues);
        }

        const validated = validationResult.data;

        // Generate keys
        const keys = ChannelRegistryKeyGenerator.createKeys(
            validated.channelId,
            validated.guildId,
            validated.channelName
        );

        // Add well-known keys if applicable
        let item: ChannelMetadata & ChannelRegistryKeys = {
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
     * Gets a channel by ID.
     *
     * @param channelId - Discord channel ID
     * @returns Channel metadata or null if not found
     */
    async getChannel(channelId: ChannelId): Promise<ChannelMetadata | null> {
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

        return stripDynamoKeys(result.Item) as ChannelMetadata;
    }

    /**
     * Gets all channels in a guild.
     * Uses GSI1 to query by guild ID.
     *
     * @param guildId - Discord guild ID
     * @returns Array of channel metadata
     */
    async getChannelsByGuild(guildId: GuildId): Promise<ChannelMetadata[]> {
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

        return _.map(result.Items ?? [], item => stripDynamoKeys(item) as ChannelMetadata);
    }

    /**
     * Gets channel by name within a guild (for name resolution).
     * Uses GSI1 to query by guild ID and channel name.
     *
     * @param channelName - Channel name to search for
     * @param guildId - Optional guild ID to scope the search
     * @returns Array of matching channels
     */
    async getChannelByName(channelName: string, guildId?: GuildId): Promise<ChannelMetadata[]> {
        if(guildId) {
            // Query specific guild
            const command = new QueryCommand({
                TableName:                 this.tableName,
                IndexName:                 'GSI1',
                KeyConditionExpression:    'GSI1PK = :guildPk AND GSI1SK = :channelSk',
                ExpressionAttributeValues: {
                    ':guildPk':   `GUILD#${guildId}`,
                    ':channelSk': `CHANNEL#${channelName}`,
                },
            });

            const result = await withDynamoTimeout(
                () => this.docClient.send(command),
                {
                    timeoutMs: this.timeoutMs,
                    operation: 'ChannelRegistry.getChannelByName',
                }
            );

            return _.map(result.Items ?? [], item => stripDynamoKeys(item) as ChannelMetadata);
        }

        // Scan all guilds for this channel name (less efficient, but needed for global search)
        const command = new ScanCommand({
            TableName:                 this.tableName,
            FilterExpression:          'channelName = :channelName',
            ExpressionAttributeValues: {
                ':channelName': channelName,
            },
        });

        const result = await withDynamoTimeout(
            () => this.docClient.send(command),
            {
                timeoutMs: this.timeoutMs,
                operation: 'ChannelRegistry.getChannelByName.scan',
            }
        );

        return _.map(result.Items ?? [], item => stripDynamoKeys(item) as ChannelMetadata);
    }

    /**
     * Gets a well-known channel by type.
     * Uses GSI2 for efficient lookup.
     *
     * @param type - Well-known channel type
     * @returns Channel metadata or null if not found
     */
    async getWellKnownChannel(type: WellKnownChannel): Promise<ChannelMetadata | null> {
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
                operation: 'ChannelRegistry.getWellKnownChannel',
            }
        );

        if(!result.Items || result.Items.length === 0) {
            return null;
        }

        return stripDynamoKeys(result.Items[0]) as ChannelMetadata;
    }

    /**
     * Gets all channels.
     * WARNING: Uses scan operation - expensive for large datasets.
     *
     * @returns Array of all channel metadata
     */
    async getAllChannels(): Promise<ChannelMetadata[]> {
        const command = new ScanCommand({
            TableName:                 this.tableName,
            FilterExpression:          'SK = :metadataSk',
            ExpressionAttributeValues: {
                ':metadataSk': 'METADATA',
            },
        });

        const result = await withDynamoTimeout(
            () => this.docClient.send(command),
            {
                timeoutMs: this.timeoutMs,
                operation: 'ChannelRegistry.getAllChannels',
            }
        );

        return _.map(result.Items ?? [], item => stripDynamoKeys(item) as ChannelMetadata);
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

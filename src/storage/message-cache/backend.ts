import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { map as _map } from 'lodash';
import { BaseRepository, type DynamoDBKey } from '../repositories/base';
import { ValidationError } from '../errors';
import { stripDynamoKeys } from '../utils/index.js';
import {
    cachedSegmentSchema,
    type CachedSegmentData,
    type CachedSegmentItem,
    type CachedMessage,
    type MessageId
} from './types';
import { MessageCacheKeyGenerator } from './key-generator';
import type { ChannelId } from '@/integrations/discord/types';

export interface StoreSegmentInput {
    channelId:      ChannelId
    startSnowflake: MessageId
    endSnowflake:   MessageId
    messages:       CachedMessage[]
}

/**
 * DynamoDB backend for the message cache.
 * Handles CRUD operations for cached message segments.
 */
export class MessageCacheBackend extends BaseRepository<CachedSegmentData> {
    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        super(docClient, tableName);
    }

    /**
     * Stores a new segment in the cache.
     *
     * @param input - Segment data to store
     * @returns The stored segment data
     * @throws {ValidationError} If the input data is invalid
     */
    async storeSegment(input: StoreSegmentInput): Promise<CachedSegmentData> {
        const now = new Date().toISOString();

        const segmentData = {
            channelId:      input.channelId,
            startSnowflake: input.startSnowflake,
            endSnowflake:   input.endSnowflake,
            messages:       input.messages,
            fetchedAt:      now,
        };

        const result = cachedSegmentSchema.safeParse(segmentData);
        if(!result.success) {
            throw new ValidationError(result.error.issues);
        }

        const data = result.data;
        const keys = MessageCacheKeyGenerator.createKeys(
            data.channelId,
            data.startSnowflake,
            data.endSnowflake
        );

        const item: CachedSegmentItem = {
            ...data,
            ...keys,
        };

        await this.putItem(item as unknown as Record<string, unknown>);

        return data;
    }

    /**
     * Retrieves a specific segment from the cache.
     *
     * @param channelId - Discord channel ID
     * @param startSnowflake - Start of the segment range
     * @param endSnowflake - End of the segment range
     * @returns The segment data or undefined if not found
     */
    async getSegment(
        channelId: ChannelId,
        startSnowflake: MessageId,
        endSnowflake: MessageId
    ): Promise<CachedSegmentData | undefined> {
        const keys = MessageCacheKeyGenerator.createKeys(channelId, startSnowflake, endSnowflake);
        const key: DynamoDBKey = {
            PK: keys.PK,
            SK: keys.SK,
        };

        const item = await this.getItem<CachedSegmentItem>(key);
        if(!item) {
            return undefined;
        }

        return stripDynamoKeys(item);
    }

    /**
     * Lists all segments for a channel.
     *
     * @param channelId - Discord channel ID
     * @returns Array of segment data
     */
    async listSegments(channelId: ChannelId): Promise<CachedSegmentData[]> {
        const pk = MessageCacheKeyGenerator.createChannelQueryKey(channelId);

        const result = await this.docClient.send(new QueryCommand({
            TableName:                 this.tableName,
            KeyConditionExpression:    'PK = :pk',
            ExpressionAttributeValues: {
                ':pk': pk,
            },
        }));

        const items = (result.Items ?? []) as CachedSegmentItem[];
        return _map(items, item => stripDynamoKeys(item));
    }

    /**
     * Deletes a specific segment from the cache.
     *
     * @param channelId - Discord channel ID
     * @param startSnowflake - Start of the segment range
     * @param endSnowflake - End of the segment range
     */
    async deleteSegment(
        channelId: ChannelId,
        startSnowflake: MessageId,
        endSnowflake: MessageId
    ): Promise<void> {
        const keys = MessageCacheKeyGenerator.createKeys(channelId, startSnowflake, endSnowflake);
        const key: DynamoDBKey = {
            PK: keys.PK,
            SK: keys.SK,
        };

        await this.deleteItem(key);
    }

    /**
     * Deletes all segments for a channel.
     *
     * @param channelId - Discord channel ID
     * @returns Number of segments deleted
     */
    async deleteAllSegments(channelId: ChannelId): Promise<number> {
        const segments = await this.listSegments(channelId);

        for(const segment of segments) {
            await this.docClient.send(new DeleteCommand({
                TableName: this.tableName,
                Key:       {
                    PK: MessageCacheKeyGenerator.createChannelQueryKey(channelId),
                    SK: `SEGMENT#${segment.startSnowflake}#${segment.endSnowflake}`,
                },
            }));
        }

        return segments.length;
    }
}

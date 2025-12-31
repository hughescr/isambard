import { startsWith as _startsWith } from 'lodash';
import type { ChannelId } from '@/integrations/discord/types';
import type { MessageId } from './types';

/**
 * DynamoDB key structure for message cache segments.
 */
export interface MessageCacheKeys {
    /** Primary Key: CHANNEL#{channelId} */
    PK: string
    /** Sort Key: SEGMENT#{startSnowflake}#{endSnowflake} */
    SK: string
}

/**
 * Parsed key components.
 */
export interface ParsedKeys {
    channelId:      string
    startSnowflake: string
    endSnowflake:   string
}

/**
 * Generates DynamoDB keys for message cache segments.
 */
export class MessageCacheKeyGenerator {
    /**
     * Creates DynamoDB keys for a cached segment.
     *
     * @param channelId - Discord channel ID
     * @param startSnowflake - Start of the segment range (inclusive)
     * @param endSnowflake - End of the segment range (inclusive)
     * @returns DynamoDB keys for the segment
     *
     * @example
     * ```ts
     * const keys = MessageCacheKeyGenerator.createKeys(
     *   '123456789' as ChannelId,
     *   '100' as MessageId,
     *   '200' as MessageId
     * );
     * // {
     * //   PK: 'CHANNEL#123456789',
     * //   SK: 'SEGMENT#100#200'
     * // }
     * ```
     */
    static createKeys(
        channelId: ChannelId,
        startSnowflake: MessageId,
        endSnowflake: MessageId
    ): MessageCacheKeys {
        return {
            PK: `CHANNEL#${channelId}`,
            SK: `SEGMENT#${startSnowflake}#${endSnowflake}`,
        };
    }

    /**
     * Parses DynamoDB keys back into components.
     *
     * @param pk - Primary Key (CHANNEL#{channelId})
     * @param sk - Sort Key (SEGMENT#{startSnowflake}#{endSnowflake})
     * @returns Parsed key components
     * @throws Error if keys are not in expected format
     *
     * @example
     * ```ts
     * const parsed = MessageCacheKeyGenerator.parseKeys(
     *   'CHANNEL#123456789',
     *   'SEGMENT#100#200'
     * );
     * // { channelId: '123456789', startSnowflake: '100', endSnowflake: '200' }
     * ```
     */
    static parseKeys(pk: string, sk: string): ParsedKeys {
        if(!_startsWith(pk, 'CHANNEL#')) {
            throw new Error(`Invalid PK format: expected CHANNEL#..., got ${pk}`);
        }

        if(!_startsWith(sk, 'SEGMENT#')) {
            throw new Error(`Invalid SK format: expected SEGMENT#..., got ${sk}`);
        }

        const channelId = pk.slice(8); // Remove 'CHANNEL#' prefix

        const segmentPart = sk.slice(8); // Remove 'SEGMENT#' prefix
        const hashIndex = segmentPart.indexOf('#');
        if(hashIndex === -1) {
            throw new Error(`Invalid SK format: expected SEGMENT#start#end, got ${sk}`);
        }

        const startSnowflake = segmentPart.slice(0, hashIndex);
        const endSnowflake = segmentPart.slice(hashIndex + 1);

        return { channelId, startSnowflake, endSnowflake };
    }

    /**
     * Creates the PK for querying all segments of a channel.
     *
     * @param channelId - Discord channel ID
     * @returns The PK for channel queries
     */
    static createChannelQueryKey(channelId: ChannelId): string {
        return `CHANNEL#${channelId}`;
    }
}

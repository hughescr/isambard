import { createPrefixedKey, parsePrefixedKey } from '@/storage';

/**
 * DynamoDB key structure for Channel Registry items
 */
export interface ChannelRegistryKeys {
    /** Primary Key: CHANNEL#{channelId} */
    PK:      string
    /** Sort Key: METADATA */
    SK:      string
    /** GSI1 Primary Key: GUILD#{guildId} */
    GSI1PK:  string
    /** GSI1 Sort Key: CHANNEL#{channelId} (changed from channelName) */
    GSI1SK:  string
    /** GSI2 Primary Key: WELLKNOWN#{type} (optional, only for well-known channels) */
    GSI2PK?: string
    /** GSI2 Sort Key: CHANNEL (optional, only for well-known channels) */
    GSI2SK?: string
}

// Stryker disable StringLiteral: PK/SK key constants are configuration values
const PREFIX_CHANNEL   = 'CHANNEL';
const PREFIX_GUILD     = 'GUILD';
const PREFIX_WELLKNOWN = 'WELLKNOWN';
const SK_METADATA      = 'METADATA';
const GSI2SK_CHANNEL   = 'CHANNEL';
// Stryker restore StringLiteral

/**
 * Generates DynamoDB keys for Channel Registry items
 */
export const ChannelRegistryKeyGenerator = {
    /**
     * Creates DynamoDB keys for a channel
     *
     * @param channelId - Discord channel ID
     * @param guildId - Discord guild (server) ID
     * @returns DynamoDB keys for the channel registry item
     *
     * @example
     * ```ts
     * const keys = ChannelRegistryKeyGenerator.createKeys('123456', '789012');
     * // {
     * //   PK: 'CHANNEL#123456',
     * //   SK: 'METADATA',
     * //   GSI1PK: 'GUILD#789012',
     * //   GSI1SK: 'CHANNEL#123456'
     * // }
     * ```
     */
    createKeys(channelId: string, guildId: string): ChannelRegistryKeys {
        return {
            // Stryker disable next-line StringLiteral: PK/SK key constants are configuration values
            PK:     createPrefixedKey(PREFIX_CHANNEL, channelId),
            // Stryker disable next-line StringLiteral: SK key constant is a configuration value
            SK:     SK_METADATA,
            // Stryker disable next-line StringLiteral: GSI1PK key constant is a configuration value
            GSI1PK: createPrefixedKey(PREFIX_GUILD, guildId),
            // Stryker disable next-line StringLiteral: GSI1SK key constant is a configuration value
            GSI1SK: createPrefixedKey(PREFIX_CHANNEL, channelId),
        };
    },

    /**
     * Creates GSI2 keys for well-known channel lookup
     *
     * @param type - Well-known channel type (e.g., 'catch-up', 'dev-chat')
     * @returns GSI2 keys for well-known channel lookup
     *
     * @example
     * ```ts
     * const keys = ChannelRegistryKeyGenerator.createWellKnownKeys('catch-up');
     * // {
     * //   GSI2PK: 'WELLKNOWN#catch-up',
     * //   GSI2SK: 'CHANNEL'
     * // }
     * ```
     */
    createWellKnownKeys(type: string): Pick<ChannelRegistryKeys, 'GSI2PK' | 'GSI2SK'> {
        return {
            // Stryker disable next-line StringLiteral: GSI2PK key constant is a configuration value
            GSI2PK: createPrefixedKey(PREFIX_WELLKNOWN, type),
            // Stryker disable next-line StringLiteral: GSI2SK key constant is a configuration value
            GSI2SK: GSI2SK_CHANNEL,
        };
    },

    /**
     * Parses a PK back to channelId
     *
     * @param pk - Primary Key (CHANNEL#{channelId})
     * @returns The channel ID
     * @throws Error if PK is not in expected format
     *
     * @example
     * ```ts
     * const channelId = ChannelRegistryKeyGenerator.parseChannelId('CHANNEL#123456');
     * // '123456'
     * ```
     */
    parseChannelId(pk: string): string {
        if(!pk.startsWith('CHANNEL#')) {
            throw new Error(`Invalid PK format: expected CHANNEL#..., got ${pk}`);
        }
        return parsePrefixedKey(PREFIX_CHANNEL, pk);
    },

    /**
     * Parses GSI1 keys back to guildId and channelId
     *
     * @param gsi1pk - GSI1 Primary Key (GUILD#{guildId})
     * @param gsi1sk - GSI1 Sort Key (CHANNEL#{channelId})
     * @returns Object containing guildId and channelId
     * @throws Error if keys are not in expected format
     *
     * @example
     * ```ts
     * const { guildId, channelId } = ChannelRegistryKeyGenerator.parseGuildKeys(
     *   'GUILD#789012',
     *   'CHANNEL#123456'
     * );
     * // { guildId: '789012', channelId: '123456' }
     * ```
     */
    parseGuildKeys(gsi1pk: string, gsi1sk: string): { guildId: string, channelId: string } {
        if(!gsi1pk.startsWith('GUILD#')) {
            throw new Error(`Invalid GSI1PK format: expected GUILD#..., got ${gsi1pk}`);
        }
        if(!gsi1sk.startsWith('CHANNEL#')) {
            throw new Error(`Invalid GSI1SK format: expected CHANNEL#..., got ${gsi1sk}`);
        }

        return {
            guildId:   parsePrefixedKey(PREFIX_GUILD, gsi1pk),
            channelId: parsePrefixedKey(PREFIX_CHANNEL, gsi1sk),
        };
    },
};

import { createPrefixedKey, parsePrefixedKey } from '../utils/key-builder.js';
import { createContactId, platformTypeSchema, type ContactId, type PlatformType } from './types';

/**
 * DynamoDB key structure for Contact profile items.
 */
interface ContactProfileKeys {
    /** Primary Key: CONTACT#{personId} */
    PK: string
    /** Sort Key: PROFILE */
    SK: string
}

/**
 * DynamoDB key structure for Contact lookup items.
 * Maps platform+value → personId for identifier-based resolution.
 */
interface ContactLookupKeys {
    /** Primary Key: CONTACT_LOOKUP#{platform}#{normalizedValue} */
    PK:     string
    /** Sort Key: CONTACT#{personId} */
    SK:     string
    /** GSI2 Partition Key: CONTACT_LOOKUPS — enables efficient Phase A orphan scan */
    GSI2PK: string
    /** GSI2 Sort Key: CONTACT#{personId}#{platform}#{normalizedValue} — unique within the partition */
    GSI2SK: string
}

// Stryker disable StringLiteral: PK/SK key constants are configuration values
const PREFIX_CONTACT         = 'CONTACT';
const PREFIX_CONTACT_LOOKUP  = 'CONTACT_LOOKUP';
const SK_PROFILE             = 'PROFILE';
const GSI2PK_CONTACTS        = 'CONTACTS';
const GSI2PK_CONTACT_LOOKUPS = 'CONTACT_LOOKUPS';
// Stryker restore StringLiteral

/**
 * Generates DynamoDB keys for Contact items
 */
export const ContactKeyGenerator = {
    /**
     * Creates DynamoDB keys for a contact profile item.
     *
     * @param personId - The contact's personId (kebab-case)
     * @returns DynamoDB keys for the contact profile item
     *
     * @example
     * ```ts
     * ContactKeyGenerator.createProfileKeys('craig-hughes')
     * // { PK: 'CONTACT#craig-hughes', SK: 'PROFILE' }
     * ```
     */
    createProfileKeys(personId: ContactId): ContactProfileKeys {
        return {
            // Stryker disable next-line StringLiteral: PK/SK key constants are configuration values
            PK: createPrefixedKey(PREFIX_CONTACT, personId),
            // Stryker disable next-line StringLiteral: PK/SK key constants are configuration values
            SK: SK_PROFILE,
        };
    },

    /**
     * Creates a DynamoDB lookup key for resolving an identifier to a contact.
     * The value is normalized to lowercase+trimmed for case-insensitive lookup.
     *
     * Also sets GSI2PK='CONTACT_LOOKUPS' so that Phase A reconciliation can
     * query all lookup rows efficiently via the GSI2 index.
     * GSI2SK encodes both the personId and the platform+value so it is unique
     * within the CONTACT_LOOKUPS partition.
     *
     * @param platform - The platform type
     * @param value    - The identifier value (will be normalized)
     * @param personId - The contact's personId
     * @returns DynamoDB keys for the lookup item
     *
     * @example
     * ```ts
     * ContactKeyGenerator.createLookupKeys('email', 'Alice@Example.com', 'alice-smith' as ContactId)
     * // { PK: 'CONTACT_LOOKUP#email#alice@example.com', SK: 'CONTACT#alice-smith', GSI2PK: 'CONTACT_LOOKUPS', GSI2SK: 'CONTACT#alice-smith#email#alice@example.com' }
     * ```
     */
    createLookupKeys(platform: PlatformType, value: string, personId: ContactId): ContactLookupKeys {
        const normalizedValue = value.toLowerCase().trim();
        return {
            // Stryker disable next-line StringLiteral: PK/SK key constants are configuration values
            PK:     createPrefixedKey(PREFIX_CONTACT_LOOKUP, platform, normalizedValue),
            // Stryker disable next-line StringLiteral: PK/SK key constants are configuration values
            SK:     createPrefixedKey(PREFIX_CONTACT, personId),
            // Stryker disable next-line StringLiteral: GSI2PK key constant is a configuration value
            GSI2PK: GSI2PK_CONTACT_LOOKUPS,
            // Stryker disable next-line StringLiteral: GSI2SK key constant is a configuration value
            GSI2SK: createPrefixedKey(PREFIX_CONTACT, personId, platform, normalizedValue),
        };
    },

    /**
     * Creates GSI2 keys for a contact profile item, enabling efficient listing
     * of all contacts without a full table scan.
     *
     * @param personId - The contact's personId (kebab-case)
     * @returns GSI2 keys for the contact profile item
     *
     * @example
     * ```ts
     * ContactKeyGenerator.createCollectionKeys('craig-hughes')
     * // { GSI2PK: 'CONTACTS', GSI2SK: 'CONTACT#craig-hughes' }
     * ```
     */
    createCollectionKeys(personId: ContactId): { GSI2PK: string, GSI2SK: string } {
        return {
            // Stryker disable next-line StringLiteral: GSI2PK key constant is a configuration value
            GSI2PK: GSI2PK_CONTACTS,
            // Stryker disable next-line StringLiteral: GSI2SK key constant is a configuration value
            GSI2SK: createPrefixedKey(PREFIX_CONTACT, personId),
        };
    },

    /**
     * Parses a personId from a profile item PK.
     *
     * @param pk - Primary Key (CONTACT#{personId})
     * @returns The personId
     * @throws Error if PK is not in expected format
     *
     * @example
     * ```ts
     * ContactKeyGenerator.parsePersonIdFromPK('CONTACT#craig-hughes')
     * // 'craig-hughes'
     * ```
     */
    parsePersonIdFromPK(pk: string): ContactId {
        if(!pk.startsWith('CONTACT#')) {
            throw new Error(`Invalid PK format: expected CONTACT#..., got ${pk}`);
        }
        return createContactId(parsePrefixedKey(PREFIX_CONTACT, pk));
    },

    /**
     * Parses a lookup PK back to platform and normalized value.
     *
     * @param pk - Primary Key (CONTACT_LOOKUP#{platform}#{value})
     * @returns Object containing platform and value
     * @throws Error if PK is not in expected format
     *
     * @example
     * ```ts
     * ContactKeyGenerator.parseLookupPK('CONTACT_LOOKUP#email#alice@example.com')
     * // { platform: 'email', value: 'alice@example.com' }
     * ```
     */
    parseLookupPK(pk: string): { platform: PlatformType, value: string } {
        // Stryker disable next-line StringLiteral: PK prefix is a configuration constant
        const PREFIX = 'CONTACT_LOOKUP#';
        if(!pk.startsWith(PREFIX)) {
            throw new Error(`Invalid lookup PK format: expected CONTACT_LOOKUP#..., got ${pk}`);
        }
        const rest = pk.slice(PREFIX.length);
        const hashIndex = rest.indexOf('#');
        if(hashIndex === -1) {
            throw new Error(`Invalid lookup PK format: missing platform separator in ${pk}`);
        }
        const platform = platformTypeSchema.parse(rest.slice(0, hashIndex));
        const value    = rest.slice(hashIndex + 1);
        return { platform, value };
    },

    /**
     * Parses a personId from a lookup item SK.
     *
     * @param sk - Sort Key (CONTACT#{personId})
     * @returns The personId
     * @throws Error if SK is not in expected format
     *
     * @example
     * ```ts
     * ContactKeyGenerator.parsePersonIdFromLookupSK('CONTACT#craig-hughes')
     * // 'craig-hughes'
     * ```
     */
    parsePersonIdFromLookupSK(sk: string): ContactId {
        if(!sk.startsWith('CONTACT#')) {
            throw new Error(`Invalid lookup SK format: expected CONTACT#..., got ${sk}`);
        }
        return createContactId(parsePrefixedKey(PREFIX_CONTACT, sk));
    },
};

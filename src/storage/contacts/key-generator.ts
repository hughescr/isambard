import { createContactId, platformTypeSchema, type ContactId, type PlatformType } from './types';

/**
 * DynamoDB key structure for Contact profile items.
 */
export interface ContactProfileKeys {
    /** Primary Key: CONTACT#{personId} */
    PK: string
    /** Sort Key: PROFILE */
    SK: string
}

/**
 * DynamoDB key structure for Contact lookup items.
 * Maps platform+value → personId for identifier-based resolution.
 */
export interface ContactLookupKeys {
    /** Primary Key: CONTACT_LOOKUP#{platform}#{normalizedValue} */
    PK: string
    /** Sort Key: CONTACT#{personId} */
    SK: string
}

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
            PK: `CONTACT#${personId}`,
            // Stryker disable next-line StringLiteral: PK/SK key constants are configuration values
            SK: 'PROFILE',
        };
    },

    /**
     * Creates a DynamoDB lookup key for resolving an identifier to a contact.
     * The value is normalized to lowercase+trimmed for case-insensitive lookup.
     *
     * @param platform - The platform type
     * @param value    - The identifier value (will be normalized)
     * @param personId - The contact's personId
     * @returns DynamoDB keys for the lookup item
     *
     * @example
     * ```ts
     * ContactKeyGenerator.createLookupKeys('email', 'Alice@Example.com', 'alice-smith' as ContactId)
     * // { PK: 'CONTACT_LOOKUP#email#alice@example.com', SK: 'CONTACT#alice-smith' }
     * ```
     */
    createLookupKeys(platform: PlatformType, value: string, personId: ContactId): ContactLookupKeys {
        const normalizedValue = value.toLowerCase().trim();
        return {
            // Stryker disable next-line StringLiteral: PK/SK key constants are configuration values
            PK: `CONTACT_LOOKUP#${platform}#${normalizedValue}`,
            // Stryker disable next-line StringLiteral: PK/SK key constants are configuration values
            SK: `CONTACT#${personId}`,
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
        // Remove 'CONTACT#' prefix (8 chars)
        return createContactId(pk.slice(8));
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
        // Remove 'CONTACT#' prefix (8 chars)
        return createContactId(sk.slice(8));
    },
};

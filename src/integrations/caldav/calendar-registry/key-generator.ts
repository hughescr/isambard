import { InvariantViolationError } from '@/errors';
import { createPrefixedKey, parsePrefixedKey } from '@/storage';

/**
 * DynamoDB key structure for Calendar Registry items
 */
export interface CalendarRegistryKeys {
    /** Primary Key: CALCAL#{userId} or CALCAL#SHARED */
    PK: string
    /** Sort Key: CALENDARS */
    SK: string
}

// Stryker disable StringLiteral: PK/SK key constants are configuration values
const PREFIX_CALCAL   = 'CALCAL';
const SK_CALENDARS    = 'CALENDARS';
const SHARED_USER_ID  = 'SHARED';
// Stryker restore StringLiteral

/**
 * Generates DynamoDB keys for Calendar Registry items
 */
export const CalendarRegistryKeyGenerator = {
    /**
     * Creates DynamoDB keys for a user's calendar registry record
     *
     * @param userId - User identifier
     * @returns DynamoDB keys for the calendar registry item
     */
    createUserKeys(userId: string): CalendarRegistryKeys {
        return {
            // Stryker disable next-line StringLiteral: PK key constant is a configuration value
            PK: createPrefixedKey(PREFIX_CALCAL, userId),
            // Stryker disable next-line StringLiteral: SK key constant is a configuration value
            SK: SK_CALENDARS,
        };
    },

    /**
     * Creates DynamoDB keys for the shared calendar registry record
     *
     * @returns DynamoDB keys for the shared calendar registry item
     */
    createSharedKeys(): CalendarRegistryKeys {
        return {
            // Stryker disable next-line StringLiteral: PK key constant is a configuration value
            PK: createPrefixedKey(PREFIX_CALCAL, SHARED_USER_ID),
            // Stryker disable next-line StringLiteral: SK key constant is a configuration value
            SK: SK_CALENDARS,
        };
    },

    /**
     * Parses a PK back to userId
     *
     * @param pk - Primary Key (CALCAL#{userId})
     * @returns The user ID
     * @throws Error if PK is not in expected format
     */
    parseUserId(pk: string): string {
        if(!pk.startsWith('CALCAL#')) {
            // Stryker disable next-line StringLiteral: location and message strings are debug-only metadata — the throw itself is tested
            throw new InvariantViolationError('CalendarRegistryKeyGenerator.parseUserId', `Invalid PK format: expected CALCAL#..., got ${pk}`);
        }
        return parsePrefixedKey(PREFIX_CALCAL, pk);
    },

    /**
     * Checks if a PK is the shared key
     *
     * @param pk - Primary Key to check
     * @returns true if pk is the shared key
     */
    isSharedKey(pk: string): boolean {
        return pk === createPrefixedKey(PREFIX_CALCAL, SHARED_USER_ID);
    },
};

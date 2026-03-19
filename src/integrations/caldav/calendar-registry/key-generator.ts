/**
 * DynamoDB key structure for Calendar Registry items
 */
export interface CalendarRegistryKeys {
    /** Primary Key: CALCAL#{userId} or CALCAL#SHARED */
    PK: string
    /** Sort Key: CALENDARS */
    SK: string
}

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
            PK: `CALCAL#${userId}`,
            SK: 'CALENDARS',
        };
    },

    /**
     * Creates DynamoDB keys for the shared calendar registry record
     *
     * @returns DynamoDB keys for the shared calendar registry item
     */
    createSharedKeys(): CalendarRegistryKeys {
        return {
            PK: 'CALCAL#SHARED',
            SK: 'CALENDARS',
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
            throw new Error(`Invalid PK format: expected CALCAL#..., got ${pk}`);
        }
        return pk.slice(7); // Remove 'CALCAL#' prefix
    },

    /**
     * Checks if a PK is the shared key
     *
     * @param pk - Primary Key to check
     * @returns true if pk is the shared key
     */
    isSharedKey(pk: string): boolean {
        return pk === 'CALCAL#SHARED';
    },
};

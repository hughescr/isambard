import { calendarRegistryScopeSchema, type CalendarRegistryScope } from './types';
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

const PREFIX_CALCAL   = 'CALCAL';
const SK_CALENDARS    = 'CALENDARS';
/** The persisted form of the shared scope: its PK suffix. */
const SHARED_USER_ID  = 'SHARED';

/** The PK suffix for a scope: the user ID for a personal scope, `SHARED` for the shared scope. */
function pkSuffix(scope: CalendarRegistryScope): string {
    return scope.kind === 'shared' ? SHARED_USER_ID : scope.userId;
}

/**
 * Generates and decodes DynamoDB keys for Calendar Registry items. The PK is the authoritative
 * encoding of a record's {@link CalendarRegistryScope}; the unchanged `CALCAL#{userId}` /
 * `CALCAL#SHARED` forms keep existing rows readable with no backfill.
 */
export const CalendarRegistryKeyGenerator = {
    /**
     * Creates DynamoDB keys for a scope's calendar registry record.
     *
     * @throws ZodError for an empty personal user ID
     * @throws InvariantViolationError for a personal user ID that would collide with the shared key
     */
    createKeys(scope: CalendarRegistryScope): CalendarRegistryKeys {
        const valid = calendarRegistryScopeSchema.parse(scope);
        if(valid.kind === 'personal' && valid.userId === SHARED_USER_ID) {
            throw new InvariantViolationError('CalendarRegistryKeyGenerator.createKeys', `Personal user ID ${SHARED_USER_ID} collides with the shared registry key`);
        }
        return {
            PK: createPrefixedKey(PREFIX_CALCAL, pkSuffix(valid)),
            SK: SK_CALENDARS,
        };
    },

    /** Creates DynamoDB keys for a user's calendar registry record. */
    createUserKeys(userId: string): CalendarRegistryKeys {
        return CalendarRegistryKeyGenerator.createKeys({ kind: 'personal', userId });
    },

    /** Creates DynamoDB keys for the shared calendar registry record. */
    createSharedKeys(): CalendarRegistryKeys {
        return CalendarRegistryKeyGenerator.createKeys({ kind: 'shared' });
    },

    /**
     * Decodes a PK back to its scope.
     *
     * @throws InvariantViolationError if the PK is not `CALCAL#…`
     * @throws ZodError for `CALCAL#` with an empty user ID
     */
    parseScope(pk: string): CalendarRegistryScope {
        if(!pk.startsWith(`${PREFIX_CALCAL}#`)) {
            throw new InvariantViolationError('CalendarRegistryKeyGenerator.parseScope', `Invalid PK format: expected CALCAL#..., got ${pk}`);
        }
        if(CalendarRegistryKeyGenerator.isSharedKey(pk)) {
            return { kind: 'shared' };
        }
        return calendarRegistryScopeSchema.parse({ kind: 'personal', userId: parsePrefixedKey(PREFIX_CALCAL, pk) });
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

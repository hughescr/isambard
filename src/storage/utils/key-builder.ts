import { InvariantViolationError } from '@/errors';

/**
 * Generic DynamoDB prefixed-key helpers.
 *
 * DynamoDB keys in this codebase consistently use the pattern `PREFIX#part1#part2...`.
 * These two helpers centralise key construction and parsing so each backend keeps its
 * domain-specific prefix constants while delegating the string assembly here.
 *
 * **Key contract**: keys are built by joining the prefix and all parts with `#`.
 * Parsing strips the leading `PREFIX#` and returns the full remainder (which may itself
 * contain `#` for multi-segment values like `CONTACT_LOOKUP#email#alice@example.com`).
 *
 * @example
 * // Construction
 * createPrefixedKey('CONTACT', 'craig-hughes')
 * // → 'CONTACT#craig-hughes'
 *
 * createPrefixedKey('CONTACT_LOOKUP', 'email', 'alice@example.com')
 * // → 'CONTACT_LOOKUP#email#alice@example.com'
 *
 * // Parsing
 * parsePrefixedKey('CONTACT', 'CONTACT#craig-hughes')
 * // → 'craig-hughes'
 *
 * parsePrefixedKey('CONTACT_LOOKUP', 'CONTACT_LOOKUP#email#alice@example.com')
 * // → 'email#alice@example.com'
 */

/**
 * Builds a DynamoDB key by joining `prefix` and `parts` with `#`.
 *
 * @param prefix - The key prefix (e.g. `'CONTACT'`, `'CHANNEL'`)
 * @param parts  - Zero or more value segments to append
 * @returns      The assembled key string
 */
export function createPrefixedKey(prefix: string, ...parts: string[]): string {
    if(parts.length === 0) {
        return prefix;
    }
    return `${prefix}#${parts.join('#')}`;
}

/**
 * Strips the leading `PREFIX#` from a key and returns the remainder.
 *
 * The check is exact: `key` must start with `${prefix}#`.  A key that starts
 * with a longer prefix (e.g. `CONTACT_LOOKUP#...` when you ask for `CONTACT#`)
 * is rejected to prevent silent mismatches.
 *
 * @param prefix - The expected prefix (e.g. `'CONTACT'`)
 * @param key    - The full key string to parse
 * @returns      The remainder after stripping `PREFIX#`
 * @throws InvariantViolationError if `key` does not start with `${prefix}#`
 */
export function parsePrefixedKey(prefix: string, key: string): string {
    const expectedStart = `${prefix}#`;
    if(!key.startsWith(expectedStart)) {
        // Stryker disable next-line StringLiteral: location and message strings are debug-only metadata — the throw itself is tested
        throw new InvariantViolationError('parsePrefixedKey', `Invalid key format: expected ${prefix}#..., got ${key}`);
    }
    return key.slice(expectedStart.length);
}

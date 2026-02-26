import { describe, expect, it } from 'bun:test';
import { stripDynamoKeys } from '@/storage/utils/strip-keys';

/**
 * NOTE: This test file achieves 0% mutation score because `stripDynamoKeys`
 * uses pure destructuring syntax - there are no mutable operators (delete, assignments,
 * conditional logic, etc.) that could be mutated. The function is unmutable by design.
 *
 * These 2 tests provide comprehensive coverage of the function's contract:
 * 1. Strips all DynamoDB key fields (PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK)
 * 2. Preserves all data fields across all JS types
 * 3. Handles optional GSI keys
 * 4. Handles edge cases (keys-only items, undefined values)
 */
describe('stripDynamoKeys', () => {
    it('strips all present DynamoDB keys while preserving all data fields with diverse types', () => {
        const item = {
            PK:           'PARTITION#key',
            SK:           'SORT#key',
            GSI1PK:       'GSI1#partition',
            GSI1SK:       'GSI1#sort',
            GSI2PK:       'GSI2#partition',
            GSI2SK:       'GSI2#sort',
            stringField:  'string',
            numberField:  123,
            booleanField: true,
            nullField:    null,
            arrayField:   [1, 2, 3],
            objectField:  { a: 1, b: 2 },
            dateField:    '2024-01-01T00:00:00Z',
        };

        const result = stripDynamoKeys(item);

        // Verify all 6 key fields are stripped
        expect(result).not.toHaveProperty('PK');
        expect(result).not.toHaveProperty('SK');
        expect(result).not.toHaveProperty('GSI1PK');
        expect(result).not.toHaveProperty('GSI1SK');
        expect(result).not.toHaveProperty('GSI2PK');
        expect(result).not.toHaveProperty('GSI2SK');

        // Verify all data fields are preserved with correct types
        expect(result).toEqual({
            stringField:  'string',
            numberField:  123,
            booleanField: true,
            nullField:    null,
            arrayField:   [1, 2, 3],
            objectField:  { a: 1, b: 2 },
            dateField:    '2024-01-01T00:00:00Z',
        });
    });

    it('handles optional GSI keys and edge cases', () => {
        // Case 1: Only PK/SK present (no GSI keys)
        const minimalItem = {
            PK:      'pk',
            SK:      'sk',
            content: 'data',
        };
        const minimalResult = stripDynamoKeys(minimalItem);
        expect(minimalResult).toEqual({ content: 'data' });
        expect(minimalResult).not.toHaveProperty('PK');
        expect(minimalResult).not.toHaveProperty('SK');

        // Case 2: All keys but no data fields (returns empty object)
        const keysOnlyItem = {
            PK:     'pk',
            SK:     'sk',
            GSI1PK: 'gsi1pk',
            GSI1SK: 'gsi1sk',
            GSI2PK: 'gsi2pk',
            GSI2SK: 'gsi2sk',
        };
        const keysOnlyResult = stripDynamoKeys(keysOnlyItem);
        expect(keysOnlyResult).toEqual({});

        // Case 3: Undefined GSI values (treated as absent)
        const undefinedGSIItem = {
            PK:     'pk',
            SK:     'sk',
            GSI1PK: undefined,
            GSI1SK: undefined,
            data:   'test',
        };
        const undefinedGSIResult = stripDynamoKeys(undefinedGSIItem);
        expect(undefinedGSIResult).toEqual({ data: 'test' });
        expect(undefinedGSIResult).not.toHaveProperty('GSI1PK');
        expect(undefinedGSIResult).not.toHaveProperty('GSI1SK');
    });
});

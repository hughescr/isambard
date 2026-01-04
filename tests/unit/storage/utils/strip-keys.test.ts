import { describe, expect, it } from 'bun:test';

import { stripDynamoKeys } from '@/storage/utils/strip-keys';

describe('stripDynamoKeys', () => {
    it('strips all 6 DynamoDB key fields when present', () => {
        const item = {
            PK:     'PARTITION#key',
            SK:     'SORT#key',
            GSI1PK: 'GSI1#partition',
            GSI1SK: 'GSI1#sort',
            GSI2PK: 'GSI2#partition',
            GSI2SK: 'GSI2#sort',
            id:     'test-id',
            name:   'Test Item',
            value:  42,
        };

        const result = stripDynamoKeys(item);

        expect(result).toEqual({
            id:    'test-id',
            name:  'Test Item',
            value: 42,
        });
        expect(result).not.toHaveProperty('PK');
        expect(result).not.toHaveProperty('SK');
        expect(result).not.toHaveProperty('GSI1PK');
        expect(result).not.toHaveProperty('GSI1SK');
        expect(result).not.toHaveProperty('GSI2PK');
        expect(result).not.toHaveProperty('GSI2SK');
    });

    it('strips only PK and SK when GSI keys are not present', () => {
        const item = {
            PK:        'PARTITION#key',
            SK:        'SORT#key',
            content:   'some content',
            timestamp: 1234567890,
        };

        const result = stripDynamoKeys(item);

        expect(result).toEqual({
            content:   'some content',
            timestamp: 1234567890,
        });
        expect(result).not.toHaveProperty('PK');
        expect(result).not.toHaveProperty('SK');
    });

    it('strips PK, SK, GSI1PK, GSI1SK when GSI2 keys are not present', () => {
        const item = {
            PK:     'PARTITION#key',
            SK:     'SORT#key',
            GSI1PK: 'GSI1#partition',
            GSI1SK: 'GSI1#sort',
            type:   'memory',
            data:   { nested: true },
        };

        const result = stripDynamoKeys(item);

        expect(result).toEqual({
            type: 'memory',
            data: { nested: true },
        });
        expect(result).not.toHaveProperty('PK');
        expect(result).not.toHaveProperty('SK');
        expect(result).not.toHaveProperty('GSI1PK');
        expect(result).not.toHaveProperty('GSI1SK');
    });

    it('preserves all non-key data fields', () => {
        const item = {
            PK:           'pk',
            SK:           'sk',
            stringField:  'string',
            numberField:  123,
            booleanField: true,
            nullField:    null,
            arrayField:   [1, 2, 3],
            objectField:  { a: 1, b: 2 },
            dateField:    '2024-01-01T00:00:00Z',
        };

        const result = stripDynamoKeys(item);

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

    it('returns empty object when item only contains key fields', () => {
        const item = {
            PK:     'pk',
            SK:     'sk',
            GSI1PK: 'gsi1pk',
            GSI1SK: 'gsi1sk',
            GSI2PK: 'gsi2pk',
            GSI2SK: 'gsi2sk',
        };

        const result = stripDynamoKeys(item);

        expect(result).toEqual({});
    });

    it('handles items with undefined key values', () => {
        const item = {
            PK:     'pk',
            SK:     'sk',
            GSI1PK: undefined,
            GSI1SK: undefined,
            data:   'test',
        };

        const result = stripDynamoKeys(item);

        expect(result).toEqual({
            data: 'test',
        });
        expect(result).not.toHaveProperty('GSI1PK');
        expect(result).not.toHaveProperty('GSI1SK');
    });
});

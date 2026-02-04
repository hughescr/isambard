import { describe, expect, test } from 'bun:test';
import { dynamoDBConfigSchema } from '../../../src/config/schemas';

describe.concurrent('dynamoDBConfigSchema', () => {
    test('validates valid DynamoDB configuration', () => {
        const validConfig = {
            tableName: 'isambard-conversations',
        };

        const result = dynamoDBConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.tableName).toBe('isambard-conversations');
        }
    });

    test('rejects empty tableName', () => {
        const invalidConfig = {
            tableName: '',
        };

        const result = dynamoDBConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('rejects missing tableName', () => {
        const invalidConfig = {};

        const result = dynamoDBConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('accepts different table names', () => {
        const tableNames = [
            'IsambardMemory',
            'test-table',
            'production-memory-table',
        ];

        for(const tableName of tableNames) {
            const validConfig = { tableName };
            const result = dynamoDBConfigSchema.safeParse(validConfig);
            expect(result.success).toBe(true);
            if(result.success) {
                expect(result.data.tableName).toBe(tableName);
            }
        }
    });
});

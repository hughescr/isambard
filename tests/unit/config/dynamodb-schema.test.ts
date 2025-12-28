import { describe, expect, test } from 'bun:test';
import { dynamoDBConfigSchema } from '../../../src/config/schemas';

describe('dynamoDBConfigSchema', () => {
    test('validates valid DynamoDB configuration with endpoint', () => {
        const validConfig = {
            tableName: 'isambard-conversations',
            region:    'us-east-1',
            endpoint:  'http://localhost:8000',
        };

        const result = dynamoDBConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.tableName).toBe('isambard-conversations');
            expect(result.data.region).toBe('us-east-1');
            expect(result.data.endpoint).toBe('http://localhost:8000');
        }
    });

    test('rejects empty tableName', () => {
        const invalidConfig = {
            tableName: '',
            region:    'us-east-1',
        };

        const result = dynamoDBConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('rejects missing tableName', () => {
        const invalidConfig = {
            region: 'us-east-1',
        };

        const result = dynamoDBConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('rejects empty region', () => {
        const invalidConfig = {
            tableName: 'isambard-conversations',
            region:    '',
        };

        const result = dynamoDBConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('rejects missing region', () => {
        const invalidConfig = {
            tableName: 'isambard-conversations',
        };

        const result = dynamoDBConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('rejects invalid endpoint URL', () => {
        const invalidConfig = {
            tableName: 'isambard-conversations',
            region:    'us-east-1',
            endpoint:  'not-a-valid-url',
        };

        const result = dynamoDBConfigSchema.safeParse(invalidConfig);
        expect(result.success).toBe(false);
    });

    test('accepts missing endpoint (optional)', () => {
        const validConfig = {
            tableName: 'isambard-conversations',
            region:    'us-east-1',
        };

        const result = dynamoDBConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.tableName).toBe('isambard-conversations');
            expect(result.data.region).toBe('us-east-1');
            expect(result.data.endpoint).toBeUndefined();
        }
    });
});

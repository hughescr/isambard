import { describe, test, expect } from 'bun:test';
import {
    sessionIdSchema,
    createSessionId,
    isSessionId
} from '@/storage/task-session/types';

describe.concurrent('sessionIdSchema', () => {
    test('should accept valid UUID', () => {
        const validUuid = '550e8400-e29b-41d4-a716-446655440000';
        const result = sessionIdSchema.safeParse(validUuid);
        expect(result.success).toBe(true);
    });

    test('should reject invalid UUID format', () => {
        const invalidUuid = 'not-a-uuid';
        const result = sessionIdSchema.safeParse(invalidUuid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('must be a valid UUID');
        }
    });

    test('should reject empty string', () => {
        const result = sessionIdSchema.safeParse('');
        expect(result.success).toBe(false);
    });

    test('should reject non-string values', () => {
        expect(sessionIdSchema.safeParse(123).success).toBe(false);
        expect(sessionIdSchema.safeParse(null).success).toBe(false);
        expect(sessionIdSchema.safeParse(undefined).success).toBe(false);
        expect(sessionIdSchema.safeParse({}).success).toBe(false);
    });

    test('should reject partial UUID', () => {
        const partialUuid = '550e8400-e29b-41d4-a716';
        const result = sessionIdSchema.safeParse(partialUuid);
        expect(result.success).toBe(false);
    });

    test('should reject UUID with wrong format (missing dashes)', () => {
        const uuidNoDashes = '550e8400e29b41d4a716446655440000';
        const result = sessionIdSchema.safeParse(uuidNoDashes);
        expect(result.success).toBe(false);
    });
});

describe('createSessionId', () => {
    test('should create branded SessionId from valid UUID', () => {
        const validUuid = '550e8400-e29b-41d4-a716-446655440000';
        const result = createSessionId(validUuid);
        // TypeScript ensures branded type is correct at compile time
        expect(result as string).toBe(validUuid);
    });

    test('should throw error for invalid UUID', () => {
        expect(() => createSessionId('not-a-uuid')).toThrow();
    });

    test('should throw error for empty string', () => {
        expect(() => createSessionId('')).toThrow();
    });

    test('should throw error for non-string input', () => {
        expect(() => createSessionId(123 as unknown as string)).toThrow();
    });
});

describe('isSessionId', () => {
    test('should return true for valid UUID string', () => {
        const validUuid = '550e8400-e29b-41d4-a716-446655440000';
        expect(isSessionId(validUuid)).toBe(true);
    });

    test('should return true for branded SessionId', () => {
        const validUuid = '550e8400-e29b-41d4-a716-446655440000';
        const sessionId = createSessionId(validUuid);
        expect(isSessionId(sessionId)).toBe(true);
    });

    test('should return false for invalid UUID', () => {
        expect(isSessionId('not-a-uuid')).toBe(false);
    });

    test('should return false for empty string', () => {
        expect(isSessionId('')).toBe(false);
    });

    test('should return false for non-string values', () => {
        expect(isSessionId(123)).toBe(false);
        expect(isSessionId(null)).toBe(false);
        expect(isSessionId(undefined)).toBe(false);
        expect(isSessionId({})).toBe(false);
    });
});

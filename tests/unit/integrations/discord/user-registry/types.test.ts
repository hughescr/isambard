/**
 * User Registry Types Tests
 *
 * Tests for user registry types and Zod schemas.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
    userMetadataSchema,
    createUserMetadata,
    isUserMetadata,
    type UserMetadata
} from '@/integrations/discord/user-registry/types';
import type { UserId } from '@/integrations/discord/types';

describe('userMetadataSchema', () => {
    it('should validate valid user metadata', () => {
        const validData = {
            userId:       '123456789012345678' as UserId,
            username:     'john',
            displayName:  'John Doe',
            discoveredAt: '2024-01-01T00:00:00.000Z',
            lastSeenAt:   '2024-01-02T00:00:00.000Z',
            updatedAt:    '2024-01-02T00:00:00.000Z',
        };

        expect(() => userMetadataSchema.parse(validData)).not.toThrow();
    });

    it('should fail validation when userId is missing', () => {
        const invalidData = {
            username:     'john',
            displayName:  'John Doe',
            discoveredAt: '2024-01-01T00:00:00.000Z',
            lastSeenAt:   '2024-01-02T00:00:00.000Z',
            updatedAt:    '2024-01-02T00:00:00.000Z',
        };

        expect(() => userMetadataSchema.parse(invalidData)).toThrow(z.ZodError);
    });

    it('should fail validation when username is empty', () => {
        const invalidData = {
            userId:       '123456789012345678' as UserId,
            username:     '',
            displayName:  'John Doe',
            discoveredAt: '2024-01-01T00:00:00.000Z',
            lastSeenAt:   '2024-01-02T00:00:00.000Z',
            updatedAt:    '2024-01-02T00:00:00.000Z',
        };

        expect(() => userMetadataSchema.parse(invalidData)).toThrow(z.ZodError);
    });

    it('should fail validation when displayName is missing', () => {
        const invalidData = {
            userId:       '123456789012345678' as UserId,
            username:     'john',
            discoveredAt: '2024-01-01T00:00:00.000Z',
            lastSeenAt:   '2024-01-02T00:00:00.000Z',
            updatedAt:    '2024-01-02T00:00:00.000Z',
        };

        expect(() => userMetadataSchema.parse(invalidData)).toThrow(z.ZodError);
    });

    it('should fail validation when discoveredAt is not a valid ISO datetime', () => {
        const invalidData = {
            userId:       '123456789012345678' as UserId,
            username:     'john',
            displayName:  'John Doe',
            discoveredAt: 'not-a-date',
            lastSeenAt:   '2024-01-02T00:00:00.000Z',
            updatedAt:    '2024-01-02T00:00:00.000Z',
        };

        expect(() => userMetadataSchema.parse(invalidData)).toThrow(z.ZodError);
    });

    it('should fail validation when lastSeenAt is not a valid ISO datetime', () => {
        const invalidData = {
            userId:       '123456789012345678' as UserId,
            username:     'john',
            displayName:  'John Doe',
            discoveredAt: '2024-01-01T00:00:00.000Z',
            lastSeenAt:   'not-a-date',
            updatedAt:    '2024-01-02T00:00:00.000Z',
        };

        expect(() => userMetadataSchema.parse(invalidData)).toThrow(z.ZodError);
    });

    it('should fail validation when updatedAt is not a valid ISO datetime', () => {
        const invalidData = {
            userId:       '123456789012345678' as UserId,
            username:     'john',
            displayName:  'John Doe',
            discoveredAt: '2024-01-01T00:00:00.000Z',
            lastSeenAt:   '2024-01-02T00:00:00.000Z',
            updatedAt:    'not-a-date',
        };

        expect(() => userMetadataSchema.parse(invalidData)).toThrow(z.ZodError);
    });
});

describe('createUserMetadata', () => {
    it('should create valid UserMetadata from valid data', () => {
        const validData = {
            userId:       '123456789012345678' as UserId,
            username:     'john',
            displayName:  'John Doe',
            discoveredAt: '2024-01-01T00:00:00.000Z',
            lastSeenAt:   '2024-01-02T00:00:00.000Z',
            updatedAt:    '2024-01-02T00:00:00.000Z',
        };

        const metadata = createUserMetadata(validData);
        expect(metadata).toEqual(validData);
    });

    it('should throw ZodError when data is invalid', () => {
        const invalidData = {
            userId:   '123456789012345678' as UserId,
            username: '',
        };

        expect(() => createUserMetadata(invalidData)).toThrow();
    });
});

describe('isUserMetadata', () => {
    it('should return true for valid UserMetadata', () => {
        const validData: UserMetadata = {
            userId:       '123456789012345678' as UserId,
            username:     'john',
            displayName:  'John Doe',
            discoveredAt: '2024-01-01T00:00:00.000Z',
            lastSeenAt:   '2024-01-02T00:00:00.000Z',
            updatedAt:    '2024-01-02T00:00:00.000Z',
        };

        expect(isUserMetadata(validData)).toBe(true);
    });

    it('should return false for invalid data', () => {
        const invalidData = {
            userId:   '123456789012345678' as UserId,
            username: '',
        };

        expect(isUserMetadata(invalidData)).toBe(false);
    });

    it('should return false for null', () => {
        expect(isUserMetadata(null)).toBe(false);
    });

    it('should return false for undefined', () => {
        expect(isUserMetadata(undefined)).toBe(false);
    });

    it('should return false for non-object values', () => {
        expect(isUserMetadata('string')).toBe(false);
        expect(isUserMetadata(123)).toBe(false);
        expect(isUserMetadata(true)).toBe(false);
    });
});

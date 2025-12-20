import { describe, it, expect } from 'bun:test';
import _ from 'lodash';
import {
    memoryTypeSchema,
    memorySchema,
    createMemoryKeys,
    type Memory
} from '@/storage/models/memory';

describe('memoryTypeSchema', () => {
    it('should accept identity type', () => {
        const result = memoryTypeSchema.safeParse('identity');
        expect(result.success).toBe(true);
    });

    it('should accept state type', () => {
        const result = memoryTypeSchema.safeParse('state');
        expect(result.success).toBe(true);
    });

    it('should accept event type', () => {
        const result = memoryTypeSchema.safeParse('event');
        expect(result.success).toBe(true);
    });

    it('should reject invalid type', () => {
        const result = memoryTypeSchema.safeParse('invalid');
        expect(result.success).toBe(false);
    });
});

describe('memorySchema', () => {
    const validMemory = {
        id:          '550e8400-e29b-41d4-a716-446655440000',
        memory_type: 'identity',
        content:     'Test content',
        createdAt:   '2024-01-01T00:00:00.000Z',
        updatedAt:   '2024-01-01T00:00:00.000Z',
    };

    it('should validate complete memory object', () => {
        const result = memorySchema.safeParse(validMemory);
        expect(result.success).toBe(true);
    });

    it('should apply default empty object for metadata', () => {
        const result = memorySchema.safeParse(validMemory);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.metadata).toEqual({});
        }
    });

    it('should apply default 0 for version', () => {
        const result = memorySchema.safeParse(validMemory);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.version).toBe(0);
        }
    });

    it('should require id', () => {
        const { id: _id, ...noId } = validMemory;
        const result = memorySchema.safeParse(noId);
        expect(result.success).toBe(false);
    });

    it('should require id to be uuid', () => {
        const result = memorySchema.safeParse({ ...validMemory, id: 'not-a-uuid' });
        expect(result.success).toBe(false);
    });

    it('should require memory_type', () => {
        const { memory_type: _memory_type, ...noType } = validMemory;
        const result = memorySchema.safeParse(noType);
        expect(result.success).toBe(false);
    });

    it('should require content', () => {
        const { content: _content, ...noContent } = validMemory;
        const result = memorySchema.safeParse(noContent);
        expect(result.success).toBe(false);
    });

    it('should reject empty content', () => {
        const result = memorySchema.safeParse({ ...validMemory, content: '' });
        expect(result.success).toBe(false);
    });

    it('should reject content over 350KB', () => {
        const largeContent = _.repeat('x', 350001);
        const result = memorySchema.safeParse({ ...validMemory, content: largeContent });
        expect(result.success).toBe(false);
    });

    it('should accept content at 350KB limit', () => {
        const maxContent = _.repeat('x', 350000);
        const result = memorySchema.safeParse({ ...validMemory, content: maxContent });
        expect(result.success).toBe(true);
    });

    it('should accept optional TTL', () => {
        const result = memorySchema.safeParse({ ...validMemory, TTL: 3600 });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.TTL).toBe(3600);
        }
    });

    it('should reject negative TTL', () => {
        const result = memorySchema.safeParse({ ...validMemory, TTL: -1 });
        expect(result.success).toBe(false);
    });

    it('should accept optional embeddingId', () => {
        const result = memorySchema.safeParse({ ...validMemory, embeddingId: 'emb-123' });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.embeddingId).toBe('emb-123');
        }
    });

    it('should validate createdAt as ISO datetime', () => {
        const result = memorySchema.safeParse({ ...validMemory, createdAt: 'not-a-date' });
        expect(result.success).toBe(false);
    });

    it('should validate updatedAt as ISO datetime', () => {
        const result = memorySchema.safeParse({ ...validMemory, updatedAt: 'not-a-date' });
        expect(result.success).toBe(false);
    });

    it('should accept custom metadata', () => {
        const result = memorySchema.safeParse({
            ...validMemory,
            metadata: { tags: ['test'], priority: 1 },
        });
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.metadata).toEqual({ tags: ['test'], priority: 1 });
        }
    });
});

describe('createMemoryKeys', () => {
    const memory: Memory = {
        id:          '550e8400-e29b-41d4-a716-446655440000',
        memory_type: 'identity',
        content:     'Test content',
        metadata:    {},
        version:     0,
        createdAt:   '2024-01-01T00:00:00.000Z',
        updatedAt:   '2024-01-01T00:00:00.000Z',
    };

    it('should create correct PK', () => {
        const keys = createMemoryKeys(memory);
        expect(keys.PK).toBe('MEMORY#550e8400-e29b-41d4-a716-446655440000');
    });

    it('should create correct SK', () => {
        const keys = createMemoryKeys(memory);
        expect(keys.SK).toBe('TYPE#identity');
    });

    it('should create correct GSI1PK', () => {
        const keys = createMemoryKeys(memory);
        expect(keys.GSI1PK).toBe('TYPE#identity');
    });

    it('should create correct GSI1SK', () => {
        const keys = createMemoryKeys(memory);
        expect(keys.GSI1SK).toBe('CREATED#2024-01-01T00:00:00.000Z');
    });
});

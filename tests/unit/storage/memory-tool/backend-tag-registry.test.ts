import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import { logger } from '@hughescr/logger';
import {
    TAG_REGISTRY_PATH,
    parseTagRegistry,
    computeTagChanges,
    updateTagRegistry,
    decrementTagRegistry,
    type TagRegistryCallbacks
} from '@/storage/memory-tool/backend-tag-registry';
import { createMemoryPath, type ContentType, type MemoryToolItemData } from '@/storage/memory-tool/types';

describe('backend-tag-registry', () => {
    describe('TAG_REGISTRY_PATH', () => {
        test('should be defined as /state/tag-registry', () => {
            expect(TAG_REGISTRY_PATH).toBe(createMemoryPath('/state/tag-registry'));
        });
    });

    describe('parseTagRegistry', () => {
        test('should return parsed object for valid JSON', () => {
            const content = JSON.stringify({ tag1: 5, tag2: 3 });
            const result = parseTagRegistry(content);
            expect(result).toEqual({ tag1: 5, tag2: 3 });
        });

        test('should return empty object for invalid JSON', () => {
            const result = parseTagRegistry('not valid json {');
            expect(result).toEqual({});
        });

        test('should return empty object for empty string', () => {
            const result = parseTagRegistry('');
            expect(result).toEqual({});
        });

        test('should handle nested JSON gracefully', () => {
            const content = JSON.stringify({ tag1: 5, nested: { a: 1 } });
            const result = parseTagRegistry(content);
            // Result can have nested structure but our TagRegistry type expects number values
            expect(result).toEqual({ tag1: 5, nested: { a: 1 } as unknown as number });
        });
    });

    describe('computeTagChanges', () => {
        test('should return added tags when new tags not in old', () => {
            const result = computeTagChanges(['a'], ['a', 'b', 'c']);
            expect(result.added).toEqual(['b', 'c']);
            expect(result.removed).toEqual([]);
        });

        test('should return removed tags when old tags not in new', () => {
            const result = computeTagChanges(['a', 'b', 'c'], ['a']);
            expect(result.added).toEqual([]);
            expect(result.removed).toEqual(['b', 'c']);
        });

        test('should handle undefined old tags', () => {
            const result = computeTagChanges(undefined, ['a', 'b']);
            expect(result.added).toEqual(['a', 'b']);
            expect(result.removed).toEqual([]);
        });

        test('should handle undefined new tags', () => {
            const result = computeTagChanges(['a', 'b'], undefined);
            expect(result.added).toEqual([]);
            expect(result.removed).toEqual(['a', 'b']);
        });

        test('should return empty arrays when tags unchanged', () => {
            const result = computeTagChanges(['a', 'b'], ['a', 'b']);
            expect(result.added).toEqual([]);
            expect(result.removed).toEqual([]);
        });

        test('should handle both added and removed', () => {
            const result = computeTagChanges(['a', 'b'], ['b', 'c']);
            expect(result.added).toEqual(['c']);
            expect(result.removed).toEqual(['a']);
        });

        test('should handle both undefined', () => {
            const result = computeTagChanges(undefined, undefined);
            expect(result.added).toEqual([]);
            expect(result.removed).toEqual([]);
        });
    });

    describe('updateTagRegistry', () => {
        let callbacks: TagRegistryCallbacks;
        let getMock: ReturnType<typeof mock>;
        let createMock: ReturnType<typeof mock>;
        let updateMock: ReturnType<typeof mock>;

        beforeEach(() => {
            getMock = mock(() => Promise.resolve(undefined));
            createMock = mock(() => Promise.resolve({} as MemoryToolItemData));
            updateMock = mock(() => Promise.resolve({} as MemoryToolItemData));
            callbacks = {
                get:    getMock,
                create: createMock,
                update: updateMock,
            };
        });

        test('should not call any callbacks when tags array is empty', async () => {
            await updateTagRegistry([], callbacks);

            expect(getMock).not.toHaveBeenCalled();
            expect(createMock).not.toHaveBeenCalled();
            expect(updateMock).not.toHaveBeenCalled();
        });

        test('should create registry when none exists', async () => {
            getMock = mock(() => Promise.resolve(undefined));
            callbacks.get = getMock;

            await updateTagRegistry(['tag1', 'tag2'], callbacks);

            expect(getMock).toHaveBeenCalledWith(TAG_REGISTRY_PATH);
            expect(createMock).toHaveBeenCalledWith({
                path:        TAG_REGISTRY_PATH,
                content:     JSON.stringify({ tag1: 1, tag2: 1 }),
                contentType: 'application/json',
                metadata:    { type: 'tag-registry' },
            });
            expect(updateMock).not.toHaveBeenCalled();
        });

        test('should increment existing tag counts', async () => {
            const existingRegistry = { tag1: 2, tag3: 1 };
            getMock = mock(() => Promise.resolve({
                path:        TAG_REGISTRY_PATH,
                content:     JSON.stringify(existingRegistry),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            } as MemoryToolItemData));
            callbacks.get = getMock;

            await updateTagRegistry(['tag1', 'tag2'], callbacks);

            expect(updateMock).toHaveBeenCalledWith(TAG_REGISTRY_PATH, {
                content: JSON.stringify({ tag1: 3, tag3: 1, tag2: 1 }),
            });
            expect(createMock).not.toHaveBeenCalled();
        });

        test('should log warning on error', async () => {
            const warnSpy = spyOn(logger, 'warn');
            const testError = new Error('Test error');
            getMock = mock(() => Promise.reject(testError));
            callbacks.get = getMock;

            await updateTagRegistry(['tag1'], callbacks);

            expect(warnSpy).toHaveBeenCalledWith({
                error: testError,
                tags:  ['tag1'],
                msg:   'Failed to update tag registry',
            });
            warnSpy.mockRestore();
        });
    });

    describe('decrementTagRegistry', () => {
        let callbacks: TagRegistryCallbacks;
        let getMock: ReturnType<typeof mock>;
        let createMock: ReturnType<typeof mock>;
        let updateMock: ReturnType<typeof mock>;

        beforeEach(() => {
            getMock = mock(() => Promise.resolve(undefined));
            createMock = mock(() => Promise.resolve({} as MemoryToolItemData));
            updateMock = mock(() => Promise.resolve({} as MemoryToolItemData));
            callbacks = {
                get:    getMock,
                create: createMock,
                update: updateMock,
            };
        });

        test('should not call any callbacks when tags array is empty', async () => {
            await decrementTagRegistry([], callbacks);

            expect(getMock).not.toHaveBeenCalled();
            expect(updateMock).not.toHaveBeenCalled();
        });

        test('should no-op when registry does not exist', async () => {
            getMock = mock(() => Promise.resolve(undefined));
            callbacks.get = getMock;

            await decrementTagRegistry(['tag1'], callbacks);

            expect(getMock).toHaveBeenCalledWith(TAG_REGISTRY_PATH);
            expect(updateMock).not.toHaveBeenCalled();
        });

        test('should decrement existing tag counts', async () => {
            const existingRegistry = { tag1: 3, tag2: 2 };
            getMock = mock(() => Promise.resolve({
                path:        TAG_REGISTRY_PATH,
                content:     JSON.stringify(existingRegistry),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            } as MemoryToolItemData));
            callbacks.get = getMock;

            await decrementTagRegistry(['tag1'], callbacks);

            expect(updateMock).toHaveBeenCalledWith(TAG_REGISTRY_PATH, {
                content: JSON.stringify({ tag1: 2, tag2: 2 }),
            });
        });

        test('should remove tags that reach zero', async () => {
            const existingRegistry = { tag1: 1, tag2: 2 };
            getMock = mock(() => Promise.resolve({
                path:        TAG_REGISTRY_PATH,
                content:     JSON.stringify(existingRegistry),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            } as MemoryToolItemData));
            callbacks.get = getMock;

            await decrementTagRegistry(['tag1'], callbacks);

            expect(updateMock).toHaveBeenCalledWith(TAG_REGISTRY_PATH, {
                content: JSON.stringify({ tag2: 2 }),
            });
        });

        test('should ignore tags not in registry', async () => {
            const existingRegistry = { tag1: 2 };
            getMock = mock(() => Promise.resolve({
                path:        TAG_REGISTRY_PATH,
                content:     JSON.stringify(existingRegistry),
                contentType: 'application/json' as ContentType,
                metadata:    {},
                version:     1,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            } as MemoryToolItemData));
            callbacks.get = getMock;

            await decrementTagRegistry(['nonexistent'], callbacks);

            // Should not call update since no modification was made
            expect(updateMock).not.toHaveBeenCalled();
        });

        test('should log warning on error', async () => {
            const warnSpy = spyOn(logger, 'warn');
            const testError = new Error('Test error');
            getMock = mock(() => Promise.reject(testError));
            callbacks.get = getMock;

            await decrementTagRegistry(['tag1'], callbacks);

            expect(warnSpy).toHaveBeenCalledWith({
                error: testError,
                tags:  ['tag1'],
                msg:   'Failed to decrement tag registry',
            });
            warnSpy.mockRestore();
        });
    });
});

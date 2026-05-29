import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { mockLogger } from '../../../../setup';
import type { CatchUpCompletionSignal, CatchUpInProgressSignal } from '@/integrations/discord/catchup/session-runner';
import { createCatchUpSignalAdapter, type CatchUpSignalAdapter } from '@/integrations/discord/catchup/signal-adapter';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';
import type { MemoryPath, MemoryToolItem } from '@/storage/memory-tool/types';

describe('createCatchUpSignalAdapter', () => {
    let mockBackend: Partial<MemoryToolBackend>;
    let adapter: CatchUpSignalAdapter;

    beforeEach(() => {
        const mockItem = {} as MemoryToolItem;

        // Create a mock memory backend
        mockBackend = {
            get:      mock(async () => undefined),
            create:   mock(async () => mockItem),
            update:   mock(async () => mockItem),
            'delete': mock(async () => mockItem),
        };

        adapter = createCatchUpSignalAdapter(mockBackend as MemoryToolBackend);
    });

    describe('storeCompletionSignal', () => {
        const signal: CatchUpCompletionSignal = {
            completedAt:       '2024-01-15T12:30:00.000Z',
            channelsProcessed: 5,
            messagesProcessed: 42,
        };

        test('should create new memory item when none exists', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.create = mock(async () => ({} as MemoryToolItem));

            await adapter.storeCompletionSignal(signal);

            expect(mockBackend.get).toHaveBeenCalledWith('/state/catchup-completion');
            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/state/catchup-completion' as MemoryPath,
                content:     JSON.stringify(signal),
                contentType: 'application/json',
            });
        });

        test('should update existing memory item when one exists', async () => {
            const existingItem: MemoryToolItem = {
                PK:          'DIR#/state',
                SK:          'FILE#catchup-completion',
                GSI1PK:      'LAYER#state',
                GSI1SK:      'UPDATED#2024-01-15T10:00:00.000Z',
                path:        '/state/catchup-completion' as MemoryPath,
                content:     '{"old":"data"}',
                contentType: 'application/json',
                metadata:    {},
                createdAt:   '2024-01-15T10:00:00.000Z',
                updatedAt:   '2024-01-15T10:00:00.000Z',
            };

            mockBackend.get = mock(async () => existingItem);
            mockBackend.update = mock(async () => ({} as MemoryToolItem));

            await adapter.storeCompletionSignal(signal);

            expect(mockBackend.get).toHaveBeenCalledWith('/state/catchup-completion');
            expect(mockBackend.update).toHaveBeenCalledWith(
                '/state/catchup-completion',
                { content: JSON.stringify(signal) }
            );
        });

        test('should swallow errors and log them', async () => {
            const error = new Error('DynamoDB connection failed');
            mockBackend.get = mock(async () => {
                throw error;
            });
            mockLogger.error.mockClear();

            // Should not throw
            await adapter.storeCompletionSignal(signal);

            expect(mockLogger.error).toHaveBeenCalledWith({
                error: 'DynamoDB connection failed',
                msg:   'Failed to store catch-up completion signal',
            });
        });

        test('should handle non-Error exceptions', async () => {
            mockBackend.get = mock(async () => {
                throw 'string error';
            });
            mockLogger.error.mockClear();

            // Should not throw
            await adapter.storeCompletionSignal(signal);

            expect(mockLogger.error).toHaveBeenCalledWith({
                error: 'string error',
                msg:   'Failed to store catch-up completion signal',
            });
        });
    });

    describe('loadCompletionSignal', () => {
        const signal: CatchUpCompletionSignal = {
            completedAt:       '2024-01-15T12:30:00.000Z',
            channelsProcessed: 5,
            messagesProcessed: 42,
        };

        test('should return parsed signal when memory exists', async () => {
            const existingItem: MemoryToolItem = {
                PK:          'DIR#/state',
                SK:          'FILE#catchup-completion',
                GSI1PK:      'LAYER#state',
                GSI1SK:      'UPDATED#2024-01-15T10:00:00.000Z',
                path:        '/state/catchup-completion' as MemoryPath,
                content:     JSON.stringify(signal),
                contentType: 'application/json',
                metadata:    {},
                createdAt:   '2024-01-15T10:00:00.000Z',
                updatedAt:   '2024-01-15T10:00:00.000Z',
            };

            mockBackend.get = mock(async () => existingItem);

            const result = await adapter.loadCompletionSignal();

            expect(mockBackend.get).toHaveBeenCalledWith('/state/catchup-completion');
            expect(result).toEqual(signal);
        });

        test('should return null when memory does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            const result = await adapter.loadCompletionSignal();

            expect(mockBackend.get).toHaveBeenCalledWith('/state/catchup-completion');
            expect(result).toBeNull();
        });

        test('should swallow errors and return null', async () => {
            const error = new Error('DynamoDB connection failed');
            mockBackend.get = mock(async () => {
                throw error;
            });

            const result = await adapter.loadCompletionSignal();

            expect(result).toBeNull();
        });

        test('should handle non-Error exceptions and return null', async () => {
            mockBackend.get = mock(async () => {
                throw 'string error';
            });

            const result = await adapter.loadCompletionSignal();

            expect(result).toBeNull();
        });
    });

    describe('storeInProgressSignal', () => {
        const signal: CatchUpInProgressSignal = {
            startedAt: '2024-01-15T10:00:00.000Z',
        };

        test('should create new memory item when none exists', async () => {
            mockBackend.get = mock(async () => undefined);
            mockBackend.create = mock(async () => ({} as MemoryToolItem));

            await adapter.storeInProgressSignal(signal);

            expect(mockBackend.get).toHaveBeenCalledWith('/state/catchup-inprogress');
            expect(mockBackend.create).toHaveBeenCalledWith({
                path:        '/state/catchup-inprogress' as MemoryPath,
                content:     JSON.stringify(signal),
                contentType: 'application/json',
            });
        });

        test('should update existing memory item when one exists', async () => {
            const existingItem: MemoryToolItem = {
                PK:          'DIR#/state',
                SK:          'FILE#catchup-inprogress',
                GSI1PK:      'LAYER#state',
                GSI1SK:      'UPDATED#2024-01-15T10:00:00.000Z',
                path:        '/state/catchup-inprogress' as MemoryPath,
                content:     '{"old":"data"}',
                contentType: 'application/json',
                metadata:    {},
                createdAt:   '2024-01-15T10:00:00.000Z',
                updatedAt:   '2024-01-15T10:00:00.000Z',
            };

            mockBackend.get = mock(async () => existingItem);
            mockBackend.update = mock(async () => ({} as MemoryToolItem));

            await adapter.storeInProgressSignal(signal);

            expect(mockBackend.get).toHaveBeenCalledWith('/state/catchup-inprogress');
            expect(mockBackend.update).toHaveBeenCalledWith(
                '/state/catchup-inprogress',
                { content: JSON.stringify(signal) }
            );
        });

        test('should swallow errors and log them', async () => {
            const error = new Error('DynamoDB connection failed');
            mockBackend.get = mock(async () => {
                throw error;
            });
            mockLogger.error.mockClear();

            // Should not throw
            await adapter.storeInProgressSignal(signal);

            expect(mockLogger.error).toHaveBeenCalledWith({
                error: 'DynamoDB connection failed',
                msg:   'Failed to store catch-up in-progress signal',
            });
        });

        test('should handle non-Error exceptions', async () => {
            mockBackend.get = mock(async () => {
                throw 'string error';
            });
            mockLogger.error.mockClear();

            // Should not throw
            await adapter.storeInProgressSignal(signal);

            expect(mockLogger.error).toHaveBeenCalledWith({
                error: 'string error',
                msg:   'Failed to store catch-up in-progress signal',
            });
        });
    });

    describe('loadInProgressSignal', () => {
        const signal: CatchUpInProgressSignal = {
            startedAt: '2024-01-15T10:00:00.000Z',
        };

        test('should return parsed signal when memory exists', async () => {
            const existingItem: MemoryToolItem = {
                PK:          'DIR#/state',
                SK:          'FILE#catchup-inprogress',
                GSI1PK:      'LAYER#state',
                GSI1SK:      'UPDATED#2024-01-15T10:00:00.000Z',
                path:        '/state/catchup-inprogress' as MemoryPath,
                content:     JSON.stringify(signal),
                contentType: 'application/json',
                metadata:    {},
                createdAt:   '2024-01-15T10:00:00.000Z',
                updatedAt:   '2024-01-15T10:00:00.000Z',
            };

            mockBackend.get = mock(async () => existingItem);

            const result = await adapter.loadInProgressSignal();

            expect(mockBackend.get).toHaveBeenCalledWith('/state/catchup-inprogress');
            expect(result).toEqual(signal);
        });

        test('should return null when memory does not exist', async () => {
            mockBackend.get = mock(async () => undefined);

            const result = await adapter.loadInProgressSignal();

            expect(mockBackend.get).toHaveBeenCalledWith('/state/catchup-inprogress');
            expect(result).toBeNull();
        });

        test('should swallow errors and return null', async () => {
            const error = new Error('DynamoDB connection failed');
            mockBackend.get = mock(async () => {
                throw error;
            });

            const result = await adapter.loadInProgressSignal();

            expect(result).toBeNull();
        });

        test('should handle non-Error exceptions and return null', async () => {
            mockBackend.get = mock(async () => {
                throw 'string error';
            });

            const result = await adapter.loadInProgressSignal();

            expect(result).toBeNull();
        });
    });

    describe('deleteInProgressSignal', () => {
        test('should call backend delete with correct path', async () => {
            mockBackend.delete = mock(async () => ({} as MemoryToolItem));

            await adapter.deleteInProgressSignal();

            expect(mockBackend.delete).toHaveBeenCalledWith('/state/catchup-inprogress');
        });

        test('should swallow errors and log them', async () => {
            const error = new Error('DynamoDB connection failed');
            mockBackend.delete = mock(async () => {
                throw error;
            });
            mockLogger.error.mockClear();

            // Should not throw
            await adapter.deleteInProgressSignal();

            expect(mockLogger.error).toHaveBeenCalledWith({
                error: 'DynamoDB connection failed',
                msg:   'Failed to delete catch-up in-progress signal',
            });
        });

        test('should handle non-Error exceptions', async () => {
            mockBackend.delete = mock(async () => {
                throw 'string error';
            });
            mockLogger.error.mockClear();

            // Should not throw
            await adapter.deleteInProgressSignal();

            expect(mockLogger.error).toHaveBeenCalledWith({
                error: 'string error',
                msg:   'Failed to delete catch-up in-progress signal',
            });
        });
    });
});

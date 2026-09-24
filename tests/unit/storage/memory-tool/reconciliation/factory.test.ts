import { describe, expect, it, mock } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { reconciliationAccess, type MemoryToolBackend } from '@/storage/memory-tool/backend';
import { createMemoryTagIndexReconciliationScheduler } from '@/storage/memory-tool/reconciliation/factory';
import type { ReconcilerDeps, ReconcilerOptions } from '@/storage/memory-tool/reconciliation/reconciler';
import type { ReconciliationConfig, ReconciliationResult } from '@/storage/memory-tool/reconciliation/types';
import { createMemoryPath } from '@/storage/memory-tool/types';

const config: ReconciliationConfig = {
    enabled:          true,
    intervalMs:       1000,
    operationDelayMs: 0,
    scanPageSize:     25,
    backoff:          { baseDelayMs: 100, maxAttempts: 3 },
};

describe('createMemoryTagIndexReconciliationScheduler', () => {
    it('binds backend operations and caller configuration to the reconciler', async () => {
        const path = createMemoryPath('/identity/core');
        const item = {
            path,
            content:     'core',
            contentType: 'text/plain' as const,
            metadata:    {},
            createdAt:   '2026-01-01T00:00:00Z',
            updatedAt:   '2026-01-01T00:00:00Z',
        };
        const get = mock(async () => item);
        const updateMemoryMetadata = mock(async () => item);
        const tagIndex = {
            createTagIndexItems:  mock(async () => {}),
            refreshTagIndexItems: mock(async () => {}),
            deleteTagIndexItems:  mock(async () => {}),
            listTagCounts:        mock(async () => []),
        };
        const backend = {
            get,
            [reconciliationAccess]: () => ({ tagIndex, updateMemoryMetadata }),
        } as unknown as MemoryToolBackend;
        const docClient = {} as DynamoDBDocumentClient;
        const result = { success: true, totalDurationMs: 0 } as ReconciliationResult;
        const runReconciliation = mock(async (_deps: ReconcilerDeps, _options: ReconcilerOptions) => result);
        const scheduler = createMemoryTagIndexReconciliationScheduler(backend, config, {
            docClient, tableName: 'TestTable', runReconciliation,
        });
        try {
            expect(await scheduler.triggerNow()).toBe(result);
            const [deps, options] = runReconciliation.mock.calls[0];
            expect(deps.docClient).toBe(docClient);
            expect(deps.tableName).toBe('TestTable');
            expect(deps.tagIndex).toBe(tagIndex);
            expect(await deps.getMemory(path)).toBe(item);
            expect(get).toHaveBeenCalledWith(path);
            expect(await deps.updateMemoryMetadata(path, { metadata: { previouslyKnownAs: [] } })).toBe(item);
            expect(updateMemoryMetadata).toHaveBeenCalledWith(path, { metadata: { previouslyKnownAs: [] } });
            expect(options.operationDelayMs).toBe(0);
        } finally {
            scheduler.stop();
        }
    });

    it('defaults to the real reconciler when no override is supplied', async () => {
        const send = mock(async () => ({ Items: [], Count: 0 }));
        const docClient = { send } as unknown as DynamoDBDocumentClient;
        const get = mock(async () => undefined);
        const backend = {
            get,
            [reconciliationAccess]: () => ({
                tagIndex: {
                    createTagIndexItems:  mock(async () => {}),
                    refreshTagIndexItems: mock(async () => {}),
                    deleteTagIndexItems:  mock(async () => {}),
                    listTagCounts:        mock(async () => []),
                },
                updateMemoryMetadata: mock(async () => { throw new Error('unexpected update'); }),
            }),
        } as unknown as MemoryToolBackend;
        const scheduler = createMemoryTagIndexReconciliationScheduler(backend, config, {
            docClient, tableName: 'TestTable',
        });
        try {
            const result = await scheduler.triggerNow();
            expect(result?.success).toBe(true);
            expect(result?.phaseA.itemsScanned).toBe(0);
            expect(result?.phaseB.itemsScanned).toBe(0);
            expect(result?.phaseC.countsVerified).toBe(0);
            expect(send).toHaveBeenCalled();
        } finally {
            scheduler.stop();
        }
    });
});

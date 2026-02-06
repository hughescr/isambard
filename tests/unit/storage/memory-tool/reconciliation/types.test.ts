import { describe, test, expect } from 'bun:test';
import {
    reconciliationConfigSchema,
    reconciliationStateSchema,
    reconciliationProgressSchema,
    reconciliationResultSchema,
    type ReconciliationState,
    type ReconciliationProgress,
    type ReconciliationResult
} from '@/storage/memory-tool/reconciliation/types';

describe.concurrent('reconciliationConfigSchema', () => {
    test('should accept empty object with all defaults', () => {
        const result = reconciliationConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.enabled).toBe(false);
            expect(result.data.intervalMs).toBe(24 * 60 * 60 * 1000);
            expect(result.data.operationDelayMs).toBe(1000);
            expect(result.data.scanPageSize).toBe(25);
            expect(result.data.backoff.baseDelayMs).toBe(100);
            expect(result.data.backoff.maxAttempts).toBe(3);
            expect(result.data.testMode).toBeUndefined();
        }
    });

    test('should accept valid configuration with all fields', () => {
        const config = {
            enabled:          true,
            intervalMs:       3600000, // 1 hour
            operationDelayMs: 500,
            scanPageSize:     50,
            backoff:          {
                baseDelayMs: 200,
                maxAttempts: 5,
            },
            testMode: {
                triggerOnStartup: true,
                runOnce:          true,
            },
        };
        const result = reconciliationConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual(config);
        }
    });

    test('should accept configuration with partial fields', () => {
        const config = {
            enabled:    true,
            intervalMs: 7200000, // 2 hours
        };
        const result = reconciliationConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.enabled).toBe(true);
            expect(result.data.intervalMs).toBe(7200000);
            expect(result.data.operationDelayMs).toBe(1000); // default
            expect(result.data.scanPageSize).toBe(25); // default
        }
    });

    test('should reject negative intervalMs', () => {
        const result = reconciliationConfigSchema.safeParse({
            intervalMs: -1000,
        });
        expect(result.success).toBe(false);
    });

    test('should reject zero intervalMs', () => {
        const result = reconciliationConfigSchema.safeParse({
            intervalMs: 0,
        });
        expect(result.success).toBe(false);
    });

    test('should reject negative operationDelayMs', () => {
        const result = reconciliationConfigSchema.safeParse({
            operationDelayMs: -500,
        });
        expect(result.success).toBe(false);
    });

    test('should reject negative scanPageSize', () => {
        const result = reconciliationConfigSchema.safeParse({
            scanPageSize: -10,
        });
        expect(result.success).toBe(false);
    });

    test('should reject zero scanPageSize', () => {
        const result = reconciliationConfigSchema.safeParse({
            scanPageSize: 0,
        });
        expect(result.success).toBe(false);
    });

    test('should reject invalid backoff configuration', () => {
        const result = reconciliationConfigSchema.safeParse({
            backoff: {
                baseDelayMs: -100,
                maxAttempts: 3,
            },
        });
        expect(result.success).toBe(false);
    });

    test('should reject non-boolean enabled field', () => {
        const result = reconciliationConfigSchema.safeParse({
            enabled: 'true',
        });
        expect(result.success).toBe(false);
    });

    test('should accept testMode with only triggerOnStartup', () => {
        const config = {
            testMode: {
                triggerOnStartup: true,
            },
        };
        const result = reconciliationConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.testMode?.triggerOnStartup).toBe(true);
            expect(result.data.testMode?.runOnce).toBeUndefined();
        }
    });

    test('should accept testMode with only runOnce', () => {
        const config = {
            testMode: {
                runOnce: true,
            },
        };
        const result = reconciliationConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.testMode?.runOnce).toBe(true);
            expect(result.data.testMode?.triggerOnStartup).toBeUndefined();
        }
    });
});

describe.concurrent('reconciliationStateSchema', () => {
    test('should accept valid state with all fields', () => {
        const state: ReconciliationState = {
            isRunning:       true,
            currentPhase:    'phaseA',
            runStartedAt:    new Date('2024-01-01T00:00:00Z'),
            lastCompletedAt: new Date('2024-01-01T01:00:00Z'),
        };
        const result = reconciliationStateSchema.safeParse(state);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual(state);
        }
    });

    test('should accept state with minimal fields', () => {
        const state: ReconciliationState = {
            isRunning:    false,
            currentPhase: null,
        };
        const result = reconciliationStateSchema.safeParse(state);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.isRunning).toBe(false);
            expect(result.data.currentPhase).toBe(null);
            expect(result.data.runStartedAt).toBeUndefined();
            expect(result.data.lastCompletedAt).toBeUndefined();
        }
    });

    test('should accept phaseA as currentPhase', () => {
        const result = reconciliationStateSchema.safeParse({
            isRunning:    true,
            currentPhase: 'phaseA',
        });
        expect(result.success).toBe(true);
    });

    test('should accept phaseB as currentPhase', () => {
        const result = reconciliationStateSchema.safeParse({
            isRunning:    true,
            currentPhase: 'phaseB',
        });
        expect(result.success).toBe(true);
    });

    test('should accept null as currentPhase', () => {
        const result = reconciliationStateSchema.safeParse({
            isRunning:    false,
            currentPhase: null,
        });
        expect(result.success).toBe(true);
    });

    test('should reject invalid phase name', () => {
        const result = reconciliationStateSchema.safeParse({
            isRunning:    true,
            currentPhase: 'phaseC',
        });
        expect(result.success).toBe(false);
    });

    test('should reject non-boolean isRunning', () => {
        const result = reconciliationStateSchema.safeParse({
            isRunning:    'true',
            currentPhase: null,
        });
        expect(result.success).toBe(false);
    });

    test('should reject invalid date format for runStartedAt', () => {
        const result = reconciliationStateSchema.safeParse({
            isRunning:    true,
            currentPhase: 'phaseA',
            runStartedAt: 'not-a-date',
        });
        expect(result.success).toBe(false);
    });
});

describe.concurrent('reconciliationProgressSchema', () => {
    test('should accept valid progress with all fields', () => {
        const progress: ReconciliationProgress = {
            phase:               'phaseA',
            itemsScanned:        100,
            indexItemsCreated:   10,
            indexItemsRefreshed: 5,
            indexItemsDeleted:   2,
            metadataCleaned:     3,
            errors:              0,
            startTime:           new Date('2024-01-01T00:00:00Z'),
            endTime:             new Date('2024-01-01T01:00:00Z'),
        };
        const result = reconciliationProgressSchema.safeParse(progress);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).toEqual(progress);
        }
    });

    test('should accept progress without endTime', () => {
        const progress: ReconciliationProgress = {
            phase:               'phaseB',
            itemsScanned:        50,
            indexItemsCreated:   5,
            indexItemsRefreshed: 2,
            indexItemsDeleted:   1,
            metadataCleaned:     0,
            errors:              1,
            startTime:           new Date('2024-01-01T00:00:00Z'),
        };
        const result = reconciliationProgressSchema.safeParse(progress);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.endTime).toBeUndefined();
        }
    });

    test('should reject negative itemsScanned', () => {
        const result = reconciliationProgressSchema.safeParse({
            phase:               'phaseA',
            itemsScanned:        -1,
            indexItemsCreated:   0,
            indexItemsRefreshed: 0,
            indexItemsDeleted:   0,
            metadataCleaned:     0,
            errors:              0,
            startTime:           new Date(),
        });
        expect(result.success).toBe(false);
    });

    test('should reject negative indexItemsCreated', () => {
        const result = reconciliationProgressSchema.safeParse({
            phase:               'phaseA',
            itemsScanned:        10,
            indexItemsCreated:   -1,
            indexItemsRefreshed: 0,
            indexItemsDeleted:   0,
            metadataCleaned:     0,
            errors:              0,
            startTime:           new Date(),
        });
        expect(result.success).toBe(false);
    });

    test('should accept zero for all counters', () => {
        const progress: ReconciliationProgress = {
            phase:               'phaseA',
            itemsScanned:        0,
            indexItemsCreated:   0,
            indexItemsRefreshed: 0,
            indexItemsDeleted:   0,
            metadataCleaned:     0,
            errors:              0,
            startTime:           new Date(),
        };
        const result = reconciliationProgressSchema.safeParse(progress);
        expect(result.success).toBe(true);
    });

    test('should reject invalid phase', () => {
        const result = reconciliationProgressSchema.safeParse({
            phase:               'phaseC',
            itemsScanned:        10,
            indexItemsCreated:   1,
            indexItemsRefreshed: 0,
            indexItemsDeleted:   0,
            metadataCleaned:     0,
            errors:              0,
            startTime:           new Date(),
        });
        expect(result.success).toBe(false);
    });

    test('should reject non-date startTime', () => {
        const result = reconciliationProgressSchema.safeParse({
            phase:               'phaseA',
            itemsScanned:        10,
            indexItemsCreated:   1,
            indexItemsRefreshed: 0,
            indexItemsDeleted:   0,
            metadataCleaned:     0,
            errors:              0,
            startTime:           'not-a-date',
        });
        expect(result.success).toBe(false);
    });
});

describe.concurrent('reconciliationResultSchema', () => {
    test('should accept valid result', () => {
        const result: ReconciliationResult = {
            success: true,
            phaseA:  {
                phase:               'phaseA',
                itemsScanned:        100,
                indexItemsCreated:   10,
                indexItemsRefreshed: 5,
                indexItemsDeleted:   0,
                metadataCleaned:     0,
                errors:              0,
                startTime:           new Date('2024-01-01T00:00:00Z'),
                endTime:             new Date('2024-01-01T00:30:00Z'),
            },
            phaseB: {
                phase:               'phaseB',
                itemsScanned:        50,
                indexItemsCreated:   0,
                indexItemsRefreshed: 0,
                indexItemsDeleted:   2,
                metadataCleaned:     0,
                errors:              0,
                startTime:           new Date('2024-01-01T00:30:00Z'),
                endTime:             new Date('2024-01-01T01:00:00Z'),
            },
            totalDurationMs: 3600000,
        };
        const parseResult = reconciliationResultSchema.safeParse(result);
        expect(parseResult.success).toBe(true);
        if(parseResult.success) {
            expect(parseResult.data).toEqual(result);
        }
    });

    test('should reject negative totalDurationMs', () => {
        const result = reconciliationResultSchema.safeParse({
            success: true,
            phaseA:  {
                phase:               'phaseA',
                itemsScanned:        0,
                indexItemsCreated:   0,
                indexItemsRefreshed: 0,
                indexItemsDeleted:   0,
                metadataCleaned:     0,
                errors:              0,
                startTime:           new Date(),
            },
            phaseB: {
                phase:               'phaseB',
                itemsScanned:        0,
                indexItemsCreated:   0,
                indexItemsRefreshed: 0,
                indexItemsDeleted:   0,
                metadataCleaned:     0,
                errors:              0,
                startTime:           new Date(),
            },
            totalDurationMs: -1000,
        });
        expect(result.success).toBe(false);
    });

    test('should reject non-boolean success', () => {
        const result = reconciliationResultSchema.safeParse({
            success: 'true',
            phaseA:  {
                phase:               'phaseA',
                itemsScanned:        0,
                indexItemsCreated:   0,
                indexItemsRefreshed: 0,
                indexItemsDeleted:   0,
                metadataCleaned:     0,
                errors:              0,
                startTime:           new Date(),
            },
            phaseB: {
                phase:               'phaseB',
                itemsScanned:        0,
                indexItemsCreated:   0,
                indexItemsRefreshed: 0,
                indexItemsDeleted:   0,
                metadataCleaned:     0,
                errors:              0,
                startTime:           new Date(),
            },
            totalDurationMs: 1000,
        });
        expect(result.success).toBe(false);
    });

    test('should require both phaseA and phaseB', () => {
        const result = reconciliationResultSchema.safeParse({
            success: true,
            phaseA:  {
                phase:               'phaseA',
                itemsScanned:        0,
                indexItemsCreated:   0,
                indexItemsRefreshed: 0,
                indexItemsDeleted:   0,
                metadataCleaned:     0,
                errors:              0,
                startTime:           new Date(),
            },
            totalDurationMs: 1000,
        });
        expect(result.success).toBe(false);
    });
});

/**
 * Tag Index Reconciliation Types
 *
 * Types for tag index reconciliation job that ensures consistency
 * between memory items and their tag index entries.
 */

import { z } from 'zod';

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Backoff configuration for exponential retry
 */
/* Stryker disable BooleanLiteral,ArithmeticOperator: Default values are configuration */
export const reconciliationBackoffSchema = z.object({
    /** Base delay in milliseconds for exponential backoff */
    baseDelayMs: z.number().int().positive().default(100),
    /** Maximum number of retry attempts */
    maxAttempts: z.number().int().positive().default(3),
});
/* Stryker restore BooleanLiteral,ArithmeticOperator */

export type ReconciliationBackoff = z.infer<typeof reconciliationBackoffSchema>;

/**
 * Test mode configuration for manual triggering
 */
/* Stryker disable BooleanLiteral: Default values are configuration */
export const reconciliationTestModeSchema = z.object({
    /** Whether to trigger reconciliation immediately on startup */
    triggerOnStartup: z.boolean().optional(),
    /** Run only once instead of on interval (for testing) */
    runOnce:          z.boolean().optional(),
});
/* Stryker restore BooleanLiteral */

export type ReconciliationTestMode = z.infer<typeof reconciliationTestModeSchema>;

/**
 * Configuration for tag index reconciliation job
 */
/* Stryker disable BooleanLiteral,ArithmeticOperator: Default values are configuration */
export const reconciliationConfigSchema = z.object({
    /** Whether reconciliation job is enabled */
    enabled:          z.boolean().default(false),
    /** Interval between runs in milliseconds (default: 24 hours) */
    intervalMs:       z.number().int().positive().default(24 * 60 * 60 * 1000),
    /** Delay between DynamoDB operations in milliseconds (default: 1000ms) */
    operationDelayMs: z.number().int().nonnegative().default(1000),
    /** DynamoDB page size for scans (default: 25) */
    scanPageSize:     z.number().int().positive().default(25),
    /** Exponential backoff config */
    backoff:          reconciliationBackoffSchema.default({
        baseDelayMs: 100,
        maxAttempts: 3,
    }),
    /** Test mode for manual triggering */
    testMode: reconciliationTestModeSchema.optional(),
});
/* Stryker restore BooleanLiteral,ArithmeticOperator */

export type ReconciliationConfig = z.infer<typeof reconciliationConfigSchema>;

// ============================================================================
// Runtime State Types
// ============================================================================

/**
 * Phase identifier for reconciliation job
 */
/* Stryker disable StringLiteral: Enum values are configuration */
export const reconciliationPhaseSchema = z.enum(['phaseA', 'phaseB', 'phaseC']);
/* Stryker restore StringLiteral */

export type ReconciliationPhase = z.infer<typeof reconciliationPhaseSchema>;

/**
 * Runtime state for reconciliation job
 */
export const reconciliationStateSchema = z.object({
    /** Whether reconciliation is currently running */
    isRunning:       z.boolean(),
    /** Current phase being executed */
    currentPhase:    reconciliationPhaseSchema.nullable(),
    /** When the current run started */
    runStartedAt:    z.date().optional(),
    /** When the last run completed */
    lastCompletedAt: z.date().optional(),
});

export type ReconciliationState = z.infer<typeof reconciliationStateSchema>;

// ============================================================================
// Progress Tracking Types
// ============================================================================

/**
 * Progress tracking for a single reconciliation phase
 */
export const reconciliationProgressSchema = z.object({
    /** Which phase this progress represents */
    phase:               reconciliationPhaseSchema,
    /** Number of items scanned */
    itemsScanned:        z.number().int().nonnegative(),
    /** Number of tag index entries created */
    indexItemsCreated:   z.number().int().nonnegative(),
    /** Number of tag index entries refreshed (updated) */
    indexItemsRefreshed: z.number().int().nonnegative(),
    /** Number of tag index entries deleted */
    indexItemsDeleted:   z.number().int().nonnegative(),
    /** Number of memory items with previouslyKnownAs metadata cleaned */
    metadataCleaned:     z.number().int().nonnegative(),
    /** Number of META_COUNT items verified (Phase C only) */
    countsVerified:      z.number().int().nonnegative().optional(),
    /** Number of META_COUNT items corrected (Phase C only) */
    countsCorrected:     z.number().int().nonnegative().optional(),
    /** Number of META_COUNT items deleted (Phase C only) */
    countsDeleted:       z.number().int().nonnegative().optional(),
    /** Number of errors encountered */
    errors:              z.number().int().nonnegative(),
    /** When this phase started */
    startTime:           z.date(),
    /** When this phase ended (undefined if still running) */
    endTime:             z.date().optional(),
});

export type ReconciliationProgress = z.infer<typeof reconciliationProgressSchema>;

/**
 * Complete result of a reconciliation run
 */
export const reconciliationResultSchema = z.object({
    /** Whether the reconciliation completed successfully */
    success:         z.boolean(),
    /** Progress for Phase A (scan memory items) */
    phaseA:          reconciliationProgressSchema,
    /** Progress for Phase B (scan tag index) */
    phaseB:          reconciliationProgressSchema,
    /** Progress for Phase C (verify META_COUNT items) */
    phaseC:          reconciliationProgressSchema,
    /** Total duration of all phases in milliseconds */
    totalDurationMs: z.number().int().nonnegative(),
});

export type ReconciliationResult = z.infer<typeof reconciliationResultSchema>;

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

export {
    reconciliationConfigSchema,
    type ReconciliationConfig
} from '@/config';

// ============================================================================
// Runtime State Types
// ============================================================================

/**
 * Phase identifier for reconciliation job
 */
const reconciliationPhaseSchema = z.enum(['phaseA', 'phaseB', 'phaseC']);

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

const progressBaseSchema = z.object({
    /** Number of errors encountered */
    errors:    z.number().int().nonnegative(),
    /** When this phase started */
    startTime: z.date(),
    /** When this phase ended (undefined if still running) */
    endTime:   z.date().optional(),
});

export const phaseASchema = progressBaseSchema.extend({
    phase:               z.literal('phaseA'),
    itemsScanned:        z.number().int().nonnegative(),
    indexItemsCreated:   z.number().int().nonnegative(),
    indexItemsRefreshed: z.number().int().nonnegative(),
    metadataCleaned:     z.number().int().nonnegative(),
});

export const phaseBSchema = progressBaseSchema.extend({
    phase:             z.literal('phaseB'),
    itemsScanned:      z.number().int().nonnegative(),
    indexItemsDeleted: z.number().int().nonnegative(),
});

export const phaseCSchema = progressBaseSchema.extend({
    phase:           z.literal('phaseC'),
    countsVerified:  z.number().int().nonnegative(),
    countsCorrected: z.number().int().nonnegative(),
    countsDeleted:   z.number().int().nonnegative(),
});

/** Progress tracking for one concrete reconciliation phase. */
export const reconciliationProgressSchema = z.discriminatedUnion('phase', [
    phaseASchema, phaseBSchema, phaseCSchema,
]);

export type PhaseAProgress = z.infer<typeof phaseASchema>;
export type PhaseBProgress = z.infer<typeof phaseBSchema>;
export type PhaseCProgress = z.infer<typeof phaseCSchema>;
export type ReconciliationProgress = z.infer<typeof reconciliationProgressSchema>;

/**
 * Complete result of a reconciliation run
 */
export const reconciliationResultSchema = z.object({
    /** Whether the reconciliation completed successfully */
    success:         z.boolean(),
    /** Progress for Phase A (scan memory items) */
    phaseA:          phaseASchema,
    /** Progress for Phase B (scan tag index) */
    phaseB:          phaseBSchema,
    /** Progress for Phase C (verify META_COUNT items) */
    phaseC:          phaseCSchema,
    /** Total duration of all phases in milliseconds */
    totalDurationMs: z.number().int().nonnegative(),
});

export type ReconciliationResult = z.infer<typeof reconciliationResultSchema>;

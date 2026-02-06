/**
 * Tag Index Reconciliation Public Exports
 *
 * Public API for tag index reconciliation subsystem.
 * Exports types, schemas, errors, reconciler, and scheduler.
 */

// Type exports
export type {
    ReconciliationConfig,
    ReconciliationBackoff,
    ReconciliationTestMode,
    ReconciliationPhase,
    ReconciliationState,
    ReconciliationProgress,
    ReconciliationResult
} from './types';

// Schema exports
export {
    reconciliationConfigSchema,
    reconciliationBackoffSchema,
    reconciliationTestModeSchema,
    reconciliationPhaseSchema,
    reconciliationStateSchema,
    reconciliationProgressSchema,
    reconciliationResultSchema
} from './types';

// Error exports
export {
    ReconciliationError,
    ReconciliationThrottledError
} from './errors';

// Reconciler exports
export {
    runReconciliation,
    type ReconcilerDeps,
    type ReconcilerOptions
} from './reconciler';

// Scheduler exports
export {
    createReconciliationScheduler,
    type ReconciliationSchedulerDeps,
    type ReconciliationScheduler
} from './scheduler';

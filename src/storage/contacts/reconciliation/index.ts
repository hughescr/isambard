/**
 * Contact Reconciliation
 *
 * Two-phase reconciliation to ensure contact lookup data is consistent with profiles.
 *
 * @module
 */

export type {
    ContactReconcilerDeps,
    ContactReconcilerOptions,
    ContactReconciliationPhase,
    PhaseAProgress,
    PhaseBProgress,
    ContactReconciliationResult
} from './reconciler';

export { runContactReconciliation } from './reconciler';

export type {
    ContactReconciliationConfig,
    ContactReconciliationSchedulerDeps,
    ContactReconciliationSchedulerState,
    ContactReconciliationScheduler
} from './scheduler';

export { createContactReconciliationScheduler } from './scheduler';

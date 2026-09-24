export type {
    ServiceName,
    ServiceErrorCategory,
    ServiceHealthEntry,
    ServiceHealthChange,
    HealthChangeListener
} from './types';

export type { ServiceHealthRegistry } from './health-registry';
export { ServiceHealthRegistryImpl } from './health-registry';

export type { ReconnectionLoop } from './reconnection-loop';
export { createReconnectionLoop } from './reconnection-loop';

// Outbox
export type { OutboxItem, OutboxItemType, OutboxPriority, OutboxService, OutboxDiscardReason } from './outbox';
export { serializedDiscordPayloadSchema, outboxServiceSchema, OutboxBackend } from './outbox';
export type { OutboxDrainer, DrainResult, OutboxFailure, OutboxFailureClassification, OutboxFailureClassifier } from './outbox';
export { createOutboxDrainer, createOutboxDrainListener, OutboxVerificationPendingError, OUTBOX_FAILURE_FALLBACK } from './outbox';

// Approved outbound actions
export type {
    ApprovalCardRef,
    ApprovedActionOutcomeDelivery,
    ApprovedActionOutcomeReport,
    ApprovedActionOutcomeReporter,
    ApprovedActionOutcomeTone,
    ApprovedOutboundAction,
    ApprovedOutboundActionState,
    ApprovedOutboundActionType,
    ApprovedOutboundActionWriter,
    ApprovedOutboundActionExecutor,
    DeliveryCheck,
    DeliveryCheckInput,
    DeliveryVerifier,
    FailureKind
} from './approved-outbound-action';
export {
    ApprovedOutboundActionBackend,
    createApprovedActionOutcomeReporter,
    createApprovedOutboundActionExecutor,
    createApprovedActionRetryListener,
    createWakingActionWriter,
    describeApprovedActionOutcome,
    raceDeadline
} from './approved-outbound-action';

// Allowlist saga
export type { SagaStepResult, SagaInteractionResult } from './allowlist-saga';
export { AllowlistSagaBackend, AllowlistSagaExecutor } from './allowlist-saga';

// Rate limiters
export { TokenBucketRateLimiter } from './rate-limiters';

// Error boundaries
export type { ErrorBoundaryLogger, ErrorBoundaryRegistration } from './error-boundary';
export { registerErrorBoundaries } from './error-boundary';

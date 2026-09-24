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
export type { OutboxItem, OutboxItemType, OutboxPriority } from './outbox';
export { serializedDiscordPayloadSchema, OutboxBackend } from './outbox';
export type { OutboxDrainer } from './outbox';
export { createOutboxDrainer } from './outbox';

// Approved outbound actions
export type {
    ApprovedOutboundAction,
    ApprovedOutboundActionState,
    ApprovedOutboundActionType,
    ApprovedOutboundActionWriter,
    ApprovedOutboundActionExecutor,
    FailureKind
} from './approved-outbound-action';
export { ApprovedOutboundActionBackend, createApprovedOutboundActionExecutor, createApprovedActionRetryListener } from './approved-outbound-action';

// Allowlist saga
export type { SagaStepResult, SagaInteractionResult } from './allowlist-saga';
export { AllowlistSagaBackend, AllowlistSagaExecutor } from './allowlist-saga';

// Rate limiters
export { TokenBucketRateLimiter } from './rate-limiters';

// Error boundaries
export type { ErrorBoundaryLogger, ErrorBoundaryRegistration } from './error-boundary';
export { registerErrorBoundaries } from './error-boundary';

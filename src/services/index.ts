export type {
    ServiceName,
    HealthState,
    ServiceErrorCategory,
    ServiceHealthEntry,
    ServiceHealthChange,
    HealthChangeListener
} from './types';

export { serviceNameSchema, healthStateSchema, serviceErrorCategorySchema } from './types';

export { serviceLifecycleMachine, createServiceActor } from './lifecycle-orchestrator';

export type { ServiceHealthRegistry } from './health-registry';
export { ServiceHealthRegistryImpl } from './health-registry';

export type { ReconnectionLoop, ReconnectionLoopOptions } from './reconnection-loop';
export { createReconnectionLoop } from './reconnection-loop';

// Outbox
export type { OutboxItem, OutboxItemType, OutboxPriority } from './outbox';
export { OutboxBackend } from './outbox';
export type { OutboxDrainer, DrainResult } from './outbox';
export { createOutboxDrainer } from './outbox';

// Approval saga
export type { ApprovalSaga, ApprovalSagaState, ApprovalSagaType, SagaExecutor } from './approval-saga';
export { ApprovalSagaBackend, createSagaExecutor } from './approval-saga';

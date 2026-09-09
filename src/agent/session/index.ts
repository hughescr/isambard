/**
 * Long-lived session core barrel.
 *
 * @module agent/session
 */

export type {
    SessionRole,
    TimerHandle,
    Clock,
    ContextUsageSummary,
    SessionQuery,
    SessionQueryFn,
    EnvelopeKind,
    Envelope,
    EnvelopeMeta,
    TurnKind,
    JournalEntry
} from './types';

export { ENVELOPE_KINDS } from './types';

export { systemClock } from './clock';

export { type ActivityPhase, activityPhaseSchema, isActivityPhase, phaseFromFrame } from './activity-phase';

export {
    type Ledger,
    type LedgerEvent,
    type LedgerStore,
    type LedgerStoreDeps,
    initialLedger,
    reduceLedger,
    createLedgerStore
} from './ledger';

export {
    buildSessionQueryOptions,
    buildMcpServers,
    buildAllowedTools,
    EXPLICIT_TOOLS,
    EXPLICIT_AGENTS,
    type SessionMcpServers,
    type SessionMcpServerName,
    type BuildSessionQueryOptionsParams
} from './query-options';

export { InputQueue } from './input-queue';

export { createInterruptFlag, type InterruptFlag } from './interrupt-flag';

export {
    openSession,
    type SessionHandle,
    type SessionState,
    type OpenSessionParams
} from './session';

export {
    buildDiscordEnvelope,
    buildPerchEnvelope,
    buildNotificationEnvelope,
    buildCatchupEnvelope,
    buildWrapUpEnvelope,
    buildResumeEnvelope,
    buildBootEnvelope,
    buildCompactEnvelope,
    toSdkUserMessage,
    type BuildDiscordEnvelopeParams,
    type BuildPerchEnvelopeParams,
    type BuildNotificationEnvelopeParams,
    type BuildCatchupEnvelopeParams,
    type BuildWrapUpEnvelopeParams
} from './envelope';

export { buildCatchupText, type CatchupSummary } from './catchup-text';

export type { SessionJournal, ResumeStore } from './ports';

export type { DiscordEnvelopeInput } from './discord-envelope-input';

export { createSessionJournal, type CreateSessionJournalParams } from './journal';

export { createResumeStore, type RoleResumeStore } from './resume-store';

export {
    createCostCeiling,
    type CostCeiling,
    type CostCeilingSnapshot,
    type CostCeilingPersistence,
    type CreateCostCeilingParams
} from './cost-ceiling';

export { createCostCeilingStore, type CreateCostCeilingStoreParams } from './cost-ceiling-store';

export { computeRecovery, lastKnownAt, taskLaunchEntries, type LostTask, type UndeliveredEnvelope, type RecoveryResult } from './recovery';

export {
    createTaskLaunchRegistry,
    launchIdFromToolResponse,
    parseTaskNotification,
    DEFAULT_TASK_LAUNCH_CAPACITY,
    type TaskLaunch,
    type TaskLaunchRegistry,
    type CreateTaskLaunchRegistryParams
} from './task-launch-registry';

export { createDeliveryGuard, type DeliveryGuard } from './delivery-guard';

export { resultFrameToError } from './result-frame-error';

export {
    createCompactionGuard,
    type CompactionGuard,
    type CompactionFailureReason,
    type CreateCompactionGuardParams
} from './compaction-guard';

export {
    createCompactionTelemetry,
    type CompactionTelemetry,
    type CompactionTelemetryRecord,
    type CreateCompactionTelemetryParams
} from './compaction-telemetry';

export {
    createContextPolicy,
    type ContextPolicy,
    type CreateContextPolicyParams,
    type EventsDeltaSource,
    type StateTopSetSource,
    type StateTopSetDelta,
    type CalendarAgendaSource,
    type CalendarDelta,
    DEFAULT_CALENDAR_POLL_INTERVAL_MS
} from './context-policy';

export {
    computeTunedThreshold,
    createCompactionThresholdTuner,
    DEFAULT_STEP_PERCENT,
    INTERVAL_HISTORY_WINDOW,
    type CompactionThresholdBand,
    type CreateCompactionThresholdTunerParams
} from './compaction-tuner';

export {
    createConductor,
    type Conductor,
    type ConductorStatus,
    type CreateConductorParams,
    type TurnResult,
    type SubmitPriority,
    type SubmitOptions,
    type InterruptCurrentOptions,
    type ShutdownOptions
} from './conductor';

export {
    createBootBundleBuilder,
    formatBootBundle,
    type BootKind,
    type BootBundleBuilder,
    type BootBundleParts,
    type BuildBootBundleInput,
    type CreateBootBundleBuilderParams
} from './boot-bundle';

export {
    runBootSequence,
    type BootIngressGate,
    type BootJournal,
    type BootRecovery,
    type RunBootSequenceParams,
    type RunBootSequenceResult
} from './boot-sequence';

export {
    createShutdown,
    type CreateShutdownParams,
    type Shutdown,
    type ShutdownJournal,
    type ShutdownResult,
    type ShutdownSession
} from './shutdown';

export {
    createNotificationBridge,
    DEFAULT_NOTIFICATION_DEDUPE_CAPACITY,
    type NotificationBridge,
    type NotificationConductor,
    type NotifyFn,
    type NotifyParams,
    type CreateNotificationBridgeParams
} from './notification-bridge';

export {
    agendaKey,
    agendaFingerprint,
    diffAgenda,
    dayWindow,
    toAgenda,
    type AgendaEntry
} from './calendar-delta';

export {
    shouldNotifyHealthChange,
    createHealthOutageCoalescer,
    createHealthNotificationListener,
    DEFAULT_HEALTH_OUTAGE_WINDOW_MS,
    DEFAULT_HEALTH_ALREADY_REPORTED_CAPACITY,
    type HealthOutageCoalescer,
    type CreateHealthOutageCoalescerParams,
    type CreateHealthNotificationListenerParams
} from './health-notification';

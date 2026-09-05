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

export { createSessionJournal, type CreateSessionJournalParams } from './journal';

export {
    logCompactionSummary,
    type LogCompactionSummaryDeps,
    type LogCompactionSummaryInput
} from './compaction-log';

export { createResumeStore, type RoleResumeStore } from './resume-store';

export { computeRecovery, type LostTask, type UndeliveredEnvelope, type RecoveryResult } from './recovery';

export { createDeliveryGuard, type DeliveryGuard } from './delivery-guard';

export { resultFrameToError } from './result-frame-error';

export {
    createCompactionGuard,
    type CompactionGuard,
    type CompactionFailureReason,
    type CreateCompactionGuardParams
} from './compaction-guard';

export { createContextPolicy, type ContextPolicy, type CreateContextPolicyParams, type EventsDeltaSource } from './context-policy';

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
    type BootBundleBuilder,
    type BootBundleParts,
    type BuildBootBundleInput,
    type CreateBootBundleBuilderParams
} from './boot-bundle';

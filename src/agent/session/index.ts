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

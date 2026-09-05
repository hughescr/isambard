/**
 * Pure crash-recovery computation over a journal read (P8). `computeRecovery` takes the entries
 * returned by {@link import('./ports').SessionJournal.readSince} and derives, with no I/O of its
 * own: which background tasks never reached a terminal state (lost), which discord/catchup
 * turns finished but were never confirmed delivered (undelivered, carrying the response text so
 * the conductor can send it exactly once on restart), the full set of envelope ids already
 * confirmed delivered (to seed the P8 delivery guard), and the most recently opened session id
 * plus whether that open was a fallback (resume refused, fresh session created).
 *
 * @module agent/session/recovery
 */
import type { EnvelopeKind, JournalEntry } from './types';

/** A background task with a `task_started` entry but no later `task_completed`/`task_lost`. */
export interface LostTask {
    taskId:       string
    description?: string
}

/**
 * A discord/catchup envelope whose turn finished (`turn_completed`) but was never confirmed
 * delivered. `channelId` comes from the envelope's own `envelope_submitted` entry (present when
 * the envelope carried one), so a redelivery attempt knows where to send the reply.
 */
export interface UndeliveredEnvelope {
    envelopeId:    string
    envelopeKind:  EnvelopeKind
    channelId?:    string
    responseText?: string
}

/** The full recovery computation over a window of journal entries. */
export interface RecoveryResult {
    lostTasks:            LostTask[]
    undelivered:          UndeliveredEnvelope[]
    /** Every `response_delivered.envelopeId` seen, deduped, in first-seen order. */
    deliveredEnvelopeIds: string[]
    /** The `sessionId` of the latest `session_opened` entry, or `undefined` when none was seen. */
    lastSessionId?:       string
    /** The `fallback` flag of the latest `session_opened` entry (`false` when absent or none was seen). */
    lastOpenWasFallback:  boolean
}

/** Envelope kinds whose finished-but-unconfirmed turns are worth replaying to a human. Every other kind (perch, notification, wrapup, resume, compact, boot) never counts as undelivered. */
const REPLAYABLE_ENVELOPE_KINDS: ReadonlySet<EnvelopeKind> = new Set<EnvelopeKind>(['discord', 'catchup']);

/** Running tallies {@link computeRecovery} folds one journal entry at a time into, via {@link applyTaskEntry}/{@link applyEnvelopeEntry}/{@link applySessionEntry}. */
interface RecoveryAccumulator {
    taskDescriptions:      Map<string, string | undefined>
    resolvedTaskIds:       Set<string>
    submittedEnvelopes:    Map<string, EnvelopeKind>
    submittedChannelIds:   Map<string, string | undefined>
    completedResponseText: Map<string, string | undefined>
    deliveredIds:          Set<string>
    lastSessionOpened:     Extract<JournalEntry, { type: 'session_opened' }> | undefined
}

/** Folds a task-lifecycle entry (`task_started`/`task_completed`/`task_lost`) into `acc`; every other entry type is a no-op here. */
function applyTaskEntry(acc: RecoveryAccumulator, entry: JournalEntry): void {
    if(entry.type === 'task_started') {
        acc.taskDescriptions.set(entry.taskId, entry.description);
    } else if(entry.type === 'task_completed' || entry.type === 'task_lost') {
        acc.resolvedTaskIds.add(entry.taskId);
    }
}

/** Folds an envelope-lifecycle entry (`envelope_submitted`/`turn_completed`/`response_delivered`) into `acc`; every other entry type is a no-op here. */
function applyEnvelopeEntry(acc: RecoveryAccumulator, entry: JournalEntry): void {
    if(entry.type === 'envelope_submitted') {
        acc.submittedEnvelopes.set(entry.envelopeId, entry.kind);
        acc.submittedChannelIds.set(entry.envelopeId, entry.channelId);
        return;
    }
    if(entry.type === 'turn_completed') {
        acc.completedResponseText.set(entry.envelopeId, entry.responseText);
        return;
    }
    if(entry.type === 'response_delivered') {
        acc.deliveredIds.add(entry.envelopeId);
    }
}

/** Tracks the latest `session_opened` entry seen; every other entry type is a no-op here. */
function applySessionEntry(acc: RecoveryAccumulator, entry: JournalEntry): void {
    if(entry.type === 'session_opened') {
        acc.lastSessionOpened = entry;
    }
}

/**
 * Derives {@link RecoveryResult} from `entries`, which must be in ascending write order (the
 * order {@link import('./ports').SessionJournal.readSince} returns) so the "latest
 * `session_opened`" rule sees the true latest.
 */
export function computeRecovery(entries: readonly JournalEntry[]): RecoveryResult {
    const acc: RecoveryAccumulator = {
        taskDescriptions:      new Map(),
        resolvedTaskIds:       new Set(),
        submittedEnvelopes:    new Map(),
        submittedChannelIds:   new Map(),
        completedResponseText: new Map(),
        deliveredIds:          new Set(),
        lastSessionOpened:     undefined,
    };

    for(const entry of entries) {
        applyTaskEntry(acc, entry);
        applyEnvelopeEntry(acc, entry);
        applySessionEntry(acc, entry);
    }

    const lostTasks: LostTask[] = [...acc.taskDescriptions]
        .filter(([taskId]) => !acc.resolvedTaskIds.has(taskId))
        .map(([taskId, description]) => ({ taskId, description }));

    const undelivered: UndeliveredEnvelope[] = [...acc.submittedEnvelopes]
        .filter(([envelopeId, kind]) => REPLAYABLE_ENVELOPE_KINDS.has(kind) && acc.completedResponseText.has(envelopeId) && !acc.deliveredIds.has(envelopeId))
        .map(([envelopeId, kind]) => ({
            envelopeId,
            envelopeKind: kind,
            channelId:    acc.submittedChannelIds.get(envelopeId),
            responseText: acc.completedResponseText.get(envelopeId),
        }));

    return {
        lostTasks,
        undelivered,
        deliveredEnvelopeIds: [...acc.deliveredIds],
        lastSessionId:        acc.lastSessionOpened?.sessionId,
        lastOpenWasFallback:  acc.lastSessionOpened?.fallback ?? false,
    };
}

/**
 * DynamoDB item shape and validation schema for the write-through session journal
 * (SESSION_JOURNAL#<role> partition — deliberately outside `/events`, see
 * src/agent/session/journal.ts for why).
 *
 * `JournalEntry` and `SessionRole` are owned solely by src/agent/session/types.ts (plan
 * amendment A1 / P8 gap override (a)); this module imports them as types only rather than
 * redeclaring either. The import is type-only (erased at compile time, so it adds no runtime
 * edge from storage to agent) and needs an explicit boundary-lint exception because the
 * architecture keeps storage independent of agent at the value level.
 *
 * @module storage/session-journal/types
 */
import { z } from 'zod';
import { type EpochSeconds } from '../repositories/types';
// eslint-disable-next-line boundaries/dependencies -- type-only import (erased at compile time, no runtime edge): JournalEntry/SessionRole are owned solely by src/agent/session/types.ts (plan amendment A1 / P8 gap override (a)) and storage must not redeclare either
import type { EnvelopeKind, JournalEntry, SessionRole } from '@/agent';

/**
 * Mirrors {@link EnvelopeKind} (src/agent/session/types.ts) as literal values — the type itself
 * stays owned there; this is just the runtime list a zod schema needs. Also accepts the legacy
 * pre-#76 `'resume'` kind (written before the turn-side rename to `continuation`) and normalises
 * it on read — safely deletable once every legacy row has expired by TTL (30 days,
 * src/storage/session-journal/backend.ts:33-41; #76 landed 2026-09-23, so this alias can be
 * removed 2026-10-23).
 */
const envelopeKindSchema = z.enum(['discord', 'perch', 'notification', 'catchup', 'wrapup', 'continuation', 'compact', 'boot', 'task', 'peer', 'resume'])
    .transform((kind): EnvelopeKind => (kind === 'resume' ? 'continuation' : kind));

/** Mirrors {@link SessionRole} (src/agent/session/types.ts) as literal values, for the same reason as {@link envelopeKindSchema}. */
const sessionRoleSchema = z.enum(['conversation', 'perch']);

/** Every {@link JournalEntry} member carries this. Storage coerces the persisted ISO string back to `Date` on read. */
const journalEntryBase = { at: z.coerce.date() };

/** The fields every `session_opened` row carries, in both the current and the legacy shape. */
const sessionOpenedBase = {
    ...journalEntryBase, type: z.literal('session_opened'), role: sessionRoleSchema, sessionId: z.string(),
};

/** Every row shape the current build writes, keyed by `type`. */
const currentJournalEntrySchema = z.discriminatedUnion('type', [
    z.object({
        ...journalEntryBase, type: z.literal('envelope_submitted'), envelopeId: z.string(), kind: envelopeKindSchema, channelId: z.string().optional(),
    }),
    z.object({
        ...journalEntryBase, type: z.literal('response_delivered'), envelopeId: z.string(), channelId: z.string(), messageIds: z.array(z.string()), disposition: z.enum(['sent', 'queued']).optional(),
    }),
    z.object({
        ...journalEntryBase, type: z.literal('turn_completed'), envelopeId: z.string(), kind: envelopeKindSchema, responseText: z.string().optional(), truncated: z.boolean().optional(),
    }),
    z.object({
        ...journalEntryBase, type: z.literal('turn_failed'), envelopeId: z.string(), kind: envelopeKindSchema, error: z.string(),
    }),
    z.object({ ...journalEntryBase, type: z.literal('task_started'), taskId: z.string(), description: z.string() }),
    z.object({
        ...journalEntryBase, type: z.literal('task_finished'), taskId: z.string(), description: z.string().optional(), outcome: z.enum(['completed', 'failed', 'stopped']),
    }),
    z.object({ ...journalEntryBase, type: z.literal('task_lost'), taskId: z.string(), description: z.string().optional() }),
    z.object({
        ...journalEntryBase, type: z.literal('task_launched'), taskId: z.string(), toolUseId: z.string(), toolName: z.string(), envelopeId: z.string(), kind: envelopeKindSchema, channelId: z.string().optional(), authorId: z.string().optional(), description: z.string().optional(),
    }),
    z.object({ ...journalEntryBase, type: z.literal('compaction_started'), trigger: z.enum(['manual', 'auto']).optional() }),
    z.object({ ...journalEntryBase, type: z.literal('compaction_completed') }),
    z.object({ ...journalEntryBase, type: z.literal('compaction_failed'), error: z.string() }),
    z.object({
        ...sessionOpenedBase, outcome: z.enum(['fresh', 'resumed', 'resume_fallback']), cause: z.enum(['boot', 'crash_reopen', 'requested_reopen']),
    }),
    z.object({
        ...journalEntryBase, type: z.literal('session_reopen_requested'), role: sessionRoleSchema, reason: z.string(),
    }),
    z.object({ ...journalEntryBase, type: z.literal('session_ended'), sessionId: z.string() }),
    z.object({ ...journalEntryBase, type: z.literal('shutdown') }),
    z.object({
        ...journalEntryBase, type: z.literal('cost_ceiling_snapshot'), dateKey: z.string(), totalUsd: z.number(), paused: z.boolean(),
    }),
]);

// Legacy pre-#61 journal rows: can be safely deleted after 2026-09-25. Every journal reader looks
// back at most 48 hours (`readSince`) and no build from #61 on writes either shape, so once the
// rows written before that deploy have aged out of every read window, delete this whole block
// (both schemas and `legacySessionOpenOutcome`) and make `journalEntrySchema` the bare
// `currentJournalEntrySchema`. The same date marks the matching agent-side pieces: the
// `task_completed` JournalEntry member, recovery.ts's `isLegacyTaskCompleted`, and the optional
// `cause` on `session_opened` (src/agent/session/types.ts), which becomes required.
/**
 * Legacy `session_opened` row: `{ resumed, fallback? }` instead of `outcome`, and no `cause`.
 * Normalised on read to the current shape, `cause` absent: `fallback` → `'resume_fallback'`, else
 * `resumed` → `'resumed'`, else `'fresh'`. The `{ resumed: true, fallback: true }` pair, which no
 * writer ever produced, is accepted and normalised deterministically — `fallback` wins, so it
 * reads as `'resume_fallback'`.
 */
const legacySessionOpenedSchema = z.object({ ...sessionOpenedBase, resumed: z.boolean(), fallback: z.boolean().optional() })
    .transform(({ resumed, fallback, ...rest }) => ({ ...rest, outcome: legacySessionOpenOutcome(resumed, fallback) }));

/** Legacy `task_completed` row: written for every terminal task whatever its status, so it carries no outcome. Read-only. */
const legacyTaskCompletedSchema = z.object({
    ...journalEntryBase, type: z.literal('task_completed'), taskId: z.string(), description: z.string().optional(),
});

/** {@link legacySessionOpenedSchema}'s `{ resumed, fallback? }` → `outcome` rule. */
function legacySessionOpenOutcome(resumed: boolean, fallback: boolean | undefined): 'fresh' | 'resumed' | 'resume_fallback' {
    if(fallback === true) {
        return 'resume_fallback';
    }
    return resumed ? 'resumed' : 'fresh';
}

/**
 * Validates one journal row's entry fields (everything except the DynamoDB key/TTL wrapper).
 * `satisfies z.ZodType<JournalEntry>` is the compile-time guarantee that this schema's output
 * cannot drift from the agent-owned `JournalEntry` union without a type error here.
 *
 * Tolerates legacy pre-#61 journal rows (can be safely deleted after 2026-09-25): a row the
 * current shapes reject is tried against the legacy `session_opened` shape (normalised to
 * `outcome` on read, `cause` absent) and the legacy `task_completed` shape. The legacy options
 * sit outside the `type`-keyed discriminated union because zod forbids two options sharing one
 * discriminator value.
 */
export const journalEntrySchema = z.union([currentJournalEntrySchema, legacySessionOpenedSchema, legacyTaskCompletedSchema]) satisfies z.ZodType<JournalEntry>;

/**
 * DynamoDB item shape for one journal row. `PK` groups every row for a role; `SK` orders rows
 * within that role by write time, with `seq` (zero-padded to 6 digits) disambiguating rows
 * written in the same millisecond. Carries no `GSI1PK`/`GSI1SK` — these rows are deliberately
 * invisible to the `LAYER#events` GSI (P8 deviation (1), docs/plans/long-lived-session-phase1.md).
 */
export interface SessionJournalItem extends Record<string, unknown> {
    PK:   string        // SESSION_JOURNAL#<role>
    SK:   string        // <ts ISO>#<seq padded 6>
    TTL:  EpochSeconds
    type: JournalEntry['type']
    at:   string   // ISO 8601 — the wire form of JournalEntry['at']
}

// eslint-disable-next-line unicorn/prefer-export-from -- an `export ... from '@/agent'` here would be a second boundary-crossing import statement needing its own disable; re-exporting the already-imported local bindings keeps the single disable above as the only crossing
export type { JournalEntry, SessionRole };

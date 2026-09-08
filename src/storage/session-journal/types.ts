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
// eslint-disable-next-line boundaries/dependencies -- type-only import (erased at compile time, no runtime edge): JournalEntry/SessionRole are owned solely by src/agent/session/types.ts (plan amendment A1 / P8 gap override (a)) and storage must not redeclare either
import type { JournalEntry, SessionRole } from '@/agent';

/** Mirrors {@link EnvelopeKind} (src/agent/session/types.ts) as literal values — the type itself stays owned there; this is just the runtime list a zod schema needs. */
const envelopeKindSchema = z.enum(['discord', 'perch', 'notification', 'catchup', 'wrapup', 'resume', 'compact', 'boot']);

/** Mirrors {@link SessionRole} (src/agent/session/types.ts) as literal values, for the same reason as {@link envelopeKindSchema}. */
const sessionRoleSchema = z.enum(['conversation', 'perch']);

/** Every {@link JournalEntry} member carries this. Storage coerces the persisted ISO string back to `Date` on read. */
const journalEntryBase = { at: z.coerce.date() };

/**
 * Validates one journal row's entry fields (everything except the DynamoDB key/TTL wrapper).
 * `satisfies z.ZodType<JournalEntry>` is the compile-time guarantee that this schema's output
 * cannot drift from the agent-owned `JournalEntry` union without a type error here.
 */
export const journalEntrySchema = z.discriminatedUnion('type', [
    z.object({
        ...journalEntryBase, type: z.literal('envelope_submitted'), envelopeId: z.string(), kind: envelopeKindSchema, channelId: z.string().optional(),
    }),
    z.object({
        ...journalEntryBase, type: z.literal('response_delivered'), envelopeId: z.string(), channelId: z.string(), messageIds: z.array(z.string()),
    }),
    z.object({
        ...journalEntryBase, type: z.literal('turn_completed'), envelopeId: z.string(), kind: envelopeKindSchema, responseText: z.string().optional(), truncated: z.boolean().optional(),
    }),
    z.object({
        ...journalEntryBase, type: z.literal('turn_failed'), envelopeId: z.string(), kind: envelopeKindSchema, error: z.string(),
    }),
    z.object({ ...journalEntryBase, type: z.literal('task_started'), taskId: z.string(), description: z.string() }),
    z.object({ ...journalEntryBase, type: z.literal('task_completed'), taskId: z.string(), description: z.string().optional() }),
    z.object({ ...journalEntryBase, type: z.literal('task_lost'), taskId: z.string(), description: z.string().optional() }),
    z.object({ ...journalEntryBase, type: z.literal('compaction_started'), trigger: z.enum(['manual', 'auto']).optional() }),
    z.object({ ...journalEntryBase, type: z.literal('compaction_completed') }),
    z.object({ ...journalEntryBase, type: z.literal('compaction_failed'), error: z.string() }),
    z.object({
        ...journalEntryBase, type: z.literal('session_opened'), role: sessionRoleSchema, sessionId: z.string(), resumed: z.boolean(), fallback: z.boolean().optional(),
    }),
    z.object({ ...journalEntryBase, type: z.literal('session_ended'), sessionId: z.string() }),
    z.object({ ...journalEntryBase, type: z.literal('shutdown') }),
    z.object({
        ...journalEntryBase, type: z.literal('cost_ceiling_snapshot'), dateKey: z.string(), totalUsd: z.number(), paused: z.boolean(),
    }),
]) satisfies z.ZodType<JournalEntry>;

/**
 * DynamoDB item shape for one journal row. `PK` groups every row for a role; `SK` orders rows
 * within that role by write time, with `seq` (zero-padded to 6 digits) disambiguating rows
 * written in the same millisecond. Carries no `GSI1PK`/`GSI1SK` — these rows are deliberately
 * invisible to the `LAYER#events` GSI (P8 deviation (1), docs/plans/long-lived-session-phase1.md).
 */
export interface SessionJournalItem extends Record<string, unknown> {
    PK:   string   // SESSION_JOURNAL#<role>
    SK:   string   // <ts ISO>#<seq padded 6>
    TTL:  number   // epoch seconds
    type: JournalEntry['type']
    at:   string   // ISO 8601 — the wire form of JournalEntry['at']
}

// eslint-disable-next-line unicorn/prefer-export-from -- an `export ... from '@/agent'` here would be a second boundary-crossing import statement needing its own disable; re-exporting the already-imported local bindings keeps the single disable above as the only crossing
export type { JournalEntry, SessionRole };

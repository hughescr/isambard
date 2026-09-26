/**
 * Types for the operational-state store: integration replay cursors (Discord per-channel
 * checkpoints, Bluesky feed/notification/DM checkpoints) that must survive restarts but are not
 * memories.
 *
 * Key scheme (same single DynamoDB table as everything else — no new table, GSI or capacity):
 *
 * - `PK = OPERATIONAL_STATE#<owner>` — one partition per owning integration (`discord`, `bsky`).
 * - `SK = <name>` — the key's name, e.g. `channels/<channelId>/checkpoint`,
 *   `feeds/<sanitizedFeed>/checkpoint`, `notifications/checkpoint`, `dm/checkpoint`.
 * - `content` holds the JSON-encoded value (the same wire JSON the legacy memory rows held) and
 *   `updatedAt` the ISO write time.
 *
 * Rows deliberately carry no `GSI1PK`/`GSI1SK`, no tag-index rows and no vector-index embed job,
 * so a replay cursor never reaches state scoring, hot state or semantic search the way the legacy
 * checkpoint memory rows did before #57. A dedicated partition (rather than a flag on memory rows)
 * is what keeps them out of `LAYER#state`.
 *
 * @module storage/operational-state/types
 */

/** The integration that owns a key; selects the `OPERATIONAL_STATE#<owner>` partition. */
export type OperationalStateOwner = 'discord' | 'bsky';

/** Addresses one operational-state value: its owner's partition plus its name (the sort key). */
export interface OperationalStateKey {
    readonly owner: OperationalStateOwner
    readonly name:  string
}

/** Anything with a throwing `parse` — a zod schema in practice. */
export interface OperationalStateSchema<T> {
    parse: (input: unknown) => T
}

/**
 * The outcome of reading one key. Callers that must tell a missing row from a corrupt one switch
 * on `status`; every variant carries `value` (undefined unless `valid`) so a caller that treats
 * both as absent can read `value` directly.
 */
export type OperationalStateRead<T> = OperationalStateAbsent | OperationalStateValid<T> | OperationalStateInvalid;

/** No row exists for the key. */
interface OperationalStateAbsent {
    readonly status: 'absent'
    readonly value?: undefined
}

/** The row decoded and validated. */
interface OperationalStateValid<T> {
    readonly status: 'valid'
    readonly value:  T
}

/** The row exists but its content is not JSON (`json`) or fails the schema (`schema`). */
interface OperationalStateInvalid {
    readonly status: 'invalid'
    readonly value?: undefined
    readonly reason: 'json' | 'schema'
    readonly error:  unknown
}

/**
 * Durable key/value store for operational (non-memory) state. Reads are strongly consistent: a
 * `read` or `listByPrefix` issued after a completed `put` observes that put, which the per-channel
 * read-modify-write in the Discord checkpoint manager depends on.
 */
export interface OperationalStateStore {
    /** Reads and decodes one key. */
    read<T>(key: OperationalStateKey, schema: OperationalStateSchema<T>): Promise<OperationalStateRead<T>>
    /** Idempotent upsert of `value` (JSON-encoded) under `key`. */
    put(key: OperationalStateKey, value: unknown): Promise<void>
    /**
     * Every decodable value in `prefix.owner`'s partition whose name starts with `prefix.name`,
     * in name order. Undecodable rows are skipped (and logged), never thrown.
     */
    listByPrefix<T>(prefix: OperationalStateKey, schema: OperationalStateSchema<T>): Promise<T[]>
}

/** The DynamoDB item shape for one operational-state row. */
export interface OperationalStateItem extends Record<string, unknown> {
    PK:        string
    SK:        string
    content:   string
    updatedAt: string
}

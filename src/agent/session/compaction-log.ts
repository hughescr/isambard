/**
 * Logs a compaction's PostCompact summary to the agent's own memory (design 3.3: Izzy should be
 * able to find its own compaction history), at `/events/compaction/<ts>` — the one memory-layer
 * write P8 makes; every other journal fact goes to the write-through SESSION_JOURNAL#<role>
 * partition instead (src/storage/session-journal/**), deliberately outside `/events` so it never
 * enters the `LAYER#events` GSI, the embedder queue or the tag index.
 *
 * @module agent/session/compaction-log
 */
import type { Clock, SessionRole } from './types';
import { createContentType, createMemoryPath, type MemoryToolBackend } from '@/storage';

const COMPACTION_TTL_DAYS = 30;

/** Dependencies for {@link logCompactionSummary}. */
export interface LogCompactionSummaryDeps {
    memoryBackend: Pick<MemoryToolBackend, 'create'>
    clock:         Clock
}

/** The compaction summary to log. */
export interface LogCompactionSummaryInput {
    role:    SessionRole
    summary: string
}

/**
 * Writes one tagged memory row for a just-finished compaction.
 * @returns The memory path the summary was written to (for the caller's `compaction_completed` journal entry).
 */
export async function logCompactionSummary(deps: LogCompactionSummaryDeps, input: LogCompactionSummaryInput): Promise<string> {
    const { memoryBackend, clock } = deps;
    const { role, summary } = input;
    const timestamp = new Date(clock.now()).toISOString().replaceAll(/[:.]/g, '-');
    const path = createMemoryPath(`/events/compaction/${timestamp}`);
    const ttl = Math.floor(clock.now() / 1000) + COMPACTION_TTL_DAYS * 86_400;

    const item = await memoryBackend.create({
        path,
        content:     summary,
        contentType: createContentType('text/plain'),
        tags:        new Set(['auto-logged', 'compaction', role]),
        ttl,
    });
    return item.path;
}

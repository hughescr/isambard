/**
 * Session Cleanup Utility
 *
 * Extracts session IDs from SDK stream events and sweeps stale conductor-mode session files.
 *
 * @warning UNDOCUMENTED SDK INTERNALS
 *
 * This module relies on undocumented Claude Agent SDK implementation details:
 * - File paths: `~/.claude/projects/` and `~/.claude/session-env/`
 * - File format: `.jsonl` session transcripts with JSON lines
 * - Directory structure (SDK 0.3.258, verified on disk): a top-level `{session-id}.jsonl`
 *   transcript file AND a per-session `{session-id}/` directory (holding
 *   `subagents/agent-*.jsonl`, `agent-*.meta.json`, `tool-results/`) live side by side under
 *   `{project-path}/`, where project-path is the current working directory with slashes
 *   replaced by dashes. {@link pruneStaleSessions} (the conductor-mode retention sweep, P8)
 *   ages out whole `{session-id}.jsonl`/`{session-id}/` pairs by `mtime`.
 *
 * These paths and formats are NOT part of the SDK's public API and may change
 * without notice in future SDK versions.
 *
 * `pruneStaleSessions` tested against: @anthropic-ai/claude-agent-sdk v0.3.258.
 *
 * If cleanup starts failing silently after an SDK upgrade, check if the SDK's
 * session file storage mechanism has changed.
 */

import { rm, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { logger } from '@hughescr/logger';
import type { SystemEvent } from './types';

/**
 * Project path for session files.
 * The Claude SDK uses the current working directory path (with slashes replaced by dashes)
 * as part of the session storage path.
 */
const getProjectPath = (): string => {
    const cwd = process.cwd();
    // SDK converts path to dash-separated format: /Users/foo/bar -> -Users-foo-bar
    return cwd.replaceAll('/', '-');
};

/**
 * Constructs the full file path for a session file.
 *
 * @param sessionId - The UUID of the session
 * @returns Full path to the session .jsonl file
 */
export const getSessionFilePath = (sessionId: string): string => {
    const projectPath = getProjectPath();
    return path.join(homedir(), '.claude', 'projects', projectPath, `${sessionId}.jsonl`);
};

/**
 * Extracts session ID from a system init event.
 *
 * The Claude SDK emits a system event with subtype 'init' at the start of each query,
 * which contains the session_id field.
 *
 * @param event - Stream event from the SDK (unknown type for flexibility)
 * @returns Session ID if found, undefined otherwise
 */
export const extractSessionId = (event: unknown): string | undefined => {
    if(!(typeof event === 'object' && event !== null)) {
        return undefined;
    }

    const typedEvent = event as Partial<SystemEvent>;

    if(typedEvent.type !== 'system' || typedEvent.subtype !== 'init') {
        return undefined;
    }

    return typedEvent.session_id;
};

const JSONL_EXTENSION = '.jsonl';

/** Strips a trailing `.jsonl` to recover the session id a projects-dir entry belongs to; a bare per-session directory entry (no matching transcript) is already just the id. */
const deriveTranscriptId = (entry: string): string => (entry.endsWith(JSONL_EXTENSION) ? entry.slice(0, -JSONL_EXTENSION.length) : entry);

/** A session-env entry is already keyed by id, with no extension to strip. */
const deriveEnvId = (entry: string): string => entry;

/**
 * Stats one `dir`-relative entry and removes it (recursively) when it is older than
 * `maxAgeMs`. Never throws: a stat or removal failure is logged and swallowed so one bad
 * entry cannot abort the sweep of its siblings (called from {@link pruneStaleDir} under
 * `Promise.allSettled`, which would swallow a throw anyway, but logging here keeps the
 * failure visible).
 */
const pruneAgedEntry = async (dir: string, entry: string, maxAgeMs: number, now: number): Promise<void> => {
    const entryPath = path.join(dir, entry);

    let stats: { mtimeMs: number };
    try {
        stats = await stat(entryPath);
    } catch (error) {
        logger.warn({
            entryPath,
            error,
            // Stryker disable next-line StringLiteral: Log message for observability only
            msg: `pruneStaleSessions: failed to stat entry: ${entry}`,
        });
        return;
    }

    if(stats.mtimeMs >= now - maxAgeMs) {
        return;
    }

    try {
        await rm(entryPath, { recursive: true, force: true });
    } catch (error) {
        logger.warn({
            entryPath,
            error,
            // Stryker disable next-line StringLiteral: Log message for observability only
            msg: `pruneStaleSessions: failed to remove entry: ${entry}`,
        });
    }
};

/**
 * Lists `dir` and prunes every entry not in `keepSessionIds` (by `deriveId`) that is older
 * than `maxAgeMs`. ENOENT on `dir` itself (not yet created) is silent; any other listing
 * failure is logged. Per-entry work runs concurrently via `Promise.allSettled` so one failing
 * entry never blocks its siblings.
 */
const pruneStaleDir = async (dir: string, deriveId: (entry: string) => string, keepSessionIds: Set<string>, maxAgeMs: number, now: number): Promise<void> => {
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch (error) {
        // Stryker disable next-line ConditionalExpression,StringLiteral,EqualityOperator,BlockStatement: ENOENT check and logging
        if((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        logger.warn({
            dir,
            error,
            // Stryker disable next-line StringLiteral: Log message for observability only
            msg: 'pruneStaleSessions: failed to list directory',
        });
        return;
    }

    await Promise.allSettled(
        entries
            .filter(entry => !keepSessionIds.has(deriveId(entry)))
            .map(entry => pruneAgedEntry(dir, entry, maxAgeMs, now))
    );
};

/** Parameters for {@link pruneStaleSessions}. */
export interface PruneStaleSessionsParams {
    /** Session ids that must survive regardless of age — the two role-keyed conductor sessions currently in use. */
    keepSessionIds: Set<string>
    /** Entries older than this (by `mtime`) are removed. */
    maxAgeMs:       number
    /** Injected for deterministic tests; defaults to the real clock. */
    now?:           number
}

/**
 * Age-based retention sweep for the conductor path (P8): entries younger than `maxAgeMs`, or
 * whose derived session id is in `keepSessionIds`, survive; everything else is removed. Applies
 * the same rule to the SDK 0.3.258 per-session projects-dir entries (`{id}.jsonl` files AND
 * `{id}/` directories, pruned independently — a kept id's `.jsonl` and directory both survive
 * because both derive the same id) and to `~/.claude/session-env/{id}`. Never throws.
 */
export const pruneStaleSessions = async (params: PruneStaleSessionsParams): Promise<void> => {
    const { keepSessionIds, maxAgeMs, now = Date.now() } = params;
    const projectPath = getProjectPath();
    const projectsDir = path.join(homedir(), '.claude', 'projects', projectPath);
    const sessionEnvDir = path.join(homedir(), '.claude', 'session-env');

    await Promise.all([
        pruneStaleDir(projectsDir, deriveTranscriptId, keepSessionIds, maxAgeMs, now),
        pruneStaleDir(sessionEnvDir, deriveEnvId, keepSessionIds, maxAgeMs, now),
    ]);
};

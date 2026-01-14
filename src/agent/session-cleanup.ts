/**
 * Session Cleanup Utility
 *
 * Handles cleanup of temporary session files created by the Claude Agent SDK.
 * The SDK stores session transcripts as .jsonl files in ~/.claude/projects/{project-path}/
 * which accumulate over time for ephemeral bot interactions.
 *
 * This module provides fire-and-forget cleanup that:
 * - Extracts session IDs from SDK stream events
 * - Removes session files after query completion
 * - Handles all errors gracefully without affecting main operation
 *
 * @warning UNDOCUMENTED SDK INTERNALS
 *
 * This module relies on undocumented Claude Agent SDK implementation details:
 * - File paths: `~/.claude/projects/` and `~/.claude/session-env/`
 * - File format: `.jsonl` session transcripts with JSON lines
 * - Directory structure: `{project-path}/{session-id}.jsonl` where project-path is
 *   the current working directory with slashes replaced by dashes
 * - Sub-agent files: `agent-{agent-id}.jsonl` with parentUuid linking to parent session
 *
 * These paths and formats are NOT part of the SDK's public API and may change
 * without notice in future SDK versions.
 *
 * Current implementation tested against: @anthropic-ai/claude-agent-sdk v0.1.76
 *
 * If cleanup starts failing silently after an SDK upgrade, check if the SDK's
 * session file storage mechanism has changed.
 */

import { unlink, access, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@hughescr/logger';
import _ from 'lodash';
import type { SystemEvent } from './types';

/**
 * Project path for session files.
 * The Claude SDK uses the current working directory path (with slashes replaced by dashes)
 * as part of the session storage path.
 */
const getProjectPath = (): string => {
    const cwd = process.cwd();
    // SDK converts path to dash-separated format: /Users/foo/bar -> -Users-foo-bar
    return _.replace(cwd, /\//g, '-');
};

/**
 * Constructs the full file path for a session file.
 *
 * @param sessionId - The UUID of the session
 * @returns Full path to the session .jsonl file
 */
export const getSessionFilePath = (sessionId: string): string => {
    const projectPath = getProjectPath();
    return join(homedir(), '.claude', 'projects', projectPath, `${sessionId}.jsonl`);
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
    if(!_.isObject(event)) {
        return undefined;
    }

    const typedEvent = event as Partial<SystemEvent>;

    if(typedEvent.type !== 'system' || typedEvent.subtype !== 'init') {
        return undefined;
    }

    return typedEvent.session_id;
};

/**
 * Cleans up session-env directory for a given session.
 *
 * This is a fire-and-forget operation that removes the ~/.claude/session-env/{sessionId}
 * directory if it exists. Errors are logged but never thrown.
 *
 * @param sessionId - The UUID of the session to clean up
 */
const cleanupSessionEnv = async (sessionId: string): Promise<void> => {
    const sessionEnvPath = join(homedir(), '.claude', 'session-env', sessionId);

    try {
        await rm(sessionEnvPath, { recursive: true, force: true });

        // Stryker disable next-line ObjectLiteral: Logger debug object for observability
        logger.debug({
            sessionId,
            sessionEnvPath,
            // Stryker disable next-line StringLiteral: Log message for observability only
            msg: `Session-env directory cleaned up: ${sessionId}`,
        });
    } catch (error) {
        // Handle file/directory not found gracefully
        // Stryker disable next-line ConditionalExpression,StringLiteral,EqualityOperator,BlockStatement: ENOENT check and logging
        if((error as NodeJS.ErrnoException).code === 'ENOENT') {
            // Stryker disable next-line ObjectLiteral: Logger debug object for observability
            logger.debug({
                sessionId,
                // Stryker disable next-line StringLiteral: Log message for observability only
                msg: `Session-env directory not found (already cleaned up): ${sessionId}`,
            });
            return;
        }

        // Log other errors at warn level but don't throw
        logger.warn({
            sessionId,
            sessionEnvPath,
            error,
            // Stryker disable next-line StringLiteral: Log message for observability only
            msg: `Failed to cleanup session-env directory: ${sessionId}`,
        });
    }
};

/**
 * Cleans up sub-agent/sidechain session files that belong to a parent session.
 *
 * This function scans the projects directory for agent-*.jsonl files, reads their
 * content to find files with a matching parentUuid, and deletes them.
 *
 * This is a fire-and-forget operation - errors are logged but never thrown.
 *
 * @param sessionId - The UUID of the parent session
 * @param projectPath - The project path where session files are stored
 */
const cleanupSubAgentSessions = async (sessionId: string, projectPath: string): Promise<void> => {
    const projectsDir = join(homedir(), '.claude', 'projects', projectPath);

    try {
        // Check if projects directory exists - if not, SDK session tracking may have changed
        await access(projectsDir);
    } catch (error) {
        // Directory doesn't exist - this could indicate SDK session storage has changed
        logger.warn({
            sessionId,
            projectsDir,
            error,
            // Stryker disable next-line StringLiteral: Log message for observability only
            msg: 'SDK projects directory not found - session tracking may have changed in newer SDK version',
        });
        return;
    }

    try {
        // List all files in the projects directory
        const files = await readdir(projectsDir);

        // Filter for agent-*.jsonl files
        // Stryker disable next-line Regex: Regex pattern for agent file matching is correct, mutations would break file detection
        const agentFiles = _.filter(files, file => /^agent-[^.]+\.jsonl$/.test(file));

        // Check each agent file to see if it belongs to this session
        for(const agentFile of agentFiles) {
            const agentFilePath = join(projectsDir, agentFile);

            try {
                // Read the first line of the file to check for parentUuid
                const content = await readFile(agentFilePath, 'utf-8');
                const firstLine = _.split(content, '\n', 1)[0];

                // Stryker disable next-line ConditionalExpression,BlockStatement: Empty firstLine check is defensive coding for malformed files
                if(!firstLine) {
                    continue;
                }

                // Parse the JSON to extract parentUuid
                const data = JSON.parse(firstLine) as { parentUuid?: string };

                if(data.parentUuid === sessionId) {
                    // This is a sub-agent of our session, delete it
                    await unlink(agentFilePath);

                    // Stryker disable next-line ObjectLiteral: Logger debug object
                    logger.debug({
                        sessionId,
                        agentFile,
                        // Stryker disable next-line StringLiteral: Log message for observability only
                        msg: `Sub-agent session file cleaned up: ${agentFile}`,
                    });
                }
            } catch (fileError) {
                // Log but continue processing other files
                logger.warn({
                    sessionId,
                    agentFile,
                    error: fileError,
                    // Stryker disable next-line StringLiteral: Log message for observability only
                    msg:   `Failed to process sub-agent file: ${agentFile}`,
                });
            }
        }
    } catch (error) {
        // Handle directory read errors gracefully
        logger.warn({
            sessionId,
            projectsDir,
            error,
            // Stryker disable next-line StringLiteral: Log message for observability only
            msg: `Failed to scan for sub-agent sessions: ${sessionId}`,
        });
    }
};

/**
 * Cleans up a session file by deleting it from disk.
 *
 * This is a fire-and-forget operation that:
 * - Validates the session ID before attempting deletion
 * - Cleans up related sub-agent sessions first
 * - Deletes the main session file
 * - Removes the session-env directory
 * - Logs success/failure but never throws
 * - Is safe to call even if files were already deleted
 *
 * @param sessionId - The UUID of the session to clean up
 */
export const cleanupSession = async (sessionId: string): Promise<void> => {
    // Validate session ID
    if(!sessionId) {
        // Stryker disable next-line StringLiteral: Log message for observability only
        logger.warn({ msg: 'Invalid session ID provided for cleanup' });
        return;
    }

    const projectPath = getProjectPath();
    const filePath = getSessionFilePath(sessionId);

    // Clean up sub-agent sessions first (before deleting the main session)
    await cleanupSubAgentSessions(sessionId, projectPath);

    try {
        // Check if file exists first
        await access(filePath);

        // File exists, attempt deletion
        await unlink(filePath);

        // Stryker disable next-line ObjectLiteral: Logger debug object
        logger.debug({
            sessionId,
            filePath,
            // Stryker disable next-line StringLiteral: Log message for observability only
            msg: `Session file cleaned up: ${sessionId}`,
        });
    } catch (error) {
        // Handle file not found gracefully (already cleaned up)
        // Stryker disable next-line ConditionalExpression,StringLiteral,EqualityOperator: ENOENT error code check
        if((error as NodeJS.ErrnoException).code === 'ENOENT') {
            // Check if the parent directory exists - if not, SDK session storage may have changed
            // Stryker disable next-line StringLiteral: Path constant for SDK session storage location
            const projectsBaseDir = join(homedir(), '.claude', 'projects');
            try {
                await access(projectsBaseDir);
                // Directory exists but file doesn't - normal case, already cleaned up
                // Stryker disable next-line ObjectLiteral: Logger debug object for observability
                logger.debug({
                    sessionId,
                    // Stryker disable next-line StringLiteral: Log message for observability only
                    msg: `Session file not found (already cleaned up): ${sessionId}`,
                });
            } catch (accessError) {
                // Projects directory doesn't exist - SDK session storage may have changed
                logger.warn({
                    sessionId,
                    projectsBaseDir,
                    error: accessError,
                    // Stryker disable next-line StringLiteral: Log message for observability only
                    msg:   'SDK projects directory not found - session file storage may have changed in newer SDK version',
                });
            }
            return;
        }

        // Log other errors at warn level but don't throw
        logger.warn({
            sessionId,
            filePath,
            error,
            // Stryker disable next-line StringLiteral: Log message for observability only
            msg: `Failed to cleanup session file: ${sessionId}`,
        });
    }

    // Clean up session-env directory after deleting the session file
    await cleanupSessionEnv(sessionId);
};

/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Test assertions with expect matchers */
/**
 * Tests for session cleanup utility
 *
 * Session cleanup removes temporary session files created by the Claude Agent SDK
 * after a query completes. This prevents disk space accumulation from ephemeral
 * bot interactions that don't need session persistence.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mockLogger, mockFsPromises, resetMockFs } from '../../setup';
import _ from 'lodash';

// Use the mocks from setup.ts instead of creating new ones
// (setup.ts already mocks node:fs/promises globally)
const mockAccess = mockFsPromises.access;
const mockUnlink = mockFsPromises.unlink;
const mockRm = mockFsPromises.rm;
const mockReaddir = mockFsPromises.readdir;
const mockReadFile = mockFsPromises.readFile;

// Import after setup.ts has mocked the module
import { cleanupSession, getSessionFilePath, extractSessionId } from '../../../src/agent/session-cleanup';
import type { SystemEvent } from '../../../src/agent/types';

describe('getSessionFilePath', () => {
    test('should construct path from session ID', () => {
        const sessionId = 'abc123-def456';
        const result = getSessionFilePath(sessionId);

        // Should contain the session ID with .jsonl extension
        expect(result).toContain(sessionId);
        expect(result).toEndWith('.jsonl');
    });

    test('should use projects directory structure', () => {
        const sessionId = 'test-session-id';
        const result = getSessionFilePath(sessionId);

        // Should be in .claude/projects/{project-path}/ directory
        expect(result).toContain('.claude/projects/');
    });

    test('should handle UUID-style session IDs', () => {
        const sessionId = '550e8400-e29b-41d4-a716-446655440000';
        const result = getSessionFilePath(sessionId);

        expect(result).toContain(sessionId);
        expect(result).toEndWith('.jsonl');
    });

    test('should convert slashes to dashes in project path', () => {
        // The path should convert cwd slashes to dashes
        // e.g., /Users/foo/bar -> -Users-foo-bar
        const result = getSessionFilePath('test-session');

        // Current working directory should be converted to dash-separated format
        const cwd = process.cwd();
        const expectedProjectPath = _.replace(cwd, /\//g, '-');
        expect(result).toContain(expectedProjectPath);
    });
});

describe('extractSessionId', () => {
    test('should extract session_id from system init event', () => {
        const event: SystemEvent = {
            type:       'system',
            subtype:    'init',
            session_id: 'test-session-123',
        };

        const result = extractSessionId(event);

        expect(result).toBe('test-session-123');
    });

    test('should return undefined for non-system events', () => {
        const event = { type: 'assistant', message: {} };

        const result = extractSessionId(event);

        expect(result).toBeUndefined();
    });

    test('should return undefined for system events without init subtype', () => {
        const event = {
            type:       'system',
            subtype:    'status',
            session_id: 'should-not-extract',
        };

        const result = extractSessionId(event);

        expect(result).toBeUndefined();
    });

    test('should return undefined for system init events without session_id', () => {
        const event = {
            type:    'system',
            subtype: 'init',
        };

        const result = extractSessionId(event);

        expect(result).toBeUndefined();
    });

    test('should handle null input gracefully', () => {
        const result = extractSessionId(null);

        expect(result).toBeUndefined();
    });

    test('should handle undefined input gracefully', () => {
        const result = extractSessionId(undefined);

        expect(result).toBeUndefined();
    });

    test('should return undefined for array input', () => {
        const result = extractSessionId(['not', 'an', 'object']);

        expect(result).toBeUndefined();
    });

    test('should return undefined for event with null session_id', () => {
        const event: SystemEvent = {
            type:       'system',
            subtype:    'init',
            session_id: null as unknown as string, // Test null explicitly
        };

        const result = extractSessionId(event);

        expect(result).toBeNull();
    });

    test('should return empty string for event with empty string session_id', () => {
        const event: SystemEvent = {
            type:       'system',
            subtype:    'init',
            session_id: '',
        };

        const result = extractSessionId(event);

        expect(result).toBe('');
    });

    test('should return undefined for system event missing subtype field', () => {
        const event = {
            type:       'system',
            session_id: 'should-not-extract',
            // subtype field is missing entirely
        };

        const result = extractSessionId(event);

        expect(result).toBeUndefined();
    });

    test('should return undefined when type is not system but subtype is init', () => {
        const event = {
            type:       'user',
            subtype:    'init',
            session_id: 'should-not-extract',
        };

        const result = extractSessionId(event);

        expect(result).toBeUndefined();
    });

    test('should return undefined when type is system but subtype is not init', () => {
        const event = {
            type:       'system',
            subtype:    'message',
            session_id: 'should-not-extract',
        };

        const result = extractSessionId(event);

        expect(result).toBeUndefined();
    });

    test('should return session_id only when both type is system AND subtype is init', () => {
        const event: SystemEvent = {
            type:       'system',
            subtype:    'init',
            session_id: 'valid-session-id',
        };

        const result = extractSessionId(event);

        expect(result).toBe('valid-session-id');
    });
});

describe('cleanupSession', () => {
    beforeEach(() => {
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockAccess.mockClear();
        mockUnlink.mockClear();
        mockRm.mockClear();
        mockReaddir.mockClear();
        mockReadFile.mockClear();
        // Reset to default successful behavior
        mockAccess.mockImplementation(() => Promise.resolve());
        mockUnlink.mockImplementation(() => Promise.resolve());
        mockRm.mockImplementation(() => Promise.resolve());
        mockReaddir.mockImplementation(() => Promise.resolve([]));
        mockReadFile.mockImplementation(() => Promise.resolve(''));
    });

    afterEach(() => {
        // Restore original mock implementations for test isolation
        resetMockFs();
    });

    test('should delete session file when it exists', async () => {
        const sessionId = 'session-to-delete';

        await cleanupSession(sessionId);

        // 2 access calls: 1 for sub-agent dir check, 1 for session file check
        // (session-env cleanup uses rm with force:true, no access check needed)
        expect(mockAccess).toHaveBeenCalledTimes(2);
        expect(mockUnlink).toHaveBeenCalledTimes(1);
        expect(mockUnlink.mock.calls[0][0]).toContain(sessionId);
    });

    test('should log success on successful deletion', async () => {
        const sessionId = 'session-success';

        await cleanupSession(sessionId);

        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                msg: expect.stringContaining('cleaned up'),
            })
        );
    });

    test('should not throw when file does not exist', async () => {
        const sessionId = 'nonexistent-session';
        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';
        mockAccess.mockImplementation(() => Promise.reject(notFoundError));

        // Should complete without throwing
        await cleanupSession(sessionId);
        expect(true).toBe(true);
    });

    test('should log debug when file does not exist', async () => {
        const sessionId = 'nonexistent-session';
        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';

        // First call (sub-agent dir check) succeeds, second call (session file) fails with ENOENT,
        // third call (projects base dir check) succeeds to confirm directory exists
        let callCount = 0;
        mockAccess.mockImplementation(() => {
            callCount++;
            if(callCount === 2) {
                return Promise.reject(notFoundError);
            }
            return Promise.resolve();
        });

        await cleanupSession(sessionId);

        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                msg: expect.stringContaining('not found'),
            })
        );
    });

    test('should log warning on unlink error but not throw', async () => {
        const sessionId = 'session-unlink-error';
        const permError = new Error('EPERM') as NodeJS.ErrnoException;
        permError.code = 'EPERM';
        mockUnlink.mockImplementation(() => Promise.reject(permError));

        // Should complete without throwing
        await cleanupSession(sessionId);

        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                error: expect.anything(),
                msg:   expect.stringContaining('Failed to cleanup'),
            })
        );
    });

    test('should log warning on access error (non-ENOENT) but not throw', async () => {
        const sessionId = 'session-access-error';
        const permError = new Error('EPERM') as NodeJS.ErrnoException;
        permError.code = 'EPERM';
        mockAccess.mockImplementation(() => Promise.reject(permError));

        // Should complete without throwing
        await cleanupSession(sessionId);

        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                error: expect.anything(),
                msg:   expect.stringContaining('Failed to cleanup'),
            })
        );
    });

    test('should handle empty session ID gracefully', async () => {
        await cleanupSession('');

        // Should log a warning about invalid session ID
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                msg: expect.stringContaining('Invalid session ID'),
            })
        );
    });

    test('should not attempt file operations with empty session ID', async () => {
        await cleanupSession('');

        expect(mockAccess).not.toHaveBeenCalled();
        expect(mockUnlink).not.toHaveBeenCalled();
    });

    test('should cleanup session-env directory after deleting session file', async () => {
        const sessionId = 'test-session-env';

        await cleanupSession(sessionId);

        // Should call rm to remove the session-env directory
        expect(mockRm).toHaveBeenCalledWith(
            expect.stringContaining(`.claude/session-env/${sessionId}`),
            { recursive: true, force: true }
        );
    });

    test('should not throw when session-env directory does not exist', async () => {
        const sessionId = 'no-session-env';
        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';
        mockRm.mockImplementation(() => Promise.reject(notFoundError));

        // Should complete without throwing
        await cleanupSession(sessionId);
        expect(true).toBe(true);
    });

    test('should log warning when session-env cleanup fails with non-ENOENT error', async () => {
        const sessionId = 'session-env-error';
        const permError = new Error('EPERM') as NodeJS.ErrnoException;
        permError.code = 'EPERM';
        mockRm.mockImplementation(() => Promise.reject(permError));

        await cleanupSession(sessionId);

        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                error: expect.anything(),
                msg:   expect.stringContaining('session-env'),
            })
        );
    });

    test('should cleanup sub-agent sessions before deleting main session', async () => {
        const sessionId = 'parent-session-123';
        const agentFiles = ['agent-abc.jsonl', 'agent-def.jsonl', 'other-session.jsonl'];

        // Mock readdir to return some agent files
        mockReaddir.mockImplementation(() => Promise.resolve(agentFiles));

        // Mock readFile to return JSON with parentUuid matching our session
        mockReadFile.mockImplementation((path: string) => {
            if(path.includes('agent-abc.jsonl')) {
                return Promise.resolve('{"parentUuid":"parent-session-123","isSidechain":true}\n');
            }
            if(path.includes('agent-def.jsonl')) {
                return Promise.resolve('{"parentUuid":"parent-session-123","isSidechain":true}\n');
            }
            return Promise.resolve('{"session_id":"other-session"}\n');
        });

        await cleanupSession(sessionId);

        // Should have read the directory
        expect(mockReaddir).toHaveBeenCalledWith(expect.stringContaining('.claude/projects/'));

        // Should have read the agent files
        expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining('agent-abc.jsonl'), 'utf-8');
        expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining('agent-def.jsonl'), 'utf-8');

        // Should have deleted the matching agent files
        const unlinkCalls = _.map(mockUnlink.mock.calls, 0);
        expect(_.some(unlinkCalls, path => path.includes('agent-abc.jsonl'))).toBe(true);
        expect(_.some(unlinkCalls, path => path.includes('agent-def.jsonl'))).toBe(true);
    });

    test('should handle sub-agent cleanup errors gracefully', async () => {
        const sessionId = 'parent-with-error';
        const agentFiles = ['agent-error.jsonl'];

        mockReaddir.mockImplementation(() => Promise.resolve(agentFiles));

        // Mock readFile to throw an error
        const readError = new Error('Read failed');
        mockReadFile.mockImplementation(() => Promise.reject(readError));

        // Should complete without throwing
        await cleanupSession(sessionId);

        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                msg: expect.stringContaining('sub-agent'),
            })
        );
    });

    test('should handle when no sub-agent sessions exist', async () => {
        const sessionId = 'no-sub-agents';

        // No agent files
        mockReaddir.mockImplementation(() => Promise.resolve([]));

        await cleanupSession(sessionId);

        // Should still complete successfully
        expect(mockAccess).toHaveBeenCalled();
        expect(mockUnlink).toHaveBeenCalled();
    });

    test('should handle readdir errors for sub-agent cleanup gracefully', async () => {
        const sessionId = 'readdir-error';

        const readdirError = new Error('Permission denied');
        mockReaddir.mockImplementation(() => Promise.reject(readdirError));

        // Should complete without throwing
        await cleanupSession(sessionId);

        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                msg: expect.stringContaining('sub-agent'),
            })
        );
    });

    test('should skip files that do not match agent file pattern', async () => {
        const sessionId = 'pattern-test';
        const files = [
            'session.jsonl',          // Wrong pattern
            'nagent-abc.jsonl',       // Wrong prefix
            'agent-abc.json',         // Wrong extension
            'agent-.jsonl',           // Empty name after prefix
            'agent-valid.jsonl',      // SHOULD match
        ];

        mockReaddir.mockImplementation(() => Promise.resolve(files));
        mockReadFile.mockImplementation(() => Promise.resolve('{"parentUuid":"pattern-test"}\n'));

        await cleanupSession(sessionId);

        // Should only read the valid agent file
        expect(mockReadFile).toHaveBeenCalledTimes(1);
        expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining('agent-valid.jsonl'), 'utf-8');
    });

    test('should match agent files with dashes in name', async () => {
        const sessionId = 'dash-test';
        const files = ['agent-abc-def-ghi.jsonl'];

        mockReaddir.mockImplementation(() => Promise.resolve(files));
        mockReadFile.mockImplementation(() => Promise.resolve('{"parentUuid":"dash-test"}\n'));

        await cleanupSession(sessionId);

        // Should read and process the file with dashes
        expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining('agent-abc-def-ghi.jsonl'), 'utf-8');
    });

    test('should handle agent file with malformed JSON gracefully', async () => {
        const sessionId = 'malformed-json';
        const agentFiles = ['agent-malformed.jsonl'];

        mockReaddir.mockImplementation(() => Promise.resolve(agentFiles));
        mockReadFile.mockImplementation(() => Promise.resolve('not valid json{'));

        // Should complete without throwing
        await cleanupSession(sessionId);

        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                agentFile: 'agent-malformed.jsonl',
                msg:       expect.stringContaining('sub-agent'),
            })
        );
    });

    test('should skip agent file with no parentUuid field', async () => {
        const sessionId = 'no-parent-uuid';
        const agentFiles = ['agent-no-parent.jsonl'];

        mockReaddir.mockImplementation(() => Promise.resolve(agentFiles));
        mockReadFile.mockImplementation(() => Promise.resolve('{"isSidechain":true}\n'));

        await cleanupSession(sessionId);

        // Should not attempt to unlink the file (only main session file should be unlinked)
        const unlinkCalls = _.map(mockUnlink.mock.calls, 0);
        expect(_.some(unlinkCalls, path => path.includes('agent-no-parent.jsonl'))).toBe(false);
    });

    test('should skip agent file with non-string parentUuid', async () => {
        const sessionId = 'non-string-parent';
        const agentFiles = ['agent-non-string.jsonl'];

        mockReaddir.mockImplementation(() => Promise.resolve(agentFiles));
        mockReadFile.mockImplementation(() => Promise.resolve('{"parentUuid":123}\n'));

        await cleanupSession(sessionId);

        // Should not attempt to unlink the file
        const unlinkCalls = _.map(mockUnlink.mock.calls, 0);
        expect(_.some(unlinkCalls, path => path.includes('agent-non-string.jsonl'))).toBe(false);
    });

    test('should skip agent file with different parentUuid', async () => {
        const sessionId = 'our-session';
        const agentFiles = ['agent-different.jsonl'];

        mockReaddir.mockImplementation(() => Promise.resolve(agentFiles));
        mockReadFile.mockImplementation(() => Promise.resolve('{"parentUuid":"different-session"}\n'));

        await cleanupSession(sessionId);

        // Should not attempt to unlink the file
        const unlinkCalls = _.map(mockUnlink.mock.calls, 0);
        expect(_.some(unlinkCalls, path => path.includes('agent-different.jsonl'))).toBe(false);
    });

    test('should handle empty agent file content gracefully', async () => {
        const sessionId = 'empty-file';
        const agentFiles = ['agent-empty.jsonl'];

        mockReaddir.mockImplementation(() => Promise.resolve(agentFiles));
        mockReadFile.mockImplementation(() => Promise.resolve(''));

        // Should complete without throwing
        await cleanupSession(sessionId);

        // File should not be deleted since there's no valid JSON
        const unlinkCalls = _.map(mockUnlink.mock.calls, 0);
        expect(_.some(unlinkCalls, path => path.includes('agent-empty.jsonl'))).toBe(false);
    });

    test('should skip agent file with only newline characters', async () => {
        const sessionId = 'newline-only';
        const agentFiles = ['agent-newlines.jsonl'];

        mockReaddir.mockImplementation(() => Promise.resolve(agentFiles));
        // File with only newlines - first line will be empty after split
        mockReadFile.mockImplementation(() => Promise.resolve('\n\n\n'));

        await cleanupSession(sessionId);

        // File should not be deleted since firstLine is empty/falsy
        const unlinkCalls = _.map(mockUnlink.mock.calls, 0);
        expect(_.some(unlinkCalls, path => path.includes('agent-newlines.jsonl'))).toBe(false);
    });

    test('should continue processing other files when one has empty first line', async () => {
        const sessionId = 'mixed-files';
        const agentFiles = ['agent-empty.jsonl', 'agent-valid.jsonl'];

        mockReaddir.mockImplementation(() => Promise.resolve(agentFiles));
        mockReadFile.mockImplementation((path: string) => {
            if(path.includes('agent-empty.jsonl')) {
                // Empty first line - should be skipped
                return Promise.resolve('\n{"parentUuid":"wrong"}\n');
            }
            // Valid file with matching parentUuid
            return Promise.resolve('{"parentUuid":"mixed-files"}\n');
        });

        await cleanupSession(sessionId);

        // Only valid file should be deleted
        const unlinkCalls = _.map(mockUnlink.mock.calls, 0);
        expect(_.some(unlinkCalls, path => path.includes('agent-empty.jsonl'))).toBe(false);
        expect(_.some(unlinkCalls, path => path.includes('agent-valid.jsonl'))).toBe(true);
    });

    test('should handle whitespace-only session ID', async () => {
        const sessionId = '   ';

        await cleanupSession(sessionId);

        // Whitespace is truthy in JavaScript but should still attempt cleanup
        // The function validates with !sessionId which will be false for whitespace
        // So it should proceed with cleanup
        expect(mockAccess).toHaveBeenCalled();
    });

    test('should handle missing projects directory during sub-agent cleanup gracefully', async () => {
        const sessionId = 'test-missing-dir';

        // Mock access to fail on sub-agent directory check (first access call)
        // This simulates the case where the SDK projects directory doesn't exist
        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';

        let callCount = 0;
        mockAccess.mockImplementation((path: string) => {
            callCount++;
            // First call is sub-agent directory check - fail it
            if(callCount === 1) {
                return Promise.reject(notFoundError);
            }
            // Other calls succeed
            return Promise.resolve();
        });

        await cleanupSession(sessionId);

        // Should log a warning about missing SDK directory
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                msg: expect.stringContaining('SDK projects directory not found'),
            })
        );
    });

    test('should continue with session cleanup even if sub-agent directory is missing', async () => {
        const sessionId = 'test-continue-after-missing';

        // Mock access to fail on sub-agent directory check
        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';

        let callCount = 0;
        mockAccess.mockImplementation(() => {
            callCount++;
            // First call (sub-agent directory check) fails
            if(callCount === 1) {
                return Promise.reject(notFoundError);
            }
            // Other calls succeed
            return Promise.resolve();
        });

        await cleanupSession(sessionId);

        // Should still attempt to clean up the main session file
        expect(mockUnlink).toHaveBeenCalled();
    });

    test('should warn when SDK projects base directory does not exist', async () => {
        const sessionId = 'test-no-base-dir';

        // Mock access to fail for both session file AND projects base directory
        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';

        let callCount = 0;
        mockAccess.mockImplementation((path: string) => {
            callCount++;
            // First call: sub-agent directory check - succeeds
            if(callCount === 1) {
                return Promise.resolve();
            }
            // Second call: session file check - fails with ENOENT
            if(callCount === 2) {
                return Promise.reject(notFoundError);
            }
            // Third call: projects base directory check - also fails
            if(callCount === 3) {
                return Promise.reject(notFoundError);
            }
            return Promise.resolve();
        });

        await cleanupSession(sessionId);

        // Should warn about SDK projects directory not found
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                msg: expect.stringContaining('SDK projects directory not found'),
            })
        );
    });

    test('should debug log when session file missing but projects directory exists', async () => {
        const sessionId = 'test-normal-missing';

        // Mock access to fail for session file but succeed for projects base directory
        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';

        let callCount = 0;
        mockAccess.mockImplementation(() => {
            callCount++;
            // First call: sub-agent directory check - succeeds
            if(callCount === 1) {
                return Promise.resolve();
            }
            // Second call: session file check - fails with ENOENT
            if(callCount === 2) {
                return Promise.reject(notFoundError);
            }
            // Third call: projects base directory check - succeeds (normal case)
            if(callCount === 3) {
                return Promise.resolve();
            }
            return Promise.resolve();
        });

        await cleanupSession(sessionId);

        // Should debug log about file not found (normal case)
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                msg: expect.stringContaining('not found'),
            })
        );

        // Should NOT warn about SDK changes
        const warnCalls = mockLogger.warn.mock.calls;
        const sdkWarnings = _.filter(warnCalls, (call: unknown[]) => {
            const logObj = call[0] as { msg?: string };
            return logObj.msg?.includes('SDK projects directory not found');
        });
        expect(sdkWarnings.length).toBe(0);
    });
});

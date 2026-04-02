/**
 * Tests for session cleanup utility
 *
 * Session cleanup removes temporary session files created by the Claude Agent SDK
 * after a query completes. This prevents disk space accumulation from ephemeral
 * bot interactions that don't need session persistence.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { cleanupSession, getSessionFilePath, extractSessionId, cleanupAllStaleSessions } from '../../../src/agent/session-cleanup';
import type { SystemEvent } from '../../../src/agent/types';
import { mockLogger, mockFsPromises, resetMockFs } from '../../setup';

// Use the mocks from setup.ts instead of creating new ones
// (setup.ts already mocks node:fs/promises globally)
const mockAccess = mockFsPromises.access;
const mockUnlink = mockFsPromises.unlink;
const mockRm = mockFsPromises.rm;
const mockReaddir = mockFsPromises.readdir;
const mockReadFile = mockFsPromises.readFile;

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
        const expectedProjectPath = cwd.replaceAll('/', '-');
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

    test.each([
        ['non-system events', { type: 'assistant', message: {} }],
        ['system events without init subtype', { type: 'system', subtype: 'status', session_id: 'should-not-extract' }],
        ['system init events without session_id', { type: 'system', subtype: 'init' }],
        ['null input', null],
        ['undefined input', undefined],
        ['array input', ['not', 'an', 'object']],
    ])('should return undefined for %s', (_description, event) => {
        const result = extractSessionId(event);
        expect(result).toBeUndefined();
    });

    test('should return null for null session_id', () => {
        const event = { type: 'system', subtype: 'init', session_id: null as unknown as string };
        const result = extractSessionId(event);
        expect(result).toBeNull();
    });

    test('should return empty string for empty session_id', () => {
        const event = { type: 'system', subtype: 'init', session_id: '' };
        const result = extractSessionId(event);
        expect(result).toBe('');
    });

    test.each([
        ['system event missing subtype field', { type: 'system', session_id: 'should-not-extract' }],
        ['type is not system but subtype is init', { type: 'user', subtype: 'init', session_id: 'should-not-extract' }],
        ['type is system but subtype is not init', { type: 'system', subtype: 'message', session_id: 'should-not-extract' }],
    ])('should return undefined when %s', (_description, event) => {
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

    test.each([
        ['unlink error', 'mockUnlink', (mock: typeof mockUnlink) => mock.mockImplementation(() => Promise.reject(new Error('EPERM')))],
        ['access error (non-ENOENT)', 'mockAccess', (mock: typeof mockAccess) => mock.mockImplementation(() => Promise.reject(new Error('EPERM')))],
    ])('should log warning on %s but not throw', async (_description, _mockName, setupMock) => {
        const sessionId = 'session-error';

        setupMock(_mockName === 'mockUnlink' ? mockUnlink : mockAccess);

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

    test('should cleanup session-env directory after deleting session file', async () => {
        const sessionId = 'test-session-env';

        await cleanupSession(sessionId);

        // Should call rm to remove the session-env directory with correct options
        expect(mockRm).toHaveBeenCalledWith(
            expect.stringContaining(`.claude/session-env/${sessionId}`),
            { recursive: true, force: true }
        );

        // Verify the exact options object to kill ObjectLiteral and BooleanLiteral mutants
        const rmCalls = mockRm.mock.calls;
        expect(rmCalls.length).toBeGreaterThan(0);
        const lastCall = rmCalls[rmCalls.length - 1];
        expect(lastCall[1]).toEqual({ recursive: true, force: true });
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
        expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining('agent-abc.jsonl'), 'utf8');
        expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining('agent-def.jsonl'), 'utf8');

        // Should have deleted the matching agent files
        const unlinkCalls = mockUnlink.mock.calls.map(call => call[0]);
        expect(unlinkCalls.some(path => path.includes('agent-abc.jsonl'))).toBe(true);
        expect(unlinkCalls.some(path => path.includes('agent-def.jsonl'))).toBe(true);
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
        expect(mockAccess).toHaveBeenCalledWith(expect.stringContaining('.claude/projects/'));
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
        expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining('agent-valid.jsonl'), 'utf8');
    });

    test('should match agent files with dashes in name', async () => {
        const sessionId = 'dash-test';
        const files = ['agent-abc-def-ghi.jsonl'];

        mockReaddir.mockImplementation(() => Promise.resolve(files));
        mockReadFile.mockImplementation(() => Promise.resolve('{"parentUuid":"dash-test"}\n'));

        await cleanupSession(sessionId);

        // Should read and process the file with dashes
        expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining('agent-abc-def-ghi.jsonl'), 'utf8');
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

    test.each([
        ['no parentUuid field', 'agent-no-parent.jsonl', '{"isSidechain":true}\n'],
        ['non-string parentUuid', 'agent-non-string.jsonl', '{"parentUuid":123}\n'],
        ['different parentUuid', 'agent-different.jsonl', '{"parentUuid":"different-session"}\n'],
        ['empty file content', 'agent-empty.jsonl', ''],
        ['only newline characters', 'agent-newlines.jsonl', '\n\n\n'],
    ])('should skip agent file with %s', async (_description, fileName, fileContent) => {
        const sessionId = 'test-session';
        const agentFiles = [fileName];

        mockReaddir.mockImplementation(() => Promise.resolve(agentFiles));
        mockReadFile.mockImplementation(() => Promise.resolve(fileContent));

        await cleanupSession(sessionId);

        // Should not attempt to unlink the file
        const unlinkCalls = mockUnlink.mock.calls.map(call => call[0]);
        expect(unlinkCalls.some(path => path.includes(fileName))).toBe(false);
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
        const unlinkCalls = mockUnlink.mock.calls.map(call => call[0]);
        expect(unlinkCalls.some(path => path.includes('agent-empty.jsonl'))).toBe(false);
        expect(unlinkCalls.some(path => path.includes('agent-valid.jsonl'))).toBe(true);
    });

    test('should handle whitespace-only session ID', async () => {
        const sessionId = '   ';

        await cleanupSession(sessionId);

        // Whitespace is truthy in JavaScript but should still attempt cleanup
        // The function validates with !sessionId which will be false for whitespace
        // So it should proceed with cleanup
        expect(mockAccess).toHaveBeenCalledWith(expect.stringContaining('.claude/projects/'));
    });

    test('should handle missing projects directory during sub-agent cleanup gracefully', async () => {
        const sessionId = 'test-missing-dir';

        // Mock access to fail on sub-agent directory check (first access call)
        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';

        let callCount = 0;
        mockAccess.mockImplementation((_path: string) => {
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

        // Should still attempt to clean up the main session file
        expect(mockUnlink).toHaveBeenCalled();
    });

    test('should warn when SDK projects base directory does not exist', async () => {
        const sessionId = 'test-no-base-dir';

        // Mock access to fail for both session file AND projects base directory
        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';

        let callCount = 0;
        mockAccess.mockImplementation((_path: string) => {
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
        const sdkWarnings = warnCalls.filter((call: unknown[]): boolean => {
            const logObj = call[0] as { msg?: string };
            return logObj.msg?.includes('SDK projects directory not found') ?? false;
        });
        expect(sdkWarnings.length).toBe(0);
    });

    test('should skip sub-agent scan when skipSubAgentScan option is true', async () => {
        const sessionId = 'skip-scan-session';

        await cleanupSession(sessionId, { skipSubAgentScan: true });

        // Should NOT scan for sub-agent files
        expect(mockReaddir).not.toHaveBeenCalled();
        expect(mockReadFile).not.toHaveBeenCalled();

        // Should still delete the main session file
        expect(mockUnlink).toHaveBeenCalledTimes(1);
        expect(mockUnlink.mock.calls[0][0]).toContain(sessionId);

        // Should still clean up session-env directory
        expect(mockRm).toHaveBeenCalledWith(
            expect.stringContaining(`.claude/session-env/${sessionId}`),
            { recursive: true, force: true }
        );
    });

    test('should still perform sub-agent scan when skipSubAgentScan is false', async () => {
        const sessionId = 'no-skip-session';
        mockReaddir.mockImplementation(() => Promise.resolve([]));

        await cleanupSession(sessionId, { skipSubAgentScan: false });

        // Should still scan for sub-agent files
        expect(mockReaddir).toHaveBeenCalledWith(expect.stringContaining('.claude/projects/'));
    });

    test('should still perform sub-agent scan when no options provided', async () => {
        const sessionId = 'default-session';
        mockReaddir.mockImplementation(() => Promise.resolve([]));

        await cleanupSession(sessionId);

        // Should scan for sub-agent files (backward compatible default)
        expect(mockReaddir).toHaveBeenCalledWith(expect.stringContaining('.claude/projects/'));
    });
});

describe('cleanupAllStaleSessions', () => {
    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
        mockAccess.mockClear();
        mockUnlink.mockClear();
        mockRm.mockClear();
        mockReaddir.mockClear();
        // Reset to default successful behavior
        mockAccess.mockImplementation(() => Promise.resolve());
        mockUnlink.mockImplementation(() => Promise.resolve());
        mockRm.mockImplementation(() => Promise.resolve());
        mockReaddir.mockImplementation(() => Promise.resolve([]));
    });

    afterEach(() => {
        resetMockFs();
    });

    test('should delete all session files in projects directory', async () => {
        const sessionFiles = ['session-1.jsonl', 'session-2.jsonl', 'agent-abc.jsonl'];
        mockReaddir.mockImplementation((path: string) => {
            if(path.includes('.claude/projects/')) {
                return Promise.resolve(sessionFiles);
            }
            return Promise.resolve([]);
        });

        await cleanupAllStaleSessions();

        // Should have attempted to delete all .jsonl files (order not guaranteed with parallel execution)
        expect(mockUnlink).toHaveBeenCalledTimes(3);
        const unlinkPaths = mockUnlink.mock.calls.map((call: unknown[]) => call[0] as string);
        expect(unlinkPaths.some(p => p.includes('session-1.jsonl'))).toBe(true);
        expect(unlinkPaths.some(p => p.includes('session-2.jsonl'))).toBe(true);
        expect(unlinkPaths.some(p => p.includes('agent-abc.jsonl'))).toBe(true);
    });

    test('should delete all session-env directories', async () => {
        const envDirs = ['session-env-1', 'session-env-2', 'session-env-3'];
        mockReaddir.mockImplementation((path: string) => {
            if(path.includes('.claude/session-env')) {
                return Promise.resolve(envDirs);
            }
            return Promise.resolve([]);
        });

        await cleanupAllStaleSessions();

        // Should have attempted to delete all session-env directories (order not guaranteed with parallel execution)
        expect(mockRm).toHaveBeenCalledTimes(3);
        const rmPaths = mockRm.mock.calls.map((call: unknown[]) => call[0] as string);
        expect(rmPaths.some(p => p.includes('session-env-1'))).toBe(true);
        expect(rmPaths.some(p => p.includes('session-env-2'))).toBe(true);
        expect(rmPaths.some(p => p.includes('session-env-3'))).toBe(true);

        // Verify the exact options object to kill ObjectLiteral and BooleanLiteral mutants
        for(const call of mockRm.mock.calls) {
            expect(call[1]).toEqual({ recursive: true, force: true });
        }
    });

    test('should log summary when files were cleaned', async () => {
        const sessionFiles = ['session-1.jsonl', 'session-2.jsonl'];
        const envDirs = ['env-1'];

        mockReaddir.mockImplementation((path: string) => {
            if(path.includes('.claude/projects/')) {
                return Promise.resolve(sessionFiles);
            }
            if(path.includes('.claude/session-env')) {
                return Promise.resolve(envDirs);
            }
            return Promise.resolve([]);
        });

        await cleanupAllStaleSessions();

        // Should log summary with total count (2 session files + 1 env dir = 3)
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                cleanedCount: 3,
                msg:          expect.stringContaining('Cleaned up 3 stale session files'),
            })
        );
    });

    test('should not log when no files were cleaned', async () => {
        mockReaddir.mockImplementation(() => Promise.resolve([]));

        await cleanupAllStaleSessions();

        // Should NOT log when cleanedCount is 0
        expect(mockLogger.info).not.toHaveBeenCalled();
    });

    test('should handle missing projects directory gracefully', async () => {
        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';

        mockAccess.mockImplementation((path: string) => {
            if(path.includes('.claude/projects/')) {
                return Promise.reject(notFoundError);
            }
            // session-env directory doesn't exist either
            return Promise.reject(notFoundError);
        });

        // Should complete without throwing
        await cleanupAllStaleSessions();

        // Should not attempt to delete session files
        expect(mockUnlink).not.toHaveBeenCalled();
        // Should not attempt to delete session-env directories
        expect(mockRm).not.toHaveBeenCalled();
    });

    test('should handle missing session-env directory gracefully', async () => {
        const notFoundError = new Error('ENOENT') as NodeJS.ErrnoException;
        notFoundError.code = 'ENOENT';

        mockAccess.mockImplementation((path: string) => {
            if(path.includes('.claude/session-env')) {
                return Promise.reject(notFoundError);
            }
            return Promise.resolve();
        });

        mockReaddir.mockImplementation(() => Promise.resolve([]));

        // Should complete without throwing
        await cleanupAllStaleSessions();

        // Should not attempt to delete session-env directories
        expect(mockRm).not.toHaveBeenCalled();
    });

    test('should continue cleanup when individual file deletion fails', async () => {
        const sessionFiles = ['session-1.jsonl', 'session-2.jsonl', 'session-3.jsonl'];
        mockReaddir.mockImplementation((path: string) => {
            if(path.includes('.claude/projects/')) {
                return Promise.resolve(sessionFiles);
            }
            return Promise.resolve([]);
        });

        // Make the second file deletion fail
        let unlinkCount = 0;
        mockUnlink.mockImplementation(() => {
            unlinkCount++;
            if(unlinkCount === 2) {
                return Promise.reject(new Error('EPERM'));
            }
            return Promise.resolve();
        });

        await cleanupAllStaleSessions();

        // Should still attempt to delete all files
        expect(mockUnlink).toHaveBeenCalledTimes(3);

        // Should count only successful deletions (2 out of 3)
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                cleanedCount: 2,
            })
        );
    });

    test('should continue cleanup when individual session-env deletion fails', async () => {
        const envDirs = ['env-1', 'env-2', 'env-3'];
        mockReaddir.mockImplementation((path: string) => {
            if(path.includes('.claude/session-env')) {
                return Promise.resolve(envDirs);
            }
            return Promise.resolve([]);
        });

        // Make the second directory deletion fail
        let rmCount = 0;
        mockRm.mockImplementation(() => {
            rmCount++;
            if(rmCount === 2) {
                return Promise.reject(new Error('EPERM'));
            }
            return Promise.resolve();
        });

        await cleanupAllStaleSessions();

        // Should still attempt to delete all directories
        expect(mockRm).toHaveBeenCalledTimes(3);

        // Should count only successful deletions (2 out of 3)
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                cleanedCount: 2,
            })
        );
    });

    test('should only delete .jsonl files from projects directory', async () => {
        const files = ['session.jsonl', 'other.txt', 'README.md', 'agent.jsonl'];
        mockReaddir.mockImplementation((path: string) => {
            if(path.includes('.claude/projects/')) {
                return Promise.resolve(files);
            }
            return Promise.resolve([]);
        });

        await cleanupAllStaleSessions();

        // Should only delete .jsonl files (2 files)
        expect(mockUnlink).toHaveBeenCalledTimes(2);
        expect(mockUnlink.mock.calls[0][0]).toContain('session.jsonl');
        expect(mockUnlink.mock.calls[1][0]).toContain('agent.jsonl');
    });

    test('should handle readdir errors for projects directory gracefully', async () => {
        mockAccess.mockImplementation(() => Promise.resolve());
        mockReaddir.mockImplementation((path: string) => {
            if(path.includes('.claude/projects/')) {
                return Promise.reject(new Error('Permission denied'));
            }
            return Promise.resolve([]);
        });

        // Should complete without throwing
        await cleanupAllStaleSessions();

        // Should not attempt to delete files
        expect(mockUnlink).not.toHaveBeenCalled();
    });

    test('should handle readdir errors for session-env directory gracefully', async () => {
        mockAccess.mockImplementation(() => Promise.resolve());
        mockReaddir.mockImplementation((path: string) => {
            if(path.includes('.claude/session-env')) {
                return Promise.reject(new Error('Permission denied'));
            }
            return Promise.resolve([]);
        });

        // Should complete without throwing
        await cleanupAllStaleSessions();

        // Should not attempt to delete session-env directories
        expect(mockRm).not.toHaveBeenCalled();
    });

    test('should clean both session files and session-env directories', async () => {
        const sessionFiles = ['session-1.jsonl'];
        const envDirs = ['env-1'];

        mockReaddir.mockImplementation((path: string) => {
            if(path.includes('.claude/projects/')) {
                return Promise.resolve(sessionFiles);
            }
            if(path.includes('.claude/session-env')) {
                return Promise.resolve(envDirs);
            }
            return Promise.resolve([]);
        });

        await cleanupAllStaleSessions();

        // Should clean both types
        expect(mockUnlink).toHaveBeenCalledTimes(1);
        expect(mockRm).toHaveBeenCalledTimes(1);

        // Total cleaned count should be 2
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.objectContaining({
                cleanedCount: 2,
            })
        );
    });
});

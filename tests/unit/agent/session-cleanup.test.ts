/**
 * Tests for session cleanup utility
 *
 * Extracts session IDs from SDK stream events and sweeps stale conductor-mode session files.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getSessionFilePath, extractSessionId, pruneStaleSessions } from '../../../src/agent/session-cleanup';
import type { SystemEvent } from '../../../src/agent/types';
import { mockLogger, mockFsPromises, resetMockFs } from '../../setup';

// Use the mocks from setup.ts instead of creating new ones
// (setup.ts already mocks node:fs/promises globally)
const mockAccess = mockFsPromises.access;
const mockUnlink = mockFsPromises.unlink;
const mockRm = mockFsPromises.rm;
const mockReaddir = mockFsPromises.readdir;
const mockStat = mockFsPromises.stat;

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

describe('pruneStaleSessions', () => {
    const NOW = 1_700_000_000_000;
    const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const OLD_MTIME = NOW - MAX_AGE_MS - 1000;
    const YOUNG_MTIME = NOW - 1000;

    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockAccess.mockClear();
        mockUnlink.mockClear();
        mockRm.mockClear();
        mockReaddir.mockClear();
        mockStat.mockClear();
        mockReaddir.mockImplementation(() => Promise.resolve([]));
        mockStat.mockImplementation(() => Promise.resolve({ mtimeMs: YOUNG_MTIME } as never));
        mockRm.mockImplementation(() => Promise.resolve());
    });

    afterEach(() => {
        resetMockFs();
    });

    test('kept id survives regardless of age: both its .jsonl and its directory are untouched', async () => {
        mockReaddir.mockImplementation((dirPath: string) => {
            if(dirPath.includes('.claude/projects/')) {
                return Promise.resolve(['a.jsonl', 'a']);
            }
            return Promise.resolve([]);
        });
        mockStat.mockImplementation(() => Promise.resolve({ mtimeMs: OLD_MTIME } as never));

        await pruneStaleSessions({ keepSessionIds: new Set(['a']), maxAgeMs: MAX_AGE_MS, now: NOW });

        expect(mockRm).not.toHaveBeenCalled();
    });

    test('old unkept .jsonl and its directory are both removed recursively', async () => {
        mockReaddir.mockImplementation((dirPath: string) => {
            if(dirPath.includes('.claude/projects/')) {
                return Promise.resolve(['b.jsonl', 'b']);
            }
            return Promise.resolve([]);
        });
        mockStat.mockImplementation(() => Promise.resolve({ mtimeMs: OLD_MTIME } as never));

        await pruneStaleSessions({ keepSessionIds: new Set(), maxAgeMs: MAX_AGE_MS, now: NOW });

        expect(mockRm).toHaveBeenCalledTimes(2);
        const rmPaths = mockRm.mock.calls.map((call: unknown[]) => call[0] as string);
        expect(rmPaths.some(p => p.endsWith('b.jsonl'))).toBe(true);
        expect(rmPaths.some(p => p.endsWith('/b'))).toBe(true);
        for(const call of mockRm.mock.calls) {
            expect(call[1]).toEqual(expect.objectContaining({ recursive: true, force: true }));
        }
    });

    test('young unkept entries survive', async () => {
        mockReaddir.mockImplementation((dirPath: string) => {
            if(dirPath.includes('.claude/projects/')) {
                return Promise.resolve(['c']);
            }
            return Promise.resolve([]);
        });
        mockStat.mockImplementation(() => Promise.resolve({ mtimeMs: YOUNG_MTIME } as never));

        await pruneStaleSessions({ keepSessionIds: new Set(), maxAgeMs: MAX_AGE_MS, now: NOW });

        expect(mockRm).not.toHaveBeenCalled();
    });

    test('session-env/<id> is pruned by the same keep/age rule', async () => {
        mockReaddir.mockImplementation((dirPath: string) => {
            if(dirPath.includes('.claude/session-env')) {
                return Promise.resolve(['old-id', 'kept-id']);
            }
            return Promise.resolve([]);
        });
        mockStat.mockImplementation(() => Promise.resolve({ mtimeMs: OLD_MTIME } as never));

        await pruneStaleSessions({ keepSessionIds: new Set(['kept-id']), maxAgeMs: MAX_AGE_MS, now: NOW });

        expect(mockRm).toHaveBeenCalledTimes(1);
        expect(mockRm.mock.calls[0]?.[0]).toContain('old-id');
    });

    test('ENOENT on the projects directory is silent', async () => {
        mockReaddir.mockImplementation((dirPath: string) => {
            if(dirPath.includes('.claude/projects/')) {
                const error = Object.assign(new Error('not found'), { code: 'ENOENT' });
                return Promise.reject(error);
            }
            return Promise.resolve([]);
        });

        await expect(pruneStaleSessions({ keepSessionIds: new Set(), maxAgeMs: MAX_AGE_MS, now: NOW })).resolves.toBeUndefined();
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('ENOENT on the session-env directory is silent', async () => {
        mockReaddir.mockImplementation((dirPath: string) => {
            if(dirPath.includes('.claude/session-env')) {
                const error = Object.assign(new Error('not found'), { code: 'ENOENT' });
                return Promise.reject(error);
            }
            return Promise.resolve([]);
        });

        await expect(pruneStaleSessions({ keepSessionIds: new Set(), maxAgeMs: MAX_AGE_MS, now: NOW })).resolves.toBeUndefined();
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('a stat failure on one entry is logged and the loop continues to prune the rest', async () => {
        mockReaddir.mockImplementation((dirPath: string) => {
            if(dirPath.includes('.claude/projects/')) {
                return Promise.resolve(['broken', 'old']);
            }
            return Promise.resolve([]);
        });
        const statFailure = new Error('stat failed');
        mockStat.mockImplementation((statPath: string) => {
            if(statPath.endsWith('broken')) {
                return Promise.reject(statFailure);
            }
            return Promise.resolve({ mtimeMs: OLD_MTIME } as never);
        });

        await pruneStaleSessions({ keepSessionIds: new Set(), maxAgeMs: MAX_AGE_MS, now: NOW });

        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
            entryPath: expect.stringContaining('broken') as string,
            error:     statFailure,
        }));
        expect(mockRm).toHaveBeenCalledTimes(1);
        expect(mockRm.mock.calls[0]?.[0]).toContain('old');
    });

    test('an entry exactly at the retention cutoff survives (boundary is >=, not >)', async () => {
        mockReaddir.mockImplementation((dirPath: string) => {
            if(dirPath.includes('.claude/projects/')) {
                return Promise.resolve(['at-cutoff']);
            }
            return Promise.resolve([]);
        });
        mockStat.mockImplementation(() => Promise.resolve({ mtimeMs: NOW - MAX_AGE_MS } as never));

        await pruneStaleSessions({ keepSessionIds: new Set(), maxAgeMs: MAX_AGE_MS, now: NOW });

        expect(mockRm).not.toHaveBeenCalled();
    });

    test('an entry one millisecond past the retention cutoff is removed', async () => {
        mockReaddir.mockImplementation((dirPath: string) => {
            if(dirPath.includes('.claude/projects/')) {
                return Promise.resolve(['past-cutoff']);
            }
            return Promise.resolve([]);
        });
        mockStat.mockImplementation(() => Promise.resolve({ mtimeMs: NOW - MAX_AGE_MS - 1 } as never));

        await pruneStaleSessions({ keepSessionIds: new Set(), maxAgeMs: MAX_AGE_MS, now: NOW });

        expect(mockRm).toHaveBeenCalledTimes(1);
    });

    test('a removal failure on one entry is logged and the loop continues to prune the rest', async () => {
        mockReaddir.mockImplementation((dirPath: string) => {
            if(dirPath.includes('.claude/projects/')) {
                return Promise.resolve(['unremovable', 'removable']);
            }
            return Promise.resolve([]);
        });
        mockStat.mockImplementation(() => Promise.resolve({ mtimeMs: OLD_MTIME } as never));
        const rmFailure = new Error('rm failed');
        mockRm.mockImplementation((rmPath: string) => {
            if(rmPath.endsWith('unremovable')) {
                return Promise.reject(rmFailure);
            }
            return Promise.resolve();
        });

        await pruneStaleSessions({ keepSessionIds: new Set(), maxAgeMs: MAX_AGE_MS, now: NOW });

        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
            entryPath: expect.stringContaining('unremovable') as string,
            error:     rmFailure,
        }));
        expect(mockRm.mock.calls.some((call: unknown[]) => (call[0] as string).endsWith('removable'))).toBe(true);
    });

    test('a non-ENOENT directory listing failure is logged and pruning of that directory is skipped', async () => {
        const listFailure = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        mockReaddir.mockImplementation((dirPath: string) => {
            if(dirPath.includes('.claude/projects/')) {
                return Promise.reject(listFailure);
            }
            return Promise.resolve([]);
        });

        await expect(pruneStaleSessions({ keepSessionIds: new Set(), maxAgeMs: MAX_AGE_MS, now: NOW })).resolves.toBeUndefined();

        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
            dir:   expect.stringContaining('.claude/projects/') as string,
            error: listFailure,
        }));
        expect(mockRm).not.toHaveBeenCalled();
    });
});

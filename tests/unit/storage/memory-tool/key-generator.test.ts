import { describe, expect, test } from 'bun:test';
import { repeat as _repeat } from 'lodash';
import { MemoryToolKeyGenerator, generateContentPreview } from '@/storage/memory-tool/key-generator';
import type { MemoryPath } from '@/storage/memory-tool/types';

describe.concurrent('MemoryToolKeyGenerator', () => {
    describe('createKeys', () => {
        test('should create keys for a file in root directory', () => {
            const path = '/file.xml' as MemoryPath;
            const timestamp = '2024-01-15T10:30:00.000Z';

            const keys = MemoryToolKeyGenerator.createKeys(path, timestamp);

            // Root-level files use the filename as the layer segment since there's no parent directory
            expect(keys).toEqual({
                PK:     'DIR#/',
                SK:     'FILE#file.xml',
                GSI1PK: 'LAYER#file.xml',
                GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
            });
        });

        test('should create keys for a file in nested directory', () => {
            const path = '/memories/events/party.xml' as MemoryPath;
            const timestamp = '2024-01-15T10:30:00.000Z';

            const keys = MemoryToolKeyGenerator.createKeys(path, timestamp);

            expect(keys).toEqual({
                PK:     'DIR#/memories/events',
                SK:     'FILE#party.xml',
                GSI1PK: 'LAYER#memories',
                GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
            });
        });

        test('should create keys for a file in single-level directory', () => {
            const path = '/configs/settings.xml' as MemoryPath;
            const timestamp = '2024-01-15T10:30:00.000Z';

            const keys = MemoryToolKeyGenerator.createKeys(path, timestamp);

            expect(keys).toEqual({
                PK:     'DIR#/configs',
                SK:     'FILE#settings.xml',
                GSI1PK: 'LAYER#configs',
                GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
            });
        });

        test('should create keys for identity layer path', () => {
            const path = '/identity/core-values.md' as MemoryPath;
            const timestamp = '2024-01-15T10:30:00.000Z';

            const keys = MemoryToolKeyGenerator.createKeys(path, timestamp);

            expect(keys).toEqual({
                PK:     'DIR#/identity',
                SK:     'FILE#core-values.md',
                GSI1PK: 'LAYER#identity',
                GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
            });
        });

        test('should create keys for state layer path', () => {
            const path = '/state/current.md' as MemoryPath;
            const timestamp = '2024-01-15T10:30:00.000Z';

            const keys = MemoryToolKeyGenerator.createKeys(path, timestamp);

            expect(keys).toEqual({
                PK:     'DIR#/state',
                SK:     'FILE#current.md',
                GSI1PK: 'LAYER#state',
                GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
            });
        });

        test('should create keys for events layer path', () => {
            const path = '/events/meeting.md' as MemoryPath;
            const timestamp = '2024-01-15T10:30:00.000Z';

            const keys = MemoryToolKeyGenerator.createKeys(path, timestamp);

            expect(keys).toEqual({
                PK:     'DIR#/events',
                SK:     'FILE#meeting.md',
                GSI1PK: 'LAYER#events',
                GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
            });
        });

        test('should auto-generate timestamp if not provided', () => {
            const path = '/identity/file.xml' as MemoryPath;
            const beforeCall = new Date().toISOString();

            const keys = MemoryToolKeyGenerator.createKeys(path);

            const afterCall = new Date().toISOString();
            expect(keys.PK).toBe('DIR#/identity');
            expect(keys.SK).toBe('FILE#file.xml');
            expect(keys.GSI1PK).toBe('LAYER#identity');
            expect(keys.GSI1SK).toMatch(/^UPDATED#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

            // Extract timestamp from GSI1SK
            // eslint-disable-next-line lodash/prefer-lodash-method -- String.replace is simpler for single replacement
            const timestamp = keys.GSI1SK.replace('UPDATED#', '');
            expect(timestamp >= beforeCall).toBe(true);
            expect(timestamp <= afterCall).toBe(true);
        });

        test('should handle filenames with special characters', () => {
            const path = '/docs/my-file_v2.0.xml' as MemoryPath;
            const timestamp = '2024-01-15T10:30:00.000Z';

            const keys = MemoryToolKeyGenerator.createKeys(path, timestamp);

            expect(keys).toEqual({
                PK:     'DIR#/docs',
                SK:     'FILE#my-file_v2.0.xml',
                GSI1PK: 'LAYER#docs',
                GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
            });
        });

        test('should handle deeply nested paths', () => {
            const path = '/a/b/c/d/e/file.xml' as MemoryPath;
            const timestamp = '2024-01-15T10:30:00.000Z';

            const keys = MemoryToolKeyGenerator.createKeys(path, timestamp);

            expect(keys).toEqual({
                PK:     'DIR#/a/b/c/d/e',
                SK:     'FILE#file.xml',
                GSI1PK: 'LAYER#a',
                GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
            });
        });
    });

    describe('parsePath', () => {
        test('should parse keys for a root-level file', () => {
            const pk = 'DIR#/';
            const sk = 'FILE#file.xml';

            const path = MemoryToolKeyGenerator.parsePath(pk, sk);

            expect(path).toBe('/file.xml');
        });

        test('should parse keys for a nested file', () => {
            const pk = 'DIR#/memories/events';
            const sk = 'FILE#party.xml';

            const path = MemoryToolKeyGenerator.parsePath(pk, sk);

            expect(path).toBe('/memories/events/party.xml');
        });

        test('should parse keys for a single-level directory file', () => {
            const pk = 'DIR#/configs';
            const sk = 'FILE#settings.xml';

            const path = MemoryToolKeyGenerator.parsePath(pk, sk);

            expect(path).toBe('/configs/settings.xml');
        });

        test('should throw error if PK does not start with DIR#', () => {
            const pk = 'INVALID#/configs';
            const sk = 'FILE#settings.xml';

            expect(() => MemoryToolKeyGenerator.parsePath(pk, sk)).toThrow(
                'Invalid PK format: expected DIR#..., got INVALID#/configs'
            );
        });

        test('should throw error if SK does not start with FILE#', () => {
            const pk = 'DIR#/configs';
            const sk = 'INVALID#settings.xml';

            expect(() => MemoryToolKeyGenerator.parsePath(pk, sk)).toThrow(
                'Invalid SK format: expected FILE#..., got INVALID#settings.xml'
            );
        });

        test('should throw error if PK is malformed', () => {
            const pk = 'DIR';
            const sk = 'FILE#settings.xml';

            expect(() => MemoryToolKeyGenerator.parsePath(pk, sk)).toThrow(
                'Invalid PK format: expected DIR#..., got DIR'
            );
        });

        test('should throw error if SK is malformed', () => {
            const pk = 'DIR#/configs';
            const sk = 'FILE';

            expect(() => MemoryToolKeyGenerator.parsePath(pk, sk)).toThrow(
                'Invalid SK format: expected FILE#..., got FILE'
            );
        });

        test('should handle filenames with special characters', () => {
            const pk = 'DIR#/docs';
            const sk = 'FILE#my-file_v2.0.xml';

            const path = MemoryToolKeyGenerator.parsePath(pk, sk);

            expect(path).toBe('/docs/my-file_v2.0.xml');
        });

        test('should handle deeply nested paths', () => {
            const pk = 'DIR#/a/b/c/d/e';
            const sk = 'FILE#file.xml';

            const path = MemoryToolKeyGenerator.parsePath(pk, sk);

            expect(path).toBe('/a/b/c/d/e/file.xml');
        });

        test('should be inverse of createKeys', () => {
            const originalPath = '/memories/events/party.xml' as MemoryPath;
            const timestamp = '2024-01-15T10:30:00.000Z';

            const keys = MemoryToolKeyGenerator.createKeys(originalPath, timestamp);
            const parsedPath = MemoryToolKeyGenerator.parsePath(keys.PK, keys.SK);

            expect(parsedPath).toBe(originalPath);
        });
    });

    describe('round-trip consistency', () => {
        test('should maintain path through create->parse cycle', () => {
            const testPaths: MemoryPath[] = [
                '/file.xml' as MemoryPath,
                '/docs/readme.xml' as MemoryPath,
                '/a/b/c/deep.xml' as MemoryPath,
                '/my-docs/file_v2.0.xml' as MemoryPath,
            ];

            for(const path of testPaths) {
                const keys = MemoryToolKeyGenerator.createKeys(path);
                const parsed = MemoryToolKeyGenerator.parsePath(keys.PK, keys.SK);
                expect(parsed).toBe(path);
            }
        });
    });

    describe('createTagKeys', () => {
        test('should create GSI2 keys with tag and layer', () => {
            const path = '/identity/core-values.md' as MemoryPath;
            const tags = ['beliefs', 'philosophy'];
            const updatedAt = '2024-01-15T10:30:00.000Z';

            const tagKeys = MemoryToolKeyGenerator.createTagKeys(path, tags, updatedAt);

            expect(tagKeys).toEqual({
                GSI2PK: 'TAG#beliefs',
                GSI2SK: 'LAYER#identity#UPDATED#2024-01-15T10:30:00.000Z',
            });
        });

        test('should use first tag only when multiple tags provided', () => {
            const path = '/state/current-context.md' as MemoryPath;
            const tags = ['important', 'urgent', 'active'];
            const updatedAt = '2024-01-15T10:30:00.000Z';

            const tagKeys = MemoryToolKeyGenerator.createTagKeys(path, tags, updatedAt);

            expect(tagKeys).not.toBeNull();
            expect(tagKeys!.GSI2PK).toBe('TAG#important');
        });

        test('should handle path without recognized layer', () => {
            const path = '/unknown/file.md' as MemoryPath;
            const tags = ['test'];
            const updatedAt = '2024-01-15T10:30:00.000Z';

            const tagKeys = MemoryToolKeyGenerator.createTagKeys(path, tags, updatedAt);

            expect(tagKeys).toEqual({
                GSI2PK: 'TAG#test',
                GSI2SK: 'LAYER#unknown#UPDATED#2024-01-15T10:30:00.000Z',
            });
        });

        test('should return null if no tags provided', () => {
            const path = '/identity/core-values.md' as MemoryPath;
            const updatedAt = '2024-01-15T10:30:00.000Z';

            const tagKeys = MemoryToolKeyGenerator.createTagKeys(path, [], updatedAt);

            expect(tagKeys).toBeNull();
        });

        test('should return null if tags array is undefined', () => {
            const path = '/identity/core-values.md' as MemoryPath;
            const updatedAt = '2024-01-15T10:30:00.000Z';

            const tagKeys = MemoryToolKeyGenerator.createTagKeys(path, undefined, updatedAt);

            expect(tagKeys).toBeNull();
        });

        test('should auto-generate timestamp if not provided', () => {
            const path = '/events/meeting.md' as MemoryPath;
            const tags = ['meeting'];
            const beforeCall = new Date().toISOString();

            const tagKeys = MemoryToolKeyGenerator.createTagKeys(path, tags);

            const afterCall = new Date().toISOString();
            expect(tagKeys).not.toBeNull();
            if(!tagKeys?.GSI2SK) {
                throw new Error('tagKeys and GSI2SK should not be null');
            }
            expect(tagKeys.GSI2PK).toBe('TAG#meeting');
            expect(tagKeys.GSI2SK).toMatch(/^LAYER#events#UPDATED#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

            // Extract timestamp from GSI2SK
            // eslint-disable-next-line lodash/prefer-lodash-method -- String.replace is simpler for single replacement
            const timestamp = tagKeys.GSI2SK.replace(/^LAYER#events#UPDATED#/, '');
            expect(timestamp >= beforeCall).toBe(true);
            expect(timestamp <= afterCall).toBe(true);
        });

        test('should handle tags with special characters', () => {
            const path = '/state/work-in-progress.md' as MemoryPath;
            const tags = ['work_in_progress', 'v2.0'];
            const updatedAt = '2024-01-15T10:30:00.000Z';

            const tagKeys = MemoryToolKeyGenerator.createTagKeys(path, tags, updatedAt);

            expect(tagKeys!.GSI2PK).toBe('TAG#work_in_progress');
        });

        test('should extract layer from path correctly', () => {
            const testCases = [
                { path: '/identity/file.md' as MemoryPath, expectedLayer: 'identity' },
                { path: '/state/file.md' as MemoryPath, expectedLayer: 'state' },
                { path: '/events/file.md' as MemoryPath, expectedLayer: 'events' },
                { path: '/other/file.md' as MemoryPath, expectedLayer: 'other' },
            ];

            for(const { path, expectedLayer } of testCases) {
                const tagKeys = MemoryToolKeyGenerator.createTagKeys(path, ['test'], '2024-01-15T10:30:00.000Z');
                expect(tagKeys!.GSI2SK).toContain(`LAYER#${expectedLayer}#`);
            }
        });
    });

    describe('createVersionKeys', () => {
        test('should create version keys with correct PK and SK format', () => {
            const path = '/test/file.md' as MemoryPath;
            const version = 1;
            const timestamp = '2024-01-15T10:30:00.000Z';

            const keys = MemoryToolKeyGenerator.createVersionKeys(path, version, timestamp);

            expect(keys.PK).toBe('DIR#/test');
            expect(keys.SK).toBe('VERSION#1#2024-01-15T10:30:00.000Z');
        });

        test('should create version keys for root-level file', () => {
            const path = '/file.md' as MemoryPath;
            const version = 2;
            const timestamp = '2024-01-20T15:45:00.000Z';

            const keys = MemoryToolKeyGenerator.createVersionKeys(path, version, timestamp);

            expect(keys.PK).toBe('DIR#/');
            expect(keys.SK).toBe('VERSION#2#2024-01-20T15:45:00.000Z');
        });

        test('should create version keys for nested directory', () => {
            const path = '/memories/events/party.xml' as MemoryPath;
            const version = 5;
            const timestamp = '2024-02-10T08:00:00.000Z';

            const keys = MemoryToolKeyGenerator.createVersionKeys(path, version, timestamp);

            expect(keys.PK).toBe('DIR#/memories/events');
            expect(keys.SK).toBe('VERSION#5#2024-02-10T08:00:00.000Z');
        });

        test('should handle large version numbers', () => {
            const path = '/test/file.md' as MemoryPath;
            const version = 999;
            const timestamp = '2024-01-15T10:30:00.000Z';

            const keys = MemoryToolKeyGenerator.createVersionKeys(path, version, timestamp);

            expect(keys.PK).toBe('DIR#/test');
            expect(keys.SK).toBe('VERSION#999#2024-01-15T10:30:00.000Z');
        });
    });

    describe('generateContentPreview', () => {
        test('should return full content when under 100 characters', () => {
            const content = 'Short content';
            const preview = generateContentPreview(content);
            expect(preview).toBe('Short content');
        });

        test('should return full content when exactly 100 characters (kills >= 100 mutation)', () => {
            const content = _repeat('a', 100);
            const preview = generateContentPreview(content);
            // CRITICAL: 100 chars should NOT be truncated (condition is > 100, not >= 100)
            expect(preview).toBe(content);
            expect(preview).toHaveLength(100);
        });

        test('should truncate content of 101 characters to exactly 100', () => {
            const content = _repeat('a', 101);
            const preview = generateContentPreview(content);
            expect(preview).toBe(_repeat('a', 100));
            expect(preview).toHaveLength(100);
        });

        test('should truncate content when over 100 characters', () => {
            const content = _repeat('a', 150);
            const preview = generateContentPreview(content);
            expect(preview).toBe(_repeat('a', 100));
            expect(preview).toHaveLength(100);
        });

        test('should truncate very long content to exactly 100 characters', () => {
            const content = _repeat('x', 500);
            const preview = generateContentPreview(content);
            expect(preview).toBe(_repeat('x', 100));
            expect(preview).toHaveLength(100);
        });

        test('should handle empty string', () => {
            const content = '';
            const preview = generateContentPreview(content);
            expect(preview).toBe('');
        });

        test('should truncate at character boundary, not word boundary', () => {
            const content = _repeat('The quick brown fox jumps over the lazy dog. ', 3); // ~135 chars
            const preview = generateContentPreview(content);
            expect(preview).toHaveLength(100);
        });
    });
});

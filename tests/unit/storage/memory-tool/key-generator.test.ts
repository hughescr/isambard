import { describe, expect, test } from 'bun:test';
import { repeat as _repeat } from 'lodash';
import { MemoryToolKeyGenerator, generateContentPreview } from '@/storage/memory-tool/key-generator';
import type { MemoryPath } from '@/storage/memory-tool/types';

describe.concurrent('MemoryToolKeyGenerator', () => {
    describe('createKeys', () => {
        test.each([
            {
                name:     'root directory',
                path:     '/file.xml' as MemoryPath,
                expected: {
                    PK:     'DIR#/',
                    SK:     'FILE#file.xml',
                    GSI1PK: 'LAYER#file.xml',
                    GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
                },
            },
            {
                name:     'single-level directory',
                path:     '/configs/settings.xml' as MemoryPath,
                expected: {
                    PK:     'DIR#/configs',
                    SK:     'FILE#settings.xml',
                    GSI1PK: 'LAYER#configs',
                    GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
                },
            },
            {
                name:     'nested directory',
                path:     '/memories/events/party.xml' as MemoryPath,
                expected: {
                    PK:     'DIR#/memories/events',
                    SK:     'FILE#party.xml',
                    GSI1PK: 'LAYER#memories',
                    GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
                },
            },
            {
                name:     'identity layer',
                path:     '/identity/core-values.md' as MemoryPath,
                expected: {
                    PK:     'DIR#/identity',
                    SK:     'FILE#core-values.md',
                    GSI1PK: 'LAYER#identity',
                    GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
                },
            },
            {
                name:     'state layer',
                path:     '/state/current.md' as MemoryPath,
                expected: {
                    PK:     'DIR#/state',
                    SK:     'FILE#current.md',
                    GSI1PK: 'LAYER#state',
                    GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
                },
            },
            {
                name:     'events layer',
                path:     '/events/meeting.md' as MemoryPath,
                expected: {
                    PK:     'DIR#/events',
                    SK:     'FILE#meeting.md',
                    GSI1PK: 'LAYER#events',
                    GSI1SK: 'UPDATED#2024-01-15T10:30:00.000Z',
                },
            },
        ])('should create keys for $name', ({ path, expected }) => {
            const timestamp = '2024-01-15T10:30:00.000Z';
            const keys = MemoryToolKeyGenerator.createKeys(path, timestamp);
            expect(keys).toEqual(expected);
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
    });

    describe('parsePath', () => {
        test.each([
            {
                name:     'root-level file',
                pk:       'DIR#/',
                sk:       'FILE#file.xml',
                expected: '/file.xml',
            },
            {
                name:     'single-level directory',
                pk:       'DIR#/configs',
                sk:       'FILE#settings.xml',
                expected: '/configs/settings.xml',
            },
            {
                name:     'nested directory',
                pk:       'DIR#/memories/events',
                sk:       'FILE#party.xml',
                expected: '/memories/events/party.xml',
            },
        ])('should parse keys for $name', ({ pk, sk, expected }) => {
            const path = MemoryToolKeyGenerator.parsePath(pk, sk);
            expect(path).toBe(expected);
        });

        test.each([
            {
                name:     'PK without DIR# prefix',
                pk:       'INVALID#/configs',
                sk:       'FILE#settings.xml',
                expected: 'Invalid PK format: expected DIR#..., got INVALID#/configs',
            },
            {
                name:     'SK without FILE# prefix',
                pk:       'DIR#/configs',
                sk:       'INVALID#settings.xml',
                expected: 'Invalid SK format: expected FILE#..., got INVALID#settings.xml',
            },
            {
                name:     'malformed PK',
                pk:       'DIR',
                sk:       'FILE#settings.xml',
                expected: 'Invalid PK format: expected DIR#..., got DIR',
            },
            {
                name:     'malformed SK',
                pk:       'DIR#/configs',
                sk:       'FILE',
                expected: 'Invalid SK format: expected FILE#..., got FILE',
            },
        ])('should throw error for $name', ({ pk, sk, expected }) => {
            expect(() => MemoryToolKeyGenerator.parsePath(pk, sk)).toThrow(expected);
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

        test.each([
            { name: 'empty array', tags: [] as string[] },
            { name: 'undefined', tags: undefined },
        ])('should return null if tags is $name', ({ tags }) => {
            const path = '/identity/core-values.md' as MemoryPath;
            const updatedAt = '2024-01-15T10:30:00.000Z';

            const tagKeys = MemoryToolKeyGenerator.createTagKeys(path, tags, updatedAt);

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
        test.each([
            {
                name:      'single-level directory',
                path:      '/test/file.md' as MemoryPath,
                version:   1,
                timestamp: '2024-01-15T10:30:00.000Z',
                expected:  { PK: 'DIR#/test', SK: 'VERSION#1#2024-01-15T10:30:00.000Z' },
            },
            {
                name:      'root-level file',
                path:      '/file.md' as MemoryPath,
                version:   2,
                timestamp: '2024-01-20T15:45:00.000Z',
                expected:  { PK: 'DIR#/', SK: 'VERSION#2#2024-01-20T15:45:00.000Z' },
            },
            {
                name:      'nested directory',
                path:      '/memories/events/party.xml' as MemoryPath,
                version:   5,
                timestamp: '2024-02-10T08:00:00.000Z',
                expected:  { PK: 'DIR#/memories/events', SK: 'VERSION#5#2024-02-10T08:00:00.000Z' },
            },
        ])('should create version keys for $name', ({ path, version, timestamp, expected }) => {
            const keys = MemoryToolKeyGenerator.createVersionKeys(path, version, timestamp);
            expect(keys).toEqual(expected);
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

        test.each([
            { length: 101, 'char': 'a' },
            { length: 150, 'char': 'a' },
        ])('should truncate $length characters to exactly 100', ({ length, char }) => {
            const content = _repeat(char, length);
            const preview = generateContentPreview(content);
            expect(preview).toBe(_repeat(char, 100));
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

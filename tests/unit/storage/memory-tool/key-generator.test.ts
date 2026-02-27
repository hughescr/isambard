import { describe, expect, test } from 'bun:test';
import { MemoryToolKeyGenerator, generateContentPreview, normalizeTags } from '@/storage/memory-tool/key-generator';
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

    describe('generateContentPreview', () => {
        test('should return full content when under 100 characters', () => {
            const content = 'Short content';
            const preview = generateContentPreview(content);
            expect(preview).toBe('Short content');
        });

        test('should return full content when exactly 100 characters (kills >= 100 mutation)', () => {
            const content = 'a'.repeat(100);
            const preview = generateContentPreview(content);
            // CRITICAL: 100 chars should NOT be truncated (condition is > 100, not >= 100)
            expect(preview).toBe(content);
            expect(preview).toHaveLength(100);
        });

        test.each([
            { length: 101, 'char': 'a' },
            { length: 150, 'char': 'a' },
        ])('should truncate $length characters to exactly 100', ({ length, char }) => {
            const content = char.repeat(length);
            const preview = generateContentPreview(content);
            expect(preview).toBe(char.repeat(100));
            expect(preview).toHaveLength(100);
        });

        test('should handle empty string', () => {
            const content = '';
            const preview = generateContentPreview(content);
            expect(preview).toBe('');
        });

        test('should truncate at character boundary, not word boundary', () => {
            const content = 'The quick brown fox jumps over the lazy dog. '.repeat(3); // ~135 chars
            const preview = generateContentPreview(content);
            expect(preview).toHaveLength(100);
        });
    });

    describe('normalizeTags', () => {
        test('returns empty Set for undefined', () => {
            expect(normalizeTags(undefined)).toEqual(new Set());
        });

        test('returns empty Set for empty Set', () => {
            expect(normalizeTags(new Set<string>())).toEqual(new Set());
        });

        test('lowercases all tags', () => {
            expect(normalizeTags(new Set(['UPPERCASE', 'MixedCase', 'lowercase']))).toEqual(
                new Set(['uppercase', 'mixedcase', 'lowercase'])
            );
        });

        test('deduplicates tags', () => {
            expect(normalizeTags(new Set(['tag1', 'tag2', 'tag1', 'tag3']))).toEqual(
                new Set(['tag1', 'tag2', 'tag3'])
            );
        });

        test('handles mixed case duplicates', () => {
            expect(normalizeTags(new Set(['Craig', 'craig', 'CRAIG']))).toEqual(new Set(['craig']));
        });
    });

    describe('createTagIndexKeys', () => {
        test('returns empty array for empty tags', () => {
            const result = MemoryToolKeyGenerator.createTagIndexKeys(
                '/identity/core.md' as MemoryPath,
                new Set<string>()
            );
            expect(result).toEqual([]);
        });

        test('returns correct PK/SK for single tag', () => {
            const result = MemoryToolKeyGenerator.createTagIndexKeys(
                '/identity/values.md' as MemoryPath,
                new Set(['important'])
            );
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                PK: 'TAG#important',
                SK: 'PATH#/identity/values.md',
            });
        });

        test('returns correct PK/SK for multiple tags', () => {
            const result = MemoryToolKeyGenerator.createTagIndexKeys(
                '/state/current.md' as MemoryPath,
                new Set(['active', 'priority', 'work'])
            );
            expect(result).toHaveLength(3);
            expect(result[0]).toEqual({
                PK: 'TAG#active',
                SK: 'PATH#/state/current.md',
            });
            expect(result[1]).toEqual({
                PK: 'TAG#priority',
                SK: 'PATH#/state/current.md',
            });
            expect(result[2]).toEqual({
                PK: 'TAG#work',
                SK: 'PATH#/state/current.md',
            });
        });

        test('PK format is TAG#{tag}', () => {
            const result = MemoryToolKeyGenerator.createTagIndexKeys(
                '/test/file.md' as MemoryPath,
                new Set(['mytag'])
            );
            expect(result[0].PK).toMatch(/^TAG#/);
            expect(result[0].PK).toBe('TAG#mytag');
        });

        test('SK format is PATH#{path}', () => {
            const result = MemoryToolKeyGenerator.createTagIndexKeys(
                '/identity/test.md' as MemoryPath,
                new Set(['tag'])
            );
            expect(result[0].SK).toMatch(/^PATH#/);
            expect(result[0].SK).toBe('PATH#/identity/test.md');
        });
    });

    describe('parseTagFromPK', () => {
        test('parses tag correctly from TAG#mytag', () => {
            const tag = MemoryToolKeyGenerator.parseTagFromPK('TAG#mytag');
            expect(tag).toBe('mytag');
        });

        test('parses tag with special characters', () => {
            const tag = MemoryToolKeyGenerator.parseTagFromPK('TAG#my-tag_123');
            expect(tag).toBe('my-tag_123');
        });

        test('throws on invalid format (missing TAG# prefix)', () => {
            expect(() => {
                MemoryToolKeyGenerator.parseTagFromPK('INVALID#mytag');
            }).toThrow('Invalid tag PK format: expected TAG#..., got INVALID#mytag');
        });

        test('throws on empty prefix', () => {
            expect(() => {
                MemoryToolKeyGenerator.parseTagFromPK('mytag');
            }).toThrow('Invalid tag PK format: expected TAG#..., got mytag');
        });
    });

    describe('parsePathFromTagSK', () => {
        test('parses path correctly from PATH#/identity/core.md', () => {
            const path = MemoryToolKeyGenerator.parsePathFromTagSK('PATH#/identity/core.md');
            expect(path).toBe('/identity/core.md');
        });

        test('parses nested paths correctly', () => {
            const path = MemoryToolKeyGenerator.parsePathFromTagSK('PATH#/events/conversation/2024.md');
            expect(path).toBe('/events/conversation/2024.md');
        });

        test('throws on invalid format (missing PATH# prefix)', () => {
            expect(() => {
                MemoryToolKeyGenerator.parsePathFromTagSK('INVALID#/test.md');
            }).toThrow('Invalid tag SK format: expected PATH#..., got INVALID#/test.md');
        });

        test('throws on empty prefix', () => {
            expect(() => {
                MemoryToolKeyGenerator.parsePathFromTagSK('/test.md');
            }).toThrow('Invalid tag SK format: expected PATH#..., got /test.md');
        });
    });
});

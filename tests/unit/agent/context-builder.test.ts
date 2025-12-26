/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import _ from 'lodash';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createContextBuilder } from '../../../src/agent/context-builder';
import { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import { createMemoryPath } from '../../../src/storage/memory-tool/types';

describe('createContextBuilder', () => {
    let mockDocClient: DynamoDBDocumentClient;
    let backend: MemoryToolBackend;

    beforeEach(() => {
        mockDocClient = {} as DynamoDBDocumentClient;
        backend = new MemoryToolBackend(mockDocClient, 'test-table');
    });

    describe('buildSystemContext', () => {
        it('should return empty context when no memories exist', async () => {
            // Mock getAutoLoadItems to return empty array
            backend.getAutoLoadItems = mock(async () => []);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            expect(context).toBe('=== MEMORY CONTEXT ===\n\n(No memories loaded)');
        });

        it('should format identity layer memories', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/identity/core-values.md'),
                    content:     'I value honesty and clarity',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            expect(context).toContain('## Identity');
            expect(context).toContain('I value honesty and clarity');
        });

        it('should format state layer memories as "Current State"', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/state/current-task.md'),
                    content:     'Working on context builder',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            expect(context).toContain('## Current State');
            expect(context).toContain('Working on context builder');
        });

        it('should group memories by layer', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/identity/values.md'),
                    content:     'Core values',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
                {
                    path:        createMemoryPath('/state/task.md'),
                    content:     'Current task',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            expect(context).toContain('## Identity');
            expect(context).toContain('## Current State');
            // Identity section should appear before Current State section
            const identityIndex = context.indexOf('## Identity');
            const stateIndex = context.indexOf('## Current State');
            expect(identityIndex).toBeGreaterThan(-1);
            expect(stateIndex).toBeGreaterThan(-1);
            expect(identityIndex).toBeLessThan(stateIndex);
        });

        it('should truncate content if it exceeds maxIdentityTokens', async () => {
            // Create content that's ~2000 characters (~500 tokens at 4 chars/token)
            const longContent = _.repeat('a', 2000);

            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/identity/long.md'),
                    content:     longContent,
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 100, // Allow only 100 tokens (~400 chars)
            });

            const context = await contextBuilder.buildSystemContext();

            // Context should be truncated and include ellipsis
            expect(context.length).toBeLessThan(longContent.length);
            expect(context).toContain('...');
        });

        it('should truncate content if it exceeds maxStateTokens', async () => {
            const longContent = _.repeat('b', 2000);

            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/state/long.md'),
                    content:     longContent,
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({
                backend,
                maxStateTokens: 100,
            });

            const context = await contextBuilder.buildSystemContext();

            expect(context.length).toBeLessThan(longContent.length);
            expect(context).toContain('...');
        });

        it('should use default token limits when not specified', async () => {
            backend.getAutoLoadItems = mock(async () => []);

            const contextBuilder = createContextBuilder({ backend });

            // Should not throw
            const result = await contextBuilder.buildSystemContext();
            expect(result).toBeDefined();
        });

        it('should correctly calculate character limits from token limits', async () => {
            // At 4 chars/token, 100 tokens = 400 chars
            // Create content that's exactly 401 chars (path + separator + content)
            const path = '/identity/test.md';
            const content = _.repeat('x', 401 - path.length - 2); // -2 for ":\n"

            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath(path),
                    content,
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 100, // 100 * 4 = 400 chars
            });

            const context = await contextBuilder.buildSystemContext();

            // Should be truncated because content exceeds 400 chars
            expect(context).toContain('...');
            // Verify truncation happens at maxChars - 3
            const identitySection = context.split('## Current State')[0];
            const identityContent = identitySection.split('## Identity\n\n')[1] ?? '';
            expect(identityContent.length).toBe(400); // 397 chars + '...' (3 chars)
        });

        it('should use exact token multiplication for character limits', async () => {
            // Test that we're using multiplication, not division
            // With maxIdentityTokens: 50, should allow 50 * 4 = 200 chars
            const path = '/identity/test.md';
            const content = _.repeat('y', 200 - path.length - 2); // Exactly at limit

            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath(path),
                    content,
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 50,
            });

            const context = await contextBuilder.buildSystemContext();

            // Should NOT be truncated at exactly the limit
            expect(context).not.toContain('...');
        });

        it('should format output with exact string structure', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/identity/values.md'),
                    content:     'Core values content',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
                {
                    path:        createMemoryPath('/state/task.md'),
                    content:     'Current task content',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // Verify exact header format
            expect(context).toContain('=== MEMORY CONTEXT ===\n');

            // Verify sections are separated by \n\n
            expect(context).toContain('\n\n## Identity');
            expect(context).toContain('\n\n## Current State');

            // Verify path:content format with \n\n between entries
            expect(context).toContain('/identity/values.md:\nCore values content');
            expect(context).toContain('/state/task.md:\nCurrent task content');
        });

        it('should join memory items with double newlines', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/identity/item1.md'),
                    content:     'First item',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
                {
                    path:        createMemoryPath('/identity/item2.md'),
                    content:     'Second item',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // Items should be separated by \n\n, not just concatenated
            expect(context).toContain('/identity/item1.md:\nFirst item\n\n/identity/item2.md:\nSecond item');
            // Verify NOT joined with empty string
            expect(context).not.toContain('First item/identity/item2.md');
        });

        it('should join state items with double newlines', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/state/item1.md'),
                    content:     'State one',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
                {
                    path:        createMemoryPath('/state/item2.md'),
                    content:     'State two',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // State items should be separated by \n\n
            expect(context).toContain('/state/item1.md:\nState one\n\n/state/item2.md:\nState two');
            // Verify NOT joined with empty string
            expect(context).not.toContain('State one/state/item2.md');
        });

        it('should default grouped layer to "other" when layer is null and not render it', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/unknown/test.md'),
                    content:     'Unknown layer content',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // Should have header but not identity or state sections
            expect(context).toContain('=== MEMORY CONTEXT ===');
            expect(context).not.toContain('## Identity');
            expect(context).not.toContain('## Current State');
            // The content should not appear anywhere since it's in 'other' group
            expect(context).not.toContain('Unknown layer content');
            // Verify we only get header and no sections
            expect(context).toBe('=== MEMORY CONTEXT ===\n');
        });

        it('should require identity array to have length > 0 to render section', async () => {
            // Mock groupBy to return empty array for identity
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/state/task.md'),
                    content:     'State only',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // Identity section should NOT appear
            expect(context).not.toContain('## Identity');
            // State section SHOULD appear
            expect(context).toContain('## Current State');
        });

        it('should require state array to have length > 0 to render section', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/identity/values.md'),
                    content:     'Identity only',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // Identity section SHOULD appear
            expect(context).toContain('## Identity');
            // State section should NOT appear because array is undefined
            expect(context).not.toContain('## Current State');
            // Verify we get header + identity only
            const lines = context.split('\n\n');
            expect(lines.length).toBe(3); // header, Identity, content
        });

        it('should verify both grouped.identity exists AND has length > 0', async () => {
            // When we have only other/unknown layer items, grouped.identity will be undefined
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/other/test.md'),
                    content:     'Other layer',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // Should not render identity section when grouped.identity is undefined
            expect(context).not.toContain('## Identity');
            expect(context).toBe('=== MEMORY CONTEXT ===\n');
        });

        it('should verify both grouped.state exists AND has length > 0', async () => {
            // When we have only identity items, grouped.state will be undefined
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/identity/test.md'),
                    content:     'Identity only',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // Should not render state section when grouped.state is undefined
            expect(context).not.toContain('## Current State');
            expect(context).toContain('## Identity');
        });

        it('should detect when identity section has exactly 1 item (boundary test)', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/identity/single.md'),
                    content:     'Single identity item',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // With 1 item (length = 1 > 0), should render
            expect(context).toContain('## Identity');
            expect(context).toContain('Single identity item');
        });

        it('should detect when state section has exactly 1 item (boundary test)', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/state/single.md'),
                    content:     'Single state item',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // With 1 item (length = 1 > 0), should render
            expect(context).toContain('## Current State');
            expect(context).toContain('Single state item');
        });

        it('should use exactly "other" as grouping key for unknown layers', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/randomlayer/file.md'),
                    content:     'Random content',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
                {
                    path:        createMemoryPath('/identity/known.md'),
                    content:     'Known layer',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // Only identity should be rendered (grouped under "other" is not rendered)
            expect(context).toContain('## Identity');
            expect(context).toContain('Known layer');
            expect(context).not.toContain('Random content');
            // Should not have empty string as a section header
            expect(context).not.toContain('## \n');
            // Count sections - should be exactly 1 (Identity)
            const sectionCount = (context.match(/^## /gm) || []).length;
            expect(sectionCount).toBe(1);
        });

        it('should render exactly 2 sections when both identity and state exist', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/identity/id.md'),
                    content:     'ID',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
                {
                    path:        createMemoryPath('/state/st.md'),
                    content:     'ST',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // Count sections - should be exactly 2
            const sectionCount = (context.match(/^## /gm) || []).length;
            expect(sectionCount).toBe(2);
            expect(context).toContain('## Identity');
            expect(context).toContain('## Current State');
        });

        it('should truncate at exact boundary (maxChars - 3)', async () => {
            // Create content that triggers truncation
            const path = '/identity/test.md';
            // Make content exactly maxIdentityChars + 1 to trigger truncation
            const content = _.repeat('z', 401 - path.length - 2); // 401 total chars

            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath(path),
                    content,
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 100, // 400 chars
            });

            const context = await contextBuilder.buildSystemContext();

            // Extract identity content
            const identitySection = context.split('## Identity\n\n')[1] ?? '';

            // Should be truncated to exactly 400 chars (397 + '...')
            expect(identitySection.length).toBe(400);
            expect(identitySection.endsWith('...')).toBe(true);
            // The content before ... should be exactly maxChars - 3
            expect(identitySection.slice(0, -3).length).toBe(397);
        });

        it('should not truncate when content length equals maxChars exactly', async () => {
            const path = '/state/test.md';
            // Make content exactly maxStateChars (no truncation needed)
            const content = _.repeat('w', 400 - path.length - 2);

            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath(path),
                    content,
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({
                backend,
                maxStateTokens: 100, // 400 chars
            });

            const context = await contextBuilder.buildSystemContext();

            // Should NOT be truncated when exactly at limit
            expect(context).not.toContain('...');
        });

        it('should use default maxStateTokens when options.maxStateTokens is undefined', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/state/test.md'),
                    content:     _.repeat('x', 1500), // Large content
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            // Don't provide maxStateTokens - should use default of 300 tokens = 1200 chars
            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 500,
                // maxStateTokens intentionally undefined
            });

            const context = await contextBuilder.buildSystemContext();

            // Should be truncated using default limit (300 tokens = 1200 chars)
            expect(context).toContain('...');
            const stateSection = context.split('## Current State\n\n')[1] ?? '';
            // Should be truncated to 1200 chars (default 300 tokens * 4)
            expect(stateSection.length).toBe(1200);
        });

        it('should use provided maxStateTokens when explicitly set to 0', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/state/test.md'),
                    content:     'Any content',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            // Explicitly set to 0 - should use 0, not default
            const contextBuilder = createContextBuilder({
                backend,
                maxStateTokens: 0,
            });

            const context = await contextBuilder.buildSystemContext();

            // With 0 tokens (0 chars), content should be truncated with '...'
            // The path:content will still be included but truncated
            const stateSection = context.split('## Current State\n\n')[1] ?? '';
            expect(stateSection).toContain('...');
            expect(stateSection.endsWith('...')).toBe(true);
        });
    });

    describe('recordAccess', () => {
        it('should update accessCount for a single path', async () => {
            const path = createMemoryPath('/state/task.md');

            backend.get = mock(async () => ({
                path,
                content:     'Test content',
                contentType: 'text/markdown' as const,
                metadata:    { accessCount: 5 },
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            backend.update = mock(async () => ({
                path,
                content:     'Test content',
                contentType: 'text/markdown' as const,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                metadata:    { accessCount: 6, lastAccessed: expect.any(String) },
                version:     2,
                createdAt:   '2025-01-01T00:00:00Z',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                updatedAt:   expect.any(String),
            }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.recordAccess([path]);

            expect(backend.update).toHaveBeenCalledWith(
                path,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                    metadata: expect.objectContaining({
                        accessCount:  6,
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                        lastAccessed: expect.any(String),
                    }),
                })
            );
        });

        it('should initialize accessCount to 1 if not present', async () => {
            const path = createMemoryPath('/state/new.md');

            backend.get = mock(async () => ({
                path,
                content:     'New content',
                contentType: 'text/markdown' as const,
                metadata:    {},
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            backend.update = mock(async () => ({
                path,
                content:     'New content',
                contentType: 'text/markdown' as const,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                metadata:    { accessCount: 1, lastAccessed: expect.any(String) },
                version:     2,
                createdAt:   '2025-01-01T00:00:00Z',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                updatedAt:   expect.any(String),
            }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.recordAccess([path]);

            expect(backend.update).toHaveBeenCalledWith(
                path,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                    metadata: expect.objectContaining({
                        accessCount:  1,
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                        lastAccessed: expect.any(String),
                    }),
                })
            );
        });

        it('should update multiple paths', async () => {
            const path1 = createMemoryPath('/state/task1.md');
            const path2 = createMemoryPath('/state/task2.md');

            backend.get = mock(async (p: typeof path1) => ({
                path:        p,
                content:     'Content',
                contentType: 'text/markdown' as const,
                metadata:    { accessCount: 1 },
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            backend.update = mock(async () => ({
                path:        path1,
                content:     'Content',
                contentType: 'text/markdown' as const,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                metadata:    { accessCount: 2, lastAccessed: expect.any(String) },
                version:     2,
                createdAt:   '2025-01-01T00:00:00Z',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                updatedAt:   expect.any(String),
            }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.recordAccess([path1, path2]);

            expect(backend.update).toHaveBeenCalledTimes(2);
        });

        it('should handle empty path array', async () => {
            backend.update = mock(async () => {
                throw new Error('Should not be called');
            });

            const contextBuilder = createContextBuilder({ backend });

            // Should not throw
            await contextBuilder.recordAccess([]);
            expect(backend.update).not.toHaveBeenCalled();
        });

        it('should skip paths that do not exist', async () => {
            const path = createMemoryPath('/state/nonexistent.md');

            backend.get = mock(async () => undefined);
            backend.update = mock(async () => {
                throw new Error('Should not be called');
            });

            const contextBuilder = createContextBuilder({ backend });

            // Should not throw
            await contextBuilder.recordAccess([path]);
            expect(backend.update).not.toHaveBeenCalled();
        });

        it('should handle metadata being undefined when checking accessCount', async () => {
            const path = createMemoryPath('/state/task.md');

            // Item with no metadata field at all
            backend.get = mock(async () => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as const,
                metadata:    {}, // Empty metadata object
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            backend.update = mock(async () => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as const,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                metadata:    { accessCount: 1, lastAccessed: expect.any(String) },
                version:     2,
                createdAt:   '2025-01-01T00:00:00Z',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                updatedAt:   expect.any(String),
            }));

            const contextBuilder = createContextBuilder({ backend });

            // Should not throw when metadata is undefined
            await contextBuilder.recordAccess([path]);

            // Should initialize accessCount to 1
            expect(backend.update).toHaveBeenCalledWith(
                path,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                    metadata: expect.objectContaining({
                        accessCount:  1,
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                        lastAccessed: expect.any(String),
                    }),
                })
            );
        });

        it('should handle metadata.accessCount being non-numeric', async () => {
            const path = createMemoryPath('/state/task.md');

            backend.get = mock(async () => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as const,
                metadata:    { accessCount: 'invalid' }, // Non-numeric value
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            backend.update = mock(async () => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as const,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                metadata:    { accessCount: 1, lastAccessed: expect.any(String) },
                version:     2,
                createdAt:   '2025-01-01T00:00:00Z',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                updatedAt:   expect.any(String),
            }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.recordAccess([path]);

            // Should treat non-numeric as 0 and set to 1
            expect(backend.update).toHaveBeenCalledWith(
                path,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                    metadata: expect.objectContaining({
                        accessCount:  1,
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                        lastAccessed: expect.any(String),
                    }),
                })
            );
        });

        it('should handle item with metadata that has undefined accessCount (optional chaining test)', async () => {
            const path = createMemoryPath('/state/task.md');

            // Metadata exists but doesn't have accessCount property
            backend.get = mock(async () => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as const,
                metadata:    { otherField: 'value' }, // accessCount not present
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            backend.update = mock(async () => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as const,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                metadata:    { otherField: 'value', accessCount: 1, lastAccessed: expect.any(String) },
                version:     2,
                createdAt:   '2025-01-01T00:00:00Z',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                updatedAt:   expect.any(String),
            }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.recordAccess([path]);

            // Should initialize accessCount to 1 and preserve other metadata
            expect(backend.update).toHaveBeenCalledWith(
                path,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                    metadata: expect.objectContaining({
                        otherField:   'value',
                        accessCount:  1,
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                        lastAccessed: expect.any(String),
                    }),
                })
            );
        });

        it('should safely handle undefined metadata.accessCount with optional chaining', async () => {
            const path = createMemoryPath('/state/task.md');

            // Item where metadata.accessCount is undefined but metadata exists
            backend.get = mock(async () => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as const,
                metadata:    { someOtherProp: 'value' }, // accessCount is undefined
                version:     1,
                createdAt:   '2025-01-01T00:00:00Z',
                updatedAt:   '2025-01-01T00:00:00Z',
            }));

            backend.update = mock(async () => ({
                path,
                content:     'Content',
                contentType: 'text/markdown' as const,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                metadata:    { someOtherProp: 'value', accessCount: 1, lastAccessed: expect.any(String) },
                version:     2,
                createdAt:   '2025-01-01T00:00:00Z',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                updatedAt:   expect.any(String),
            }));

            const contextBuilder = createContextBuilder({ backend });

            // Should not throw when accessCount is undefined
            await contextBuilder.recordAccess([path]);

            // Should initialize accessCount to 1
            expect(backend.update).toHaveBeenCalledWith(
                path,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.objectContaining for dynamic type
                    metadata: expect.objectContaining({
                        someOtherProp: 'value',
                        accessCount:   1,
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() for dynamic type
                        lastAccessed:  expect.any(String),
                    }),
                })
            );
        });
    });

    describe('loadCoreIdentity', () => {
        it('should return empty string when no identity items exist', async () => {
            backend.listByLayer = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const identity = await contextBuilder.loadCoreIdentity();

            expect(identity).toBe('');
            // Verify we don't attempt to join/process empty array
            expect(identity).not.toContain('\n\n');
            expect(identity.length).toBe(0);
            // Verify it's exactly empty string, not undefined or other falsy value
            expect(typeof identity).toBe('string');
            expect(identity === '').toBe(true);
        });

        it('should join identity items with double newlines', async () => {
            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/item1.md'),
                        content:     'First identity',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                    {
                        path:        createMemoryPath('/identity/item2.md'),
                        content:     'Second identity',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const identity = await contextBuilder.loadCoreIdentity();

            // Should join with \n\n, not empty string
            expect(identity).toBe('First identity\n\nSecond identity');
            // Verify NOT joined with empty string
            expect(identity).not.toBe('First identitySecond identity');
        });

        it('should truncate content with ellipsis when exceeding maxIdentityChars', async () => {
            const longContent = _.repeat('x', 3000);

            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/long.md'),
                        content:     longContent,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 100, // 400 chars
            });

            const identity = await contextBuilder.loadCoreIdentity();

            // Should be truncated to maxChars - 3 + '...'
            expect(identity.length).toBe(400);
            expect(identity.endsWith('...')).toBe(true);
            // Verify exactly 3 chars for ellipsis
            expect(identity.slice(-3)).toBe('...');
        });

        it('should use exactly slice(0, maxIdentityChars - 3) for truncation', async () => {
            const content = _.repeat('y', 500);

            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/test.md'),
                        content,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 100, // 400 chars
            });

            const identity = await contextBuilder.loadCoreIdentity();

            // Verify exact truncation: slice(0, 397) + '...'
            expect(identity.length).toBe(400);
            const contentPart = identity.slice(0, -3);
            expect(contentPart.length).toBe(397);
            expect(contentPart).toBe(_.repeat('y', 397));
        });

        it('should NOT truncate when content equals maxIdentityChars exactly', async () => {
            const content = _.repeat('z', 400);

            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/exact.md'),
                        content,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 100, // 400 chars
            });

            const identity = await contextBuilder.loadCoreIdentity();

            // Should NOT add ellipsis when exactly at limit
            expect(identity).toBe(content);
            expect(identity).not.toContain('...');
        });

        it('should NOT truncate when content is less than maxIdentityChars', async () => {
            const content = _.repeat('w', 300);

            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/short.md'),
                        content,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 100, // 400 chars
            });

            const identity = await contextBuilder.loadCoreIdentity();

            // Should return content as-is
            expect(identity).toBe(content);
            expect(identity).not.toContain('...');
        });

        it('should handle single character over limit (boundary test)', async () => {
            const content = _.repeat('a', 401);

            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/boundary.md'),
                        content,
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({
                backend,
                maxIdentityTokens: 100, // 400 chars
            });

            const identity = await contextBuilder.loadCoreIdentity();

            // Even 1 char over should trigger truncation
            expect(identity.length).toBe(400);
            expect(identity.endsWith('...')).toBe(true);
        });

        it('should extract content from each item correctly', async () => {
            backend.listByLayer = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/identity/a.md'),
                        content:     'Content A',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                    {
                        path:        createMemoryPath('/identity/b.md'),
                        content:     'Content B',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const identity = await contextBuilder.loadCoreIdentity();

            // Verify each item's content is extracted
            expect(identity).toContain('Content A');
            expect(identity).toContain('Content B');
        });
    });

    describe('loadRecentContext', () => {
        it('should load recent context for a specific user', async () => {
            const userId = 'user123';

            backend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/state/recent1.md'),
                        content:     'Recent memory 1',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.loadRecentContext(userId);

            expect(backend.searchByTag).toHaveBeenCalledWith('user:user123', undefined, { limit: 3 });
            expect(context).toEqual(['Recent memory 1']);
        });

        it('should use default limit of 3', async () => {
            backend.searchByTag = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentContext('user456');

            expect(backend.searchByTag).toHaveBeenCalledWith('user:user456', undefined, { limit: 3 });
        });

        it('should use custom limit when provided', async () => {
            backend.searchByTag = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentContext('user789', 10);

            expect(backend.searchByTag).toHaveBeenCalledWith('user:user789', undefined, { limit: 10 });
        });

        it('should format user tag correctly in search', async () => {
            backend.searchByTag = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            await contextBuilder.loadRecentContext('test-user');

            // Verify exact tag format: "user:${userId}"
            expect(backend.searchByTag).toHaveBeenCalledWith('user:test-user', undefined, { limit: 3 });
        });

        it('should extract content from all returned items', async () => {
            backend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/state/item1.md'),
                        content:     'Memory 1',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                    {
                        path:        createMemoryPath('/state/item2.md'),
                        content:     'Memory 2',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                    {
                        path:        createMemoryPath('/state/item3.md'),
                        content:     'Memory 3',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.loadRecentContext('user-multi');

            expect(context).toEqual(['Memory 1', 'Memory 2', 'Memory 3']);
            expect(context.length).toBe(3);
        });

        it('should return empty array when no items found', async () => {
            backend.searchByTag = mock(async () => ({ items: [] }));

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.loadRecentContext('user-empty');

            expect(context).toEqual([]);
        });

        it('should map each item to its content field', async () => {
            backend.searchByTag = mock(async () => ({
                items: [
                    {
                        path:        createMemoryPath('/state/a.md'),
                        content:     'Content A',
                        contentType: 'text/markdown' as const,
                        metadata:    { extra: 'data' },
                        version:     1,
                        createdAt:   '2025-01-01T00:00:00Z',
                        updatedAt:   '2025-01-01T00:00:00Z',
                    },
                ],
            }));

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.loadRecentContext('user-map');

            // Should only contain content, not whole item
            expect(context).toEqual(['Content A']);
        });
    });
});

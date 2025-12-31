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
            const identitySection = _.split(context, '## Current State')[0];
            const identityContent = _.split(identitySection, '## Identity\n\n')[1] ?? '';
            expect(_.size(identityContent)).toBe(400); // 397 chars + '...' (3 chars)
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

            // Verify header is present (flexible about trailing whitespace)
            expect(context).toMatch(/=== MEMORY CONTEXT ===/);

            // Verify sections exist with proper headers
            expect(context).toMatch(/## Identity/);
            expect(context).toMatch(/## Current State/);

            // Verify path:content format exists (flexible about exact whitespace)
            expect(context).toMatch(/\/identity\/values\.md:[\s\S]*Core values content/);
            expect(context).toMatch(/\/state\/task\.md:[\s\S]*Current task content/);
        });

        it('should join multiple identity items with double newlines', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/identity/item1.md'),
                    content:     'Identity content 1',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
                {
                    path:        createMemoryPath('/identity/item2.md'),
                    content:     'Identity content 2',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // Multiple identity items should both be present with path:content format
            expect(context).toMatch(/\/identity\/item1\.md:[\s\S]*Identity content 1/);
            expect(context).toMatch(/\/identity\/item2\.md:[\s\S]*Identity content 2/);
            // Verify item1 appears before item2 (ordering preserved)
            expect(context.indexOf('Identity content 1')).toBeLessThan(context.indexOf('Identity content 2'));
            // Verify they are separated by whitespace (at least one blank line)
            const betweenContent = context.slice(
                context.indexOf('Identity content 1') + 'Identity content 1'.length,
                context.indexOf('Identity content 2')
            );
            expect(betweenContent).toMatch(/\n\s*\n/);
        });

        it('should join multiple state items with double newlines', async () => {
            backend.getAutoLoadItems = mock(async () => [
                {
                    path:        createMemoryPath('/state/task1.md'),
                    content:     'State content 1',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
                {
                    path:        createMemoryPath('/state/task2.md'),
                    content:     'State content 2',
                    contentType: 'text/markdown' as const,
                    metadata:    {},
                    version:     1,
                    createdAt:   '2025-01-01T00:00:00Z',
                    updatedAt:   '2025-01-01T00:00:00Z',
                },
            ]);

            const contextBuilder = createContextBuilder({ backend });
            const context = await contextBuilder.buildSystemContext();

            // Multiple state items should both be present with path:content format
            expect(context).toMatch(/\/state\/task1\.md:[\s\S]*State content 1/);
            expect(context).toMatch(/\/state\/task2\.md:[\s\S]*State content 2/);
            // Verify task1 appears before task2 (ordering preserved)
            expect(context.indexOf('State content 1')).toBeLessThan(context.indexOf('State content 2'));
            // Verify they are separated by whitespace (at least one blank line)
            const betweenContent = context.slice(
                context.indexOf('State content 1') + 'State content 1'.length,
                context.indexOf('State content 2')
            );
            expect(betweenContent).toMatch(/\n\s*\n/);
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
            const lines = _.split(context, '\n\n');
            expect(_.size(lines)).toBe(3); // header, Identity, content
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
            const sectionCount = (context.match(/^## /gm) ?? []).length;
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
            const sectionCount = (context.match(/^## /gm) ?? []).length;
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
            const identitySection = _.split(context, '## Identity\n\n')[1] ?? '';

            // Should be truncated to exactly 400 chars (397 + '...')
            expect(_.size(identitySection)).toBe(400);
            expect(_.endsWith(identitySection, '...')).toBe(true);
            // The content before ... should be exactly maxChars - 3
            expect(_.size(identitySection.slice(0, -3))).toBe(397);
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
            const stateSection = _.split(context, '## Current State\n\n')[1] ?? '';
            // Should be truncated to 1200 chars (default 300 tokens * 4)
            expect(_.size(stateSection)).toBe(1200);
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
            const stateSection = _.split(context, '## Current State\n\n')[1] ?? '';
            expect(stateSection).toContain('...');
            expect(_.endsWith(stateSection, '...')).toBe(true);
        });
    });
});

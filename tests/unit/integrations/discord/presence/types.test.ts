import { describe, test, expect } from 'bun:test';
import { ToolDescriptions } from '@/agent/session/synopsis-generator';
import { ToolStatusMap } from '@/integrations/discord/presence/types';

// ToolDescriptions and getToolDescription moved to the session core with the turn synopsis
// generator (#39); their own tests live in tests/unit/agent/session/synopsis-generator.test.ts.
describe.concurrent('types.ts', () => {
    describe('ToolStatusMap vs ToolDescriptions alignment', () => {
        test('should have ToolDescriptions entries for all memory tools in ToolStatusMap', () => {
            // All memory tools in ToolStatusMap should have descriptions

            const memoryTools = Object.keys(ToolStatusMap).filter(k => k.startsWith('mcp__memory__'));
            for(const tool of memoryTools) {
                expect(ToolDescriptions[tool]).toBeDefined();
            }
        });
    });

    describe('ToolStatusMap string literal values', () => {
        // Kill StringLiteral mutants on lines 85, 86, 87
        test('should have non-empty string values for all memory tools', () => {
            expect(ToolStatusMap.mcp__memory__storeUserMemory).toBe('Recording user memory...');
            expect(ToolStatusMap.mcp__memory__storeUserMemory).not.toBe('');
            expect(ToolStatusMap.mcp__memory__storeUserMemory.length).toBeGreaterThan(0);

            expect(ToolStatusMap.mcp__memory__logEvent).toBe('Logging event...');
            expect(ToolStatusMap.mcp__memory__logEvent).not.toBe('');
            expect(ToolStatusMap.mcp__memory__logEvent.length).toBeGreaterThan(0);

            expect(ToolStatusMap.mcp__memory__search).toBe('Searching memories...');
            expect(ToolStatusMap.mcp__memory__search).not.toBe('');
            expect(ToolStatusMap.mcp__memory__search.length).toBeGreaterThan(0);
        });

        test('should have distinct values for each tool (not all empty strings)', () => {
            const values = [
                ToolStatusMap.mcp__memory__storeUserMemory,
                ToolStatusMap.mcp__memory__logEvent,
                ToolStatusMap.mcp__memory__search
            ];

            // All should be non-empty
            for(const value of values) {
                expect(value).not.toBe('');
            }

            // All should be distinct
            const uniqueValues = new Set(values);
            expect(uniqueValues.size).toBe(values.length);
        });

        test('should provide meaningful status text in nullish coalescing chain (not empty string)', () => {
            // Simulate how ToolStatusMap is used in status-generator-active.ts
            // const statusText = ToolStatusMap[phase.toolName] ?? 'Working...';
            const resolveStatus = (toolStatus: string | undefined): string => toolStatus ?? 'Working...';
            const statusForStoreUserMemory = resolveStatus(ToolStatusMap.mcp__memory__storeUserMemory);
            const statusForLogEvent = resolveStatus(ToolStatusMap.mcp__memory__logEvent);
            const statusForSearch = resolveStatus(ToolStatusMap.mcp__memory__search);

            // Verify the values are meaningful (not empty strings)
            // These assertions kill the StringLiteral mutants on lines 85, 86, 87
            expect(statusForStoreUserMemory).toBe('Recording user memory...');
            expect(statusForLogEvent).toBe('Logging event...');
            expect(statusForSearch).toBe('Searching memories...');

            // If they were empty strings, they would still be used (not fall through to 'Working...')
            // but that would be a bug - we want meaningful status text
            expect(statusForStoreUserMemory).not.toBe('');
            expect(statusForLogEvent).not.toBe('');
            expect(statusForSearch).not.toBe('');

            // Verify each character is correct (to catch partial mutations)
            expect(statusForStoreUserMemory[0]).toBe('R');
            expect(statusForStoreUserMemory[statusForStoreUserMemory.length - 1]).toBe('.');
            expect(statusForLogEvent[0]).toBe('L');
            expect(statusForLogEvent[statusForLogEvent.length - 1]).toBe('.');
            expect(statusForSearch[0]).toBe('S');
            expect(statusForSearch[statusForSearch.length - 1]).toBe('.');
        });
    });
});

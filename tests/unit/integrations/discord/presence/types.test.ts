import { describe, test, expect } from 'bun:test';
import _ from 'lodash';
import {
    getToolDescription,
    ToolDescriptions,
    ToolStatusMap
} from '@/integrations/discord/presence/types';

describe.concurrent('types.ts', () => {
    describe('ToolDescriptions', () => {
        test('should contain descriptions for all memory tools', () => {
            expect(ToolDescriptions.mcp__memory__view).toBe('Reading from memory storage');
            expect(ToolDescriptions.mcp__memory__search).toBe('Searching through memories');
            expect(ToolDescriptions.mcp__memory__storeSelf).toBe('Storing self-knowledge');
            expect(ToolDescriptions.mcp__memory__storeUserMemory).toBe('Recording user preferences');
            expect(ToolDescriptions.mcp__memory__logEvent).toBe('Logging an event');
        });

        test('should contain description for Discord tools', () => {
            expect(ToolDescriptions.mcp__discord__searchMessages).toBe('Searching Discord history');
        });

        test('should contain descriptions for file operation tools', () => {
            expect(ToolDescriptions.Read).toBe('Reading a file');
            expect(ToolDescriptions.Glob).toBe('Finding files by pattern');
            expect(ToolDescriptions.Grep).toBe('Searching file contents');
        });

        test('should contain descriptions for web tools', () => {
            expect(ToolDescriptions.WebSearch).toBe('Searching the web');
            expect(ToolDescriptions.WebFetch).toBe('Fetching a webpage');
        });

        test('should contain descriptions for execution tools', () => {
            expect(ToolDescriptions.Bash).toBe('Running a command');
            expect(ToolDescriptions.Task).toBe('Delegating to a sub-agent');
        });

        test('should have the correct number of tool descriptions', () => {
            expect(_.keys(ToolDescriptions)).toHaveLength(13);
        });
    });

    describe('getToolDescription', () => {
        describe('when toolName is undefined', () => {
            test('should return undefined', () => {
                expect(getToolDescription(undefined)).toBeUndefined();
            });
        });

        describe('when toolName is empty string', () => {
            test('should return undefined', () => {
                expect(getToolDescription('')).toBeUndefined();
            });
        });

        describe('when toolName is a known tool', () => {
            test('should return the description for Read', () => {
                expect(getToolDescription('Read')).toBe('Reading a file');
            });

            test('should return the description for mcp__memory__view', () => {
                expect(getToolDescription('mcp__memory__view')).toBe('Reading from memory storage');
            });

            test('should return the description for WebSearch', () => {
                expect(getToolDescription('WebSearch')).toBe('Searching the web');
            });
        });

        describe('when toolName is an unknown tool', () => {
            test('should return undefined for unknown_tool', () => {
                expect(getToolDescription('unknown_tool')).toBeUndefined();
            });

            test('should return undefined for a typo', () => {
                expect(getToolDescription('mcp__memory__views')).toBeUndefined();
            });
        });
    });

    describe('ToolStatusMap vs ToolDescriptions alignment', () => {
        test('should have ToolDescriptions entries for all memory tools in ToolStatusMap', () => {
            // All memory tools in ToolStatusMap should have descriptions
            const memoryTools = _(ToolStatusMap).keys().filter(k => _.startsWith(k, 'mcp__memory__')).value();
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
            // const statusText = phase.generatedStatus ?? ToolStatusMap[phase.toolName] ?? 'Working...';

            // When generatedStatus is undefined, should use ToolStatusMap value
            // Nullish coalescing (??) only checks for null/undefined, not falsy values
            // So even empty string would be used if that's the value in the map
            const generatedStatus: string | undefined = undefined;
            const statusForStoreUserMemory = generatedStatus ?? ToolStatusMap.mcp__memory__storeUserMemory ?? 'Working...';
            const statusForLogEvent = generatedStatus ?? ToolStatusMap.mcp__memory__logEvent ?? 'Working...';
            const statusForSearch = generatedStatus ?? ToolStatusMap.mcp__memory__search ?? 'Working...';

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

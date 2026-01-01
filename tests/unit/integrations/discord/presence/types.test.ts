import { describe, it, expect } from 'bun:test';
import _ from 'lodash';
import {
    getToolDescription,
    ToolDescriptions,
    ToolStatusMap
} from '@/integrations/discord/presence/types';

describe('types.ts', () => {
    describe('ToolDescriptions', () => {
        it('should contain descriptions for all memory tools', () => {
            expect(ToolDescriptions.mcp__memory__view).toBe('Reading from memory storage');
            expect(ToolDescriptions.mcp__memory__search).toBe('Searching through memories');
            expect(ToolDescriptions.mcp__memory__storeSelf).toBe('Storing self-knowledge');
            expect(ToolDescriptions.mcp__memory__storeUserMemory).toBe('Recording user preferences');
            expect(ToolDescriptions.mcp__memory__logEvent).toBe('Logging an event');
        });

        it('should contain description for Discord tools', () => {
            expect(ToolDescriptions.mcp__discord__searchMessages).toBe('Searching Discord history');
        });

        it('should contain descriptions for file operation tools', () => {
            expect(ToolDescriptions.Read).toBe('Reading a file');
            expect(ToolDescriptions.Glob).toBe('Finding files by pattern');
            expect(ToolDescriptions.Grep).toBe('Searching file contents');
        });

        it('should contain descriptions for web tools', () => {
            expect(ToolDescriptions.WebSearch).toBe('Searching the web');
            expect(ToolDescriptions.WebFetch).toBe('Fetching a webpage');
        });

        it('should contain descriptions for execution tools', () => {
            expect(ToolDescriptions.Bash).toBe('Running a command');
            expect(ToolDescriptions.Task).toBe('Delegating to a sub-agent');
        });

        it('should have the correct number of tool descriptions', () => {
            expect(_.keys(ToolDescriptions)).toHaveLength(13);
        });
    });

    describe('getToolDescription', () => {
        describe('when toolName is undefined', () => {
            it('should return undefined', () => {
                expect(getToolDescription(undefined)).toBeUndefined();
            });
        });

        describe('when toolName is empty string', () => {
            it('should return undefined', () => {
                expect(getToolDescription('')).toBeUndefined();
            });
        });

        describe('when toolName is a known tool', () => {
            it('should return the description for Read', () => {
                expect(getToolDescription('Read')).toBe('Reading a file');
            });

            it('should return the description for mcp__memory__view', () => {
                expect(getToolDescription('mcp__memory__view')).toBe('Reading from memory storage');
            });

            it('should return the description for WebSearch', () => {
                expect(getToolDescription('WebSearch')).toBe('Searching the web');
            });
        });

        describe('when toolName is an unknown tool', () => {
            it('should return undefined for unknown_tool', () => {
                expect(getToolDescription('unknown_tool')).toBeUndefined();
            });

            it('should return undefined for a typo', () => {
                expect(getToolDescription('mcp__memory__views')).toBeUndefined();
            });
        });
    });

    describe('ToolStatusMap vs ToolDescriptions alignment', () => {
        it('should have ToolDescriptions entries for all memory tools in ToolStatusMap', () => {
            // All memory tools in ToolStatusMap should have descriptions
            const memoryTools = _(ToolStatusMap).keys().filter(k => _.startsWith(k, 'mcp__memory__')).value();
            for(const tool of memoryTools) {
                expect(ToolDescriptions[tool]).toBeDefined();
            }
        });
    });
});

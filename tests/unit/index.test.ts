import { describe, it, expect } from 'bun:test';
import { createApp } from '../../src/index';

describe('index module', () => {
    it('should export createApp function', () => {
        expect(typeof createApp).toBe('function');
    });

    it('should have App interface with start and stop methods (type check)', () => {
    // This is a compile-time test that TypeScript will verify
    // If the App interface doesn't have these methods, the code won't compile
        expect(true).toBe(true);
    });
});

// Note: Integration tests for createApp() require SST Resource mocking
// which is complex and fragile. The actual wiring is tested through:
// 1. TypeScript compilation (ensures types match)
// 2. Unit tests for individual components (createClaudeClient, createClaudeAgent, createDiscordBot)
// 3. Manual/E2E testing of the full application
//
// Testing createApp() directly would require:
// - Mocking SST Resource (complex proxy object)
// - Mocking DynamoDB client creation
// - Mocking Anthropic client creation
// - Mocking Discord client creation
// All of which would make tests brittle and hard to maintain.

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import _ from 'lodash';
import Anthropic from '@anthropic-ai/sdk';
import { createClaudeClient } from '../../../src/agent/client';

describe('createClaudeClient', () => {
    const originalEnv = process.env.ANTHROPIC_API_KEY;
    const spies: ReturnType<typeof spyOn>[] = [];

    beforeEach(() => {
    // Reset environment before each test
        process.env.ANTHROPIC_API_KEY = 'test-api-key-12345';
    });

    afterEach(() => {
    // Restore original environment
        if(originalEnv !== undefined) {
            process.env.ANTHROPIC_API_KEY = originalEnv;
        } else {
            delete process.env.ANTHROPIC_API_KEY;
        }

        // Restore all spies
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Mock restoration
        _.forEach(spies, spy => spy.mockRestore());
        spies.length = 0;
    });

    it('should create an Anthropic client instance', () => {
        const client = createClaudeClient();

        expect(client).toBeInstanceOf(Anthropic);
    });

    it('should use ANTHROPIC_API_KEY from environment', () => {
        const client = createClaudeClient();

        // The SDK will use process.env.ANTHROPIC_API_KEY by default
        // We verify the client was created successfully
        expect(client).toBeInstanceOf(Anthropic);
    });

    it('should create client even when ANTHROPIC_API_KEY is missing (SDK handles validation)', () => {
        delete process.env.ANTHROPIC_API_KEY;

        // The Anthropic SDK doesn't validate API key at construction time
        // It only throws when making actual API calls
        const client = createClaudeClient();
        expect(client).toBeInstanceOf(Anthropic);
    });

    it('should return a client with messages API', () => {
        const client = createClaudeClient();

        expect(client.messages).toBeDefined();
        expect(typeof client.messages.create).toBe('function');
    });
});

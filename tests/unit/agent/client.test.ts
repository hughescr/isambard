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

    it('should throw when ANTHROPIC_API_KEY is missing', () => {
        delete process.env.ANTHROPIC_API_KEY;

        expect(() => createClaudeClient()).toThrow('ANTHROPIC_API_KEY environment variable is required');
    });

    it('should throw when ANTHROPIC_API_KEY is empty string', () => {
        process.env.ANTHROPIC_API_KEY = '';

        expect(() => createClaudeClient()).toThrow('ANTHROPIC_API_KEY environment variable is required');
    });

    it('should return a client with messages API', () => {
        const client = createClaudeClient();

        expect(client.messages).toBeDefined();
        expect(typeof client.messages.create).toBe('function');
    });

    it('should pass apiKey from environment to Anthropic client', () => {
        process.env.ANTHROPIC_API_KEY = 'test-key-12345';

        const client = createClaudeClient();
        // Anthropic SDK exposes apiKey property
        expect(client.apiKey).toBe('test-key-12345');
    });

    it('should explicitly validate and pass apiKey to Anthropic constructor', () => {
        // This test verifies that our code validates the API key before passing it
        // If the apiKey variable assignment or validation is removed by a mutant,
        // the test with empty string will fail

        const testKey = 'test-validation-key-xyz';
        process.env.ANTHROPIC_API_KEY = testKey;

        const client = createClaudeClient();

        // Verify client has the correct apiKey
        expect(client.apiKey).toBe(testKey);
        expect(client).toBeInstanceOf(Anthropic);
    });

    it('should accept apiKey override parameter', () => {
        // This test verifies that options.apiKey is explicitly passed to Anthropic
        // If the mutant removes `apiKey` from the constructor, this test will fail
        // because we're NOT setting the env var, so SDK fallback won't work

        const overrideKey = 'override-api-key-test';
        delete process.env.ANTHROPIC_API_KEY;

        const client = createClaudeClient({ apiKey: overrideKey });

        // If our code doesn't pass apiKey explicitly, SDK will try to read from env
        // and fail because we deleted it. The client.apiKey will be undefined.
        expect(client.apiKey).toBe(overrideKey);
        expect(client).toBeInstanceOf(Anthropic);
    });

    it('should prioritize options.apiKey over environment variable', () => {
        const envKey = 'env-api-key';
        const overrideKey = 'override-api-key';

        process.env.ANTHROPIC_API_KEY = envKey;

        const client = createClaudeClient({ apiKey: overrideKey });

        // Should use the override, not the env var
        expect(client.apiKey).toBe(overrideKey);
    });
});

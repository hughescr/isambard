/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks require unsafe calls */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- Test mocks */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ActivityType } from 'discord.js';
import { constant as _constant, repeat as _repeat, size as _size } from 'lodash';
import { createIdleStatusGenerator } from '@/integrations/discord/presence/status-generator-idle';

// Mock generateText module
const mockGenerateText = mock<(prompt: string) => Promise<string>>(_constant(Promise.resolve('Dozing peacefully')));
void mock.module('@/agent/text-generator', () => ({
    generateText: mockGenerateText,
}));

describe('IdleStatusGenerator', () => {
    const mockLogger = {
        debug: mock(() => undefined),
        warn:  mock(() => undefined),
        error: mock(() => undefined),
        info:  mock(() => undefined),
        child: mock(() => mockLogger),
    } as any;

    beforeEach(() => {
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(_constant(Promise.resolve('Dozing peacefully')));
    });

    afterEach(() => {
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.info.mockClear();
    });

    describe('generate', () => {
        it('should call generateText with correct prompt containing identity context', async () => {
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'I am a helpful assistant',
            });

            await generator.generate();

            expect(mockGenerateText).toHaveBeenCalled();
            const promptArg = mockGenerateText.mock.calls[0][0];
            expect(promptArg).toContain('I am a helpful assistant');
        });

        it('should return generated status text', async () => {
            mockGenerateText.mockImplementation(_constant(Promise.resolve('Contemplating existence')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Contemplating existence');
            expect(result.type).toBe(ActivityType.Custom);
        });

        it('should truncate status text to 128 characters', async () => {
            const longText = _repeat('A', 200);
            mockGenerateText.mockImplementation(_constant(Promise.resolve(longText)));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(_size(result.name)).toBe(128);
            expect(result.name).toBe(_repeat('A', 128));
        });

        it('should not truncate text that is exactly 128 characters', async () => {
            const exactText = _repeat('B', 128);
            mockGenerateText.mockImplementation(_constant(Promise.resolve(exactText)));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(_size(result.name)).toBe(128);
            expect(result.name).toBe(exactText);
        });

        it('should truncate text that is 129 characters to exactly 128', async () => {
            const text129 = _repeat('C', 129);
            mockGenerateText.mockImplementation(_constant(Promise.resolve(text129)));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(_size(result.name)).toBe(128);
            expect(result.name).toBe(_repeat('C', 128));
            // Verify it's not 129 (the original) or 127 (off-by-one error)
            expect(result.name).not.toBe(text129);
            expect(_size(result.name)).not.toBe(127);
        });

        it('should handle text with leading/trailing whitespace (trimmed by generateText)', async () => {
            // generateText already trims, but if it returns whitespace we should handle it
            mockGenerateText.mockImplementation(_constant(Promise.resolve('Waiting patiently')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Waiting patiently');
        });

        it('should fall back to "Idle" on generateText error', async () => {
            mockGenerateText.mockImplementation(() => Promise.reject(new Error('API rate limit exceeded')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Idle');
            expect(result.type).toBe(ActivityType.Custom);
        });

        it('should log error when generateText fails', async () => {
            mockGenerateText.mockImplementation(() => Promise.reject(new Error('Network error')));

            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => localMockLogger),
            } as any;

            const generator = createIdleStatusGenerator({
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            expect(localMockLogger.error).toHaveBeenCalled();
        });

        it('should log info when status is generated successfully', async () => {
            mockGenerateText.mockImplementation(_constant(Promise.resolve('Resting quietly')));

            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => localMockLogger),
            } as any;

            const generator = createIdleStatusGenerator({
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            expect(localMockLogger.info).toHaveBeenCalled();
        });

        it('should include identity context in prompt', async () => {
            const identityContext = 'I am Isambard, a philosophical AI assistant';
            const generator = createIdleStatusGenerator({
                logger:       mockLogger,
                activityType: ActivityType.Custom,
                identityContext,
            });

            await generator.generate();

            const promptArg = mockGenerateText.mock.calls[0][0];
            expect(promptArg).toContain(identityContext);
        });

        it('should replace {identity} placeholder with actual identity context', async () => {
            const testIdentityContext = 'Unique test identity XYZ123';
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: testIdentityContext,
            });

            await generator.generate();

            const promptArg = mockGenerateText.mock.calls[0][0];

            // Verify the placeholder was replaced
            expect(promptArg).not.toContain('{identity}');
            // Verify the identity context is present
            expect(promptArg).toContain(testIdentityContext);
        });

        it('should handle empty string response from generateText', async () => {
            mockGenerateText.mockImplementation(_constant(Promise.resolve('')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('');
            expect(result.type).toBe(ActivityType.Custom);
        });

        it('should pass the activity type through to the result', async () => {
            // Test with Playing activity type
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Playing,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.type).toBe(ActivityType.Playing);
            expect(result.type).not.toBe(ActivityType.Custom);
        });

        it('should pass the activity type through to fallback result on error', async () => {
            mockGenerateText.mockImplementation(() => Promise.reject(new Error('API error')));

            // Test with Playing activity type for fallback
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Playing,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            expect(result.name).toBe('Idle');
            expect(result.type).toBe(ActivityType.Playing);
            expect(result.type).not.toBe(ActivityType.Custom);
        });

        it('should log debug message before generating status', async () => {
            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => localMockLogger),
            } as any;

            const generator = createIdleStatusGenerator({
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            expect(localMockLogger.debug).toHaveBeenCalledWith('Generating idle status with Haiku');
        });

        it('should log info with statusText when generation succeeds', async () => {
            mockGenerateText.mockImplementation(_constant(Promise.resolve('Generated status text')));

            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => localMockLogger),
            } as any;

            const generator = createIdleStatusGenerator({
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            expect(localMockLogger.info).toHaveBeenCalledWith(
                { statusText: 'Generated status text' },
                'Generated idle status'
            );
        });

        it('should log error with error object when generation fails', async () => {
            const testError = new Error('Test API failure');
            mockGenerateText.mockImplementation(() => Promise.reject(testError));

            const localMockLogger = {
                debug: mock(() => undefined),
                warn:  mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                child: mock(() => localMockLogger),
            } as any;

            const generator = createIdleStatusGenerator({
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            await generator.generate();

            expect(localMockLogger.error).toHaveBeenCalledWith(
                { error: testError },
                'Failed to generate idle status, using fallback'
            );
        });

        it('should slice starting from index 0', async () => {
            // This test ensures slice(0, 128) starts at 0, not some other index
            const text = 'ABCDEFGHIJ' + _repeat('X', 118);
            mockGenerateText.mockImplementation(_constant(Promise.resolve(text)));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: 'Test identity',
            });

            const result = await generator.generate();

            // Should start with 'A', not skip any characters
            expect(result.name).toStartWith('A');
            expect(result.name).toStartWith('ABCDEFGHIJ');
        });
    });
});

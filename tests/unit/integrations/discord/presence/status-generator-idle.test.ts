import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { ActivityType } from 'discord.js';
import { mockGenerateTextWithSystemPrompt, originalGenerateTextWithSystemPrompt } from '../../../../setup';
import type { Signal } from '@/agent';
import { createIdleStatusGenerator, rejectIdleStatusText, type IdleStatusGeneratorDeps } from '@/integrations/discord/presence/status-generator-idle';

const DEFAULT_IDLE_TEXT = 'Idle';

describe('rejectIdleStatusText', () => {
    test.each([
        'Dozing peacefully',
        'That error haunts me still',
    ])('returns null for a short in-style fragment (%s)', (text) => {
        expect(rejectIdleStatusText(text)).toBeNull();
    });

    test('returns null for text exactly 80 characters long', () => {
        expect(rejectIdleStatusText('A'.repeat(80))).toBeNull();
    });

    test('returns "too_long" for text 81 characters long (kills the > vs >= boundary mutant)', () => {
        expect(rejectIdleStatusText('A'.repeat(81))).toBe('too_long');
    });

    test('returns "too_long" for a long benign non-reasoning string', () => {
        expect(rejectIdleStatusText('word '.repeat(20).trim())).toBe('too_long');
    });

    test('returns "multiline" for any text containing a newline', () => {
        expect(rejectIdleStatusText('first line\nsecond line')).toBe('multiline');
    });

    test('reports "multiline" before "too_long" when a string is both multiline and over 80 chars (proves check order)', () => {
        expect(rejectIdleStatusText(`${'A'.repeat(90)}\nmore`)).toBe('multiline');
    });

    test.each([
        'I need to think about this',
        'I should pick a signal',
        "I'll write something short",
        'I will keep it brief',
        "I'm going to focus on one thread",
        "I'm trying to capture the mood",
        'I want to say something vague',
        'Let me think of a phrase',
        'First, consider the signals',
        'We need a short fragment',
        'Based on the context here',
        'Looking at the signals now',
        "Here's a thought for you",
        'Here is a fleeting fragment',
        'Perfect. That captures it',
        'Okay, here is the status',
        'Alright, one more thought',
    ])('returns "reasoning" for a narration opener (%s)', (text) => {
        expect(rejectIdleStatusText(text)).toBe('reasoning');
    });

    test('matches a reasoning opener case-insensitively', () => {
        expect(rejectIdleStatusText('i need to think about this')).toBe('reasoning');
    });

    test('returns null when "I need to" appears mid-sentence rather than at the start (proves the anchor, not a bare substring check)', () => {
        expect(rejectIdleStatusText('Somehow I need to keep moving')).toBeNull();
    });

    test.each([
        'Isambard is thinking about bugs',
        'They are quiet tonight',
    ])('returns "third_person" for third-person narration (%s)', (text) => {
        expect(rejectIdleStatusText(text)).toBe('third_person');
    });

    test('matches third-person narration case-insensitively', () => {
        expect(rejectIdleStatusText('isambard is thinking about bugs')).toBe('third_person');
    });

    test('returns null for text merely containing "Izzy" without the banned verb', () => {
        expect(rejectIdleStatusText('Izzy island, Craig mainland')).toBeNull();
    });

    test('returns null for the literal DEFAULT_IDLE_TEXT fallback', () => {
        expect(rejectIdleStatusText(DEFAULT_IDLE_TEXT)).toBeNull();
    });

    test('the untruncated #122 production repro is rejected as reasoning', () => {
        expect(rejectIdleStatusText('I need to pick one or two signals and let them shape a fleeting thought')).toBe('reasoning');
    });

    // Empty text is not rejected by this function (none of its checks fire on ''); the '' case is
    // handled separately, before this function is even called, by resolveIdleText's own `rawText
    // === ''` branch (reported as reason 'empty'). This function is only ever called on non-empty
    // text in production; this test documents the split rather than relying on it implicitly.
    test('does not itself reject an empty string (the "empty" reason comes from resolveIdleText, not here)', () => {
        expect(rejectIdleStatusText('')).toBeNull();
    });
});

describe('IdleStatusGenerator', () => {
    const mockLogger: IdleStatusGeneratorDeps['logger'] = {
        debug: mock(() => undefined),
        info:  mock(() => undefined),
        warn:  mock(() => undefined),
        error: mock(() => undefined),
    };

    beforeEach(() => {
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockResolvedValue('Dozing peacefully');
    });

    afterEach(() => {
        // Shared with the turn-synopsis wiring tests: leave neither calls nor idle responses behind.
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);
        (mockLogger.debug as ReturnType<typeof mock>).mockClear();
        (mockLogger.error as ReturnType<typeof mock>).mockClear();
        (mockLogger.info as ReturnType<typeof mock>).mockClear();
        (mockLogger.warn as ReturnType<typeof mock>).mockClear();
    });

    describe('generate', () => {
        test('should call generateTextWithSystemPrompt with system and user prompts', async () => {
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('I am a helpful assistant'),
            });

            await generator.generate();

            expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalled();
            const [systemPrompt, userPrompt] = mockGenerateTextWithSystemPrompt.mock.calls[0];
            expect(systemPrompt).toContain('I am a helpful assistant');
            expect(userPrompt).toContain('Status text (first person, under 50 chars):');
        });

        test('should pass stripMarkdown, the 30s idle deadline, and a diagnostic label to generateTextWithSystemPrompt', async () => {
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            await generator.generate();

            expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledWith(
                expect.any(String),  // system prompt
                expect.any(String),  // user prompt
                { stripMarkdown: true, timeoutMs: 30_000, label: 'idle-status' }  // options - this kills the mutant
            );
        });

        test('should return generated status text', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Contemplating existence'));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 Contemplating existence');
            expect(result.type).toBe(ActivityType.Custom);
        });

        test.each([
            { property: 'name', check: (val: unknown) => typeof val === 'string' && val.length > 0 },
            { property: 'type', check: (val: unknown) => val !== undefined },
        ])('should return object with $property property (kills ObjectLiteral mutant)', async ({ property, check }) => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Deep in thought'));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate();

            expect(result).toHaveProperty(property);
            expect(check(result[property as keyof typeof result])).toBe(true);
            expect(Object.keys(result).length).toBeGreaterThan(0);
        });

        test.each([
            { len: 200, 'char': 'A', desc: '200 characters' },
            { len: 128, 'char': 'B', desc: 'exactly 128 characters' },
            { len: 129, 'char': 'C', desc: '129 characters' },
        ])('falls back to the built-in idle text for an over-80-char generation ($desc), rather than truncating it', async ({ len, char }) => {
            const text = char.repeat(len);
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(text));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate();

            // Was: truncate-and-show for any length. That truncation is exactly how #122's
            // reasoning dump reached Discord (a runaway generation cut to fit rather than
            // refused), so text over 80 chars is now rejected outright ('too_long') and the
            // previous/default status is shown instead.
            expect(result.name).toBe('💤 Idle');
            expect(result.name).not.toContain(char.repeat(50));
        });

        test('should handle text with leading/trailing whitespace (trimmed by generateTextWithSystemPrompt)', async () => {
            // generateTextWithSystemPrompt already trims, but if it returns whitespace we should handle it
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Waiting patiently'));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 Waiting patiently');
        });

        test('rejects an over-80-char response outright rather than word-boundary-truncating it', async () => {
            // Was: word-boundary truncation for any length. That truncation is exactly how
            // #122's reasoning dump reached Discord (cut to fit rather than refused), so text
            // over 80 chars is now rejected outright, even ordinary space-separated text like
            // this. truncateToWordBoundary's real behaviour is still exercised via the P11
            // composed-prefix path below.
            const longText = 'hello world '.repeat(20); // 240 chars of "hello world " repeated

            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(longText));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 Idle');
        });

        test('should fall back to "Idle" on generateTextWithSystemPrompt error', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(new Error('API rate limit exceeded')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 Idle');
            expect(result.type).toBe(ActivityType.Custom);
        });

        test('should replace {identityContext} placeholder with actual identity context', async () => {
            const testIdentityContext = 'Unique test identity XYZ123';
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: async () => testIdentityContext,
            });

            await generator.generate();

            const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];

            // Verify the placeholder was replaced
            expect(systemPromptArg).not.toContain('{identityContext}');
            // Verify the identity context is present
            expect(systemPromptArg).toContain(testIdentityContext);
        });

        /**
         * A generation that comes back empty (the 15s default deadline firing on a slow boot-time
         * Haiku call was the observed cause) used to be composed and applied verbatim, so Discord
         * showed a prefix with nothing after it. An empty generation now keeps the last good status
         * instead, and says so — mirroring the session core's `synopsis-generator.ts`'s own refusal to cache a
         * response it would not want to show.
         */
        describe('empty generation', () => {
            test('reuses the cached previous status rather than applying an empty one', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(''));

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    getPreviousStatus: () => 'Still chewing on that trace',
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Still chewing on that trace');
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    { usedPreviousStatus: true, reason: 'empty' },
                    'Idle status generation produced no usable text'
                );
            });

            test('falls back to the built-in idle text, and says it did not reuse anything, when nothing is cached', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(''));

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    getPreviousStatus: () => undefined,
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Idle');
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    { usedPreviousStatus: false, reason: 'empty' },
                    'Idle status generation produced no usable text'
                );
            });

            test('treats a blank cached status as nothing to reuse', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(''));

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    getPreviousStatus: () => '   ',
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Idle');
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    { usedPreviousStatus: false, reason: 'empty' },
                    'Idle status generation produced no usable text'
                );
            });

            test('a whitespace-only generation is empty too', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('   \n  '));

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    getPreviousStatus: () => 'Still chewing on that trace',
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Still chewing on that trace');
            });

            test('keeps the composed P11 prefix and appends the reused status', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(''));

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    getPreviousStatus: () => 'Still chewing on that trace',
                });

                const result = await generator.generate({ prefix: '💤 2 tasks' });

                expect(result.name).toBe('💤 2 tasks • Still chewing on that trace');
            });

            test('does not warn when the generation produced text', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Chasing a loose thread'));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: () => Promise.resolve('Test identity'),
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Chasing a loose thread');
                expect(mockLogger.warn).not.toHaveBeenCalled();
            });
        });

        /**
         * #122: a non-empty but reasoning-shaped, over-length, multiline, or third-person
         * generation must never be published verbatim (the real bug: the model's planning
         * narration was word-boundary-truncated to 128 chars and shown as-is). Mirrors the
         * 'empty generation' describe block above, one behaviour per rejection reason.
         */
        describe('rejected (non-empty but unusable) generation', () => {
            test.each([
                { reason: 'reasoning', text: 'I need to pick one or two signals and let them shape a fleeting thought' },
                { reason: 'too_long', text: 'A'.repeat(81) },
                { reason: 'multiline', text: 'first line\nsecond line' },
                { reason: 'third_person', text: 'Isambard is thinking about bugs' },
            ])('reuses the cached previous status when generation is rejected as $reason', async ({ reason, text }) => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(text));

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    getPreviousStatus: () => 'Still chewing on that trace',
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Still chewing on that trace');
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    { usedPreviousStatus: true, reason },
                    'Idle status generation produced no usable text'
                );
            });

            test.each([
                { reason: 'reasoning', text: 'I need to pick one or two signals and let them shape a fleeting thought' },
                { reason: 'too_long', text: 'A'.repeat(81) },
                { reason: 'multiline', text: 'first line\nsecond line' },
                { reason: 'third_person', text: 'Isambard is thinking about bugs' },
            ])('falls back to the built-in idle text when generation is rejected as $reason and nothing is cached', async ({ reason, text }) => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(text));

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    getPreviousStatus: () => undefined,
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Idle');
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    { usedPreviousStatus: false, reason },
                    'Idle status generation produced no usable text'
                );
            });

            test('treats a previously-cached BAD status (itself reasoning-shaped) as unusable, falling through to the built-in idle text even though something is cached', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('I need to think about this'));

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    getPreviousStatus: () => 'I should have been rejected when cached',
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Idle');
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    { usedPreviousStatus: false, reason: 'reasoning' },
                    'Idle status generation produced no usable text'
                );
            });

            test('treats a previously-cached BAD status (over 80 chars) as unusable', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('first line\nsecond line'));

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    getPreviousStatus: () => 'B'.repeat(81),
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Idle');
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    { usedPreviousStatus: false, reason: 'multiline' },
                    'Idle status generation produced no usable text'
                );
            });

            test('keeps the composed P11 prefix and appends the reused status when generation is rejected', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('I need to think about this'));

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    getPreviousStatus: () => 'Still chewing on that trace',
                });

                const result = await generator.generate({ prefix: '💤 2 tasks' });

                expect(result.name).toBe('💤 2 tasks • Still chewing on that trace');
            });

            test('the untruncated #122 production repro never appears in the published status', async () => {
                const productionLeak = 'I need to pick one or two signals and let them shape a fleeting thought—something brief, vague, evocative. No…';
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(productionLeak));

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    getPreviousStatus: () => undefined,
                });

                const result = await generator.generate();

                expect(result.name).not.toContain(productionLeak);
                expect(result.name).toBe('💤 Idle');
            });
        });

        describe('quote-wrapped generation', () => {
            test.each([
                ['straight', '"Dozing peacefully"'],
                ['curly', '“Dozing peacefully”'],
            ])('strips one pair of surrounding %s double quotes from an otherwise-usable status', async (_label, quoted) => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(quoted));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: () => Promise.resolve('Test identity'),
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Dozing peacefully');
            });

            test.each([
                // Baseline: quotes that are not a surrounding pair are left alone.
                ['leaves quotes that are not a surrounding pair alone', 'Wondering if "this" is real'],
                // Kills the ^-anchor mutant: unanchored, this would swallow the inner quotes.
                ['leaves a status that merely ENDS with a quoted word alone', 'Wondering about "this"'],
                // Kills the $-anchor mutant: without it, the leading quoted word would be unwrapped.
                ['leaves a status that merely STARTS with a quoted word alone', '"this" still lingers'],
            ])('%s', async (_name, text) => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(text));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: () => Promise.resolve('Test identity'),
                });

                const result = await generator.generate();

                expect(result.name).toBe(`💤 ${text}`);
            });

            test('strips the quotes BEFORE validating, so a quote-wrapped reasoning dump is still rejected (#122 regression: quotes previously bypassed the reasoning-opener check)', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('"I need to pick a status"'));

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    getPreviousStatus: () => undefined,
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Idle');
                expect(result.name).not.toContain('I need to pick a status');
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    { usedPreviousStatus: false, reason: 'reasoning' },
                    'Idle status generation produced no usable text'
                );
            });

            test('persists the dequoted text as the previous status, not the raw quoted form', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('"Dozing peacefully"'));
                const mockSetPreviousStatus = mock((_text: string) => undefined);

                const generator = createIdleStatusGenerator({
                    logger:            mockLogger,
                    activityType:      ActivityType.Custom,
                    identityContext:   () => Promise.resolve('Test identity'),
                    setPreviousStatus: mockSetPreviousStatus,
                });

                await generator.generate();

                expect(mockSetPreviousStatus).toHaveBeenCalledWith('Dozing peacefully');
            });
        });

        test('should never apply an empty generation — falls back to the built-in idle text', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(''));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 Idle');
            expect(result.type).toBe(ActivityType.Custom);
        });

        test.each([
            { scenario: 'success', mockSetup: () => mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Generated status')) },
            { scenario: 'error fallback', mockSetup: () => mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(new Error('API error'))) },
        ])('should pass the activity type through to result on $scenario', async ({ mockSetup }) => {
            mockSetup();

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Playing,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate();

            expect(result.type).toBe(ActivityType.Playing);
            expect(result.type).not.toBe(ActivityType.Custom);
        });

        test('should log info with statusText when generation succeeds', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Generated status text'));

            const localMockLogger: IdleStatusGeneratorDeps['logger'] = {
                debug: mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                warn:  mock(() => undefined),
            };

            const generator = createIdleStatusGenerator({
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            await generator.generate();

            expect(localMockLogger.info).toHaveBeenCalledWith(
                { statusText: '💤 Generated status text' },
                'Generated idle status'
            );
        });

        test('should log error with error object when generation fails', async () => {
            const testError = new Error('Test API failure');
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(testError));

            const localMockLogger: IdleStatusGeneratorDeps['logger'] = {
                debug: mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                warn:  mock(() => undefined),
            };

            const generator = createIdleStatusGenerator({
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            await generator.generate();

            expect(localMockLogger.error).toHaveBeenCalledWith(
                { error: testError },
                'Failed to generate idle status, using fallback'
            );
        });

        test('should slice starting from index 0 (via a P11-squeezed digest, since an 80+ char digest is now rejected before slicing)', async () => {
            // digest kept <=80 chars so it survives resolveIdleText's too_long rejection; a wide
            // prefix squeezes the remaining budget below the digest's length so the real
            // truncateToWordBoundary slice still runs and this proves it starts at index 0, not
            // some other index.
            const digest = `ABCDEFGHIJ${'X'.repeat(60)}`; // 70 chars
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(digest));
            const prefix = 'Y'.repeat(100); // remaining budget: 128 - 100 - 3 = 25

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate({ prefix });

            expect(result.name).toStartWith(`${prefix} • A`);
            expect(result.name).toStartWith(`${prefix} • ABCDEFGHIJ`);
        });

        // Tests for getRecentContext functionality
        describe('with getRecentContext', () => {
            test('should call getRecentContext when provided', async () => {
                const mockGetRecentContext = mock(() => Promise.resolve('Recent discussion about AI'));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  () => Promise.resolve('Test identity'),
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                expect(mockGetRecentContext).toHaveBeenCalled();
            });

            test('should include recent context in user prompt when available', async () => {
                const recentContext = 'Discussed philosophy with a curious human';
                const mockGetRecentContext = mock(() => Promise.resolve(recentContext));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  () => Promise.resolve('Test identity'),
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toContain(recentContext);
                expect(userPromptArg).toContain('Recent conversation:');
            });

            test('should use simple user prompt when getRecentContext returns undefined', async () => {
                const mockGetRecentContext = mock(() => Promise.resolve(undefined));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  () => Promise.resolve('Test identity'),
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toBe('Status text (first person, under 50 chars):');
                expect(userPromptArg).not.toContain('Recent conversation');
            });

            test('should use simple user prompt when getRecentContext is not provided', async () => {
                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: () => Promise.resolve('Test identity'),
                    // No getRecentContext provided
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toBe('Status text (first person, under 50 chars):');
            });

            test('should use simple user prompt when getRecentContext returns empty string', async () => {
                const mockGetRecentContext = mock(() => Promise.resolve(''));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  () => Promise.resolve('Test identity'),
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                // Empty string is falsy, so should use simple prompt
                expect(userPromptArg).toBe('Status text (first person, under 50 chars):');
            });

            test('should replace {recentContext} placeholder with actual recent context', async () => {
                const recentContext = 'Unique recent context ABC789';
                const mockGetRecentContext = mock(() => Promise.resolve(recentContext));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  () => Promise.resolve('Test identity'),
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).not.toContain('{recentContext}');
                expect(userPromptArg).toContain(recentContext);
            });

            test('should fall back to Idle when getRecentContext throws an error', async () => {
                const mockGetRecentContext = mock(() => Promise.reject(new Error('Context fetch failed')));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  () => Promise.resolve('Test identity'),
                    getRecentContext: mockGetRecentContext,
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Idle');
                expect(result.type).toBe(ActivityType.Custom);
            });

            test('should include thinking context in user prompt when available', async () => {
                const thinkingContext = 'I was considering the implications of quantum mechanics...';
                const mockGetLastThinkingContent = mock(() => thinkingContext);

                const generator = createIdleStatusGenerator({
                    logger:                 mockLogger,
                    activityType:           ActivityType.Custom,
                    identityContext:        () => Promise.resolve('Test identity'),
                    getLastThinkingContent: mockGetLastThinkingContent,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toContain('Last thoughts:');
                expect(userPromptArg).toContain(thinkingContext);
            });

            test('should omit thinking context when not available', async () => {
                const mockGetLastThinkingContent = mock(() => undefined);

                const generator = createIdleStatusGenerator({
                    logger:                 mockLogger,
                    activityType:           ActivityType.Custom,
                    identityContext:        () => Promise.resolve('Test identity'),
                    getLastThinkingContent: mockGetLastThinkingContent,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).not.toContain('Last thoughts:');
                expect(userPromptArg).toBe('Status text (first person, under 50 chars):');
            });

            test('should include both recent context and thinking context when both available', async () => {
                const recentContext = 'User asked about weather';
                const thinkingContext = 'Analyzing weather patterns...';
                const mockGetRecentContext = mock(() => Promise.resolve(recentContext));
                const mockGetLastThinkingContent = mock(() => thinkingContext);

                const generator = createIdleStatusGenerator({
                    logger:                 mockLogger,
                    activityType:           ActivityType.Custom,
                    identityContext:        () => Promise.resolve('Test identity'),
                    getRecentContext:       mockGetRecentContext,
                    getLastThinkingContent: mockGetLastThinkingContent,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toContain('Recent conversation:');
                expect(userPromptArg).toContain(recentContext);
                expect(userPromptArg).toContain('Last thoughts:');
                expect(userPromptArg).toContain(thinkingContext);
            });

            test('should include task context in user prompt when available', async () => {
                const taskContext = 'Working on: Fix bugs\n2 pending tasks';
                const mockGetTaskContext = mock(() => Promise.resolve(taskContext));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: () => Promise.resolve('Test identity'),
                    getTaskContext:  mockGetTaskContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).toContain('Current work:');
                expect(userPromptArg).toContain(taskContext);
            });

            test('should omit task context when not available', async () => {
                const mockGetTaskContext = mock(() => Promise.resolve(undefined));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: () => Promise.resolve('Test identity'),
                    getTaskContext:  mockGetTaskContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(userPromptArg).not.toContain('Current work:');
                expect(userPromptArg).toBe('Status text (first person, under 50 chars):');
            });

            test('should order task context before recent conversation in prompt', async () => {
                const taskContext = 'Working on: Test task';
                const recentContext = 'Recent chat';
                const mockGetTaskContext = mock(() => Promise.resolve(taskContext));
                const mockGetRecentContext = mock(() => Promise.resolve(recentContext));

                const generator = createIdleStatusGenerator({
                    logger:           mockLogger,
                    activityType:     ActivityType.Custom,
                    identityContext:  () => Promise.resolve('Test identity'),
                    getTaskContext:   mockGetTaskContext,
                    getRecentContext: mockGetRecentContext,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                const taskIndex = userPromptArg.indexOf('Current work:');
                const recentIndex = userPromptArg.indexOf('Recent conversation:');
                expect(taskIndex).toBeGreaterThan(-1);
                expect(recentIndex).toBeGreaterThan(-1);
                expect(taskIndex).toBeLessThan(recentIndex);
                // Sections must be separated by double newline (kills '\n\n' → '' separator mutant)
                expect(userPromptArg).toContain(`Current work:\n${taskContext}\n\nRecent conversation:`);
            });

            test('should assemble all three sections most-stable first, with the status instruction last', async () => {
                const taskContext = 'Working on: Test task';
                const recentContext = 'Recent chat';
                const thinkingContext = 'Still turning over the caching question';
                const mockGetTaskContext = mock(() => Promise.resolve(taskContext));
                const mockGetRecentContext = mock(() => Promise.resolve(recentContext));
                const mockGetLastThinkingContent = mock(() => thinkingContext);

                const generator = createIdleStatusGenerator({
                    logger:                 mockLogger,
                    activityType:           ActivityType.Custom,
                    identityContext:        () => Promise.resolve('Test identity'),
                    getTaskContext:         mockGetTaskContext,
                    getRecentContext:       mockGetRecentContext,
                    getLastThinkingContent: mockGetLastThinkingContent,
                });

                await generator.generate();

                const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                // Anthropic prefix caching wants the most stable section first (task → recent →
                // thinking); the last section must stay last (kills push → unshift on it), and the
                // instruction after them is the first-person one (kills 'first' → 'third').
                expect(userPromptArg).toBe(`Current work:\n${taskContext}\n\nRecent conversation:\n${recentContext}\n\nLast thoughts:\n${thinkingContext}\n\nStatus text (first person, under 50 chars):`);
            });

            test('should put the static prefix before the instructions with a blank line between', async () => {
                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: () => Promise.resolve('Test identity'),
                });

                await generator.generate();

                const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string;
                // String-form system prompt (legacy path): identity-substituted prefix, blank line,
                // then the instructions block — never the other way round and never one newline.
                expect(systemPromptArg).toContain('Test identity\n\n## The Vibe');
                expect(systemPromptArg.indexOf('## Who is Isambard')).toBeLessThan(systemPromptArg.indexOf('## The Vibe'));
            });

            test.each([
                { section: 'Who is Isambard', marker: '## Who is Isambard (Izzy)?', content: 'Test identity' },
                { section: 'The Vibe', marker: '## The Vibe', content: 'You will be given a numbered list of "now-signals"' },
                { section: 'NEVER restrictions', marker: '## NEVER output:', content: 'Corporate speak ("Processing", "Standing by", "Idle", "Waiting")' },
            ])('should include $section section in system prompt', async ({ marker, content }) => {
                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: () => Promise.resolve('Test identity'),
                });

                await generator.generate();

                // Legacy path: systemPrompt is a string (no getLiveSignals)
                const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string;
                expect(systemPromptArg).toContain(marker);
                expect(systemPromptArg).toContain(content);
            });
        });

        // Tests for async identityContext callback
        describe('async identityContext callback', () => {
            test('should call identityContext callback on each generate() invocation', async () => {
                const mockIdentityContext = mock(() => Promise.resolve('Dynamic identity'));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: mockIdentityContext,
                });

                await generator.generate();
                await generator.generate();

                expect(mockIdentityContext).toHaveBeenCalledTimes(2);
            });

            test('should use callback result in system prompt', async () => {
                const dynamicIdentity = 'Dynamically loaded identity context';
                const mockIdentityContext = mock(() => Promise.resolve(dynamicIdentity));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: mockIdentityContext,
                });

                await generator.generate();

                const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
                expect(systemPromptArg).toContain(dynamicIdentity);
            });

            test('should fall back to Idle when identityContext callback throws an error', async () => {
                const mockIdentityContext = mock(() => Promise.reject(new Error('Identity fetch failed')));

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: mockIdentityContext,
                });

                const result = await generator.generate();

                expect(result.name).toBe('💤 Idle');
                expect(result.type).toBe(ActivityType.Custom);
            });

            test('should handle different identity values on successive calls', async () => {
                let callCount = 0;
                const mockIdentityContext = mock(() => {
                    callCount++;
                    return Promise.resolve(`Identity ${callCount}`);
                });

                const generator = createIdleStatusGenerator({
                    logger:          mockLogger,
                    activityType:    ActivityType.Custom,
                    identityContext: mockIdentityContext,
                });

                await generator.generate();
                const firstSystemPrompt = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
                expect(firstSystemPrompt).toContain('Identity 1');

                mockGenerateTextWithSystemPrompt.mockClear();
                await generator.generate();
                const secondSystemPrompt = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
                expect(secondSystemPrompt).toContain('Identity 2');
            });
        });
    });

    describe('logging behavior', () => {
        test('should log debug with specific string when generating idle status', async () => {
            const localMockLogger: IdleStatusGeneratorDeps['logger'] = {
                debug: mock(() => undefined),
                error: mock(() => undefined),
                info:  mock(() => undefined),
                warn:  mock(() => undefined),
            };

            const generator = createIdleStatusGenerator({
                logger:          localMockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            await generator.generate();

            // Kill StringLiteral mutant - verify the debug message
            const debugCalls = (localMockLogger.debug as ReturnType<typeof mock>).mock.calls;
            expect(debugCalls.length).toBeGreaterThan(0);
            const firstCall = debugCalls[0];
            expect(firstCall[0]).toBe('Generating idle status with Haiku');
            expect(firstCall[0]).not.toBe('');
        });
    });

    describe('live-signals path', () => {
        const makeSignals = (overrides?: Partial<Signal>[]): Signal[] => [
            { kind: 'perch', label: 'perch', content: 'late-night exploration', ...overrides?.[0] },
            { kind: 'tool',  label: 'tool',  content: '3m ago: bsky.getFeed',   ...overrides?.[1] },
            { kind: 'time',  label: 'time',  content: 'late night',             ...overrides?.[2] },
        ];

        test('should render numbered signal menu in user prompt when getLiveSignals provided', async () => {
            const signals = makeSignals();
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
                getLiveSignals:  () => Promise.resolve(signals),
            });

            await generator.generate();

            const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
            expect(userPromptArg).toContain('Now-signals:');
            expect(userPromptArg).toContain('1.  [perch] late-night exploration');
            expect(userPromptArg).toContain('2.  [tool] 3m ago: bsky.getFeed');
            expect(userPromptArg).toContain('3.  [time] late night');
            // Status instruction follows the menu (kills signals.length>0 → false mutant)
            expect(userPromptArg).toContain('Status text (first person, under 50 chars):');
            // Signals appear on separate lines (kills '\n' → '' separator mutant)
            expect(userPromptArg).toContain('1.  [perch] late-night exploration\n2.  [tool]');
        });

        test('should append the status instruction after the menu for a single signal', async () => {
            const signals = makeSignals().slice(0, 1);
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
                getLiveSignals:  () => Promise.resolve(signals),
            });

            await generator.generate();

            const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
            // One signal still takes the menu branch (kills `signals.length > 0` → `> 1`, which
            // would drop the status instruction and leave the model with an unguided prompt).
            expect(userPromptArg).toContain('1.  [perch] late-night exploration');
            expect(userPromptArg).toContain('Status text (first person, under 50 chars):');
        });

        test('should separate the signal menu from the status instruction with a blank line', async () => {
            const signals = makeSignals();
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
                getLiveSignals:  () => Promise.resolve(signals),
            });

            await generator.generate();

            const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
            // Menu and instruction are separate blocks (kills the '\n\n' → '\n' and '\n\n' → '' mutants)
            expect(userPromptArg).toContain('3.  [time] late night\n\nStatus text (first person, under 50 chars):');
        });

        test('should number signals starting from 1', async () => {
            const signals = makeSignals();
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
                getLiveSignals:  () => Promise.resolve(signals),
            });

            await generator.generate();

            const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
            // Verify first index is 1 not 0
            expect(userPromptArg).toContain('1.  [perch]');
            expect(userPromptArg).not.toContain('0.  [');
        });

        test('should build systemPrompt as array with SYSTEM_PROMPT_DYNAMIC_BOUNDARY when getLiveSignals provided', async () => {
            const signals = makeSignals();
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
                getLiveSignals:  () => Promise.resolve(signals),
            });

            await generator.generate();

            const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
            // Must be an array when getLiveSignals is provided
            expect(Array.isArray(systemPromptArg)).toBe(true);
            const parts = systemPromptArg as string[];
            // Array must have exactly 3 elements: static prefix, instructions, boundary sentinel
            expect(parts).toHaveLength(3);
            // BOUNDARY must be the LAST element so everything before it is fully cacheable
            expect(parts[parts.length - 1]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
        });

        test('should include identity in static prefix of array systemPrompt', async () => {
            const signals = makeSignals();
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('My unique identity text'),
                getLiveSignals:  () => Promise.resolve(signals),
            });

            await generator.generate();

            const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string[];
            // Identity should be in the static prefix (first element, before the boundary)
            expect(systemPromptArg[0]).toContain('My unique identity text');
            // Instructions block (second element) should NOT contain the identity text
            expect(systemPromptArg[1]).not.toContain('My unique identity text');
            // Placeholder must NOT remain literally in the output (kills '{identityContext}' → '' mutant)
            expect(systemPromptArg[0]).not.toContain('{identityContext}');
            // Identity must appear AFTER the '## Who is Isambard' heading, not prepended at position 0
            const identityHeaderIdx = systemPromptArg[0].indexOf('## Who is Isambard');
            const identityTextIdx = systemPromptArg[0].indexOf('My unique identity text');
            expect(identityHeaderIdx).toBeGreaterThan(-1);
            expect(identityTextIdx).toBeGreaterThan(identityHeaderIdx);
        });

        test('should substitute the whole {identityContext} placeholder, leaving no braces behind', async () => {
            const signals = makeSignals();
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('My unique identity text'),
                getLiveSignals:  () => Promise.resolve(signals),
            });

            await generator.generate();

            const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string[];
            // Replacing only the inner text leaves the identity wrapped in braces, which the model
            // reads as an unsubstituted placeholder rather than the identity block.
            expect(systemPromptArg[0]).toContain('## Who is Isambard (Izzy)?\nMy unique identity text');
            expect(systemPromptArg[0]).not.toContain('{My unique identity text}');
        });

        test('should include "now-signals" instructions in static instructions block', async () => {
            const signals = makeSignals();
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
                getLiveSignals:  () => Promise.resolve(signals),
            });

            await generator.generate();

            const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string[];
            // Instructions block (second element, before the boundary) should contain the "pick one or two" instruction
            expect(systemPromptArg[1]).toContain('now-signals');
            expect(systemPromptArg[1]).toContain('Pick one or two');
        });

        test('should use fallback user prompt when getLiveSignals returns empty array', async () => {
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
                getLiveSignals:  () => Promise.resolve([]),
            });

            await generator.generate();

            const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
            expect(userPromptArg).toBe('Status text (first person, under 50 chars):');
        });

        test('should append previous-status block in else-branch when signals empty and getPreviousStatus has value', async () => {
            const generator = createIdleStatusGenerator({
                logger:            mockLogger,
                activityType:      ActivityType.Custom,
                identityContext:   () => Promise.resolve('Test identity'),
                getLiveSignals:    () => Promise.resolve([]),
                getPreviousStatus: () => 'Pondering the void',
            });

            await generator.generate();

            const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
            // Fallback text must be present (kills removal of menuText from else-branch)
            expect(userPromptArg).toContain('Status text (first person, under 50 chars):');
            // Previous-status block must also be present (kills dropping ${previousBlock} from else-branch)
            expect(userPromptArg).toContain('The idea is to make the status different each time');
            expect(userPromptArg).toContain('"Pondering the void"');
        });

        test('should omit previous-status block in else-branch when signals empty and getPreviousStatus returns undefined', async () => {
            const generator = createIdleStatusGenerator({
                logger:            mockLogger,
                activityType:      ActivityType.Custom,
                identityContext:   () => Promise.resolve('Test identity'),
                getLiveSignals:    () => Promise.resolve([]),
                getPreviousStatus: () => undefined,
            });

            await generator.generate();

            const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
            expect(userPromptArg).toBe('Status text (first person, under 50 chars):');
            expect(userPromptArg).not.toContain('The idea is to make the status different');
        });

        test('should include previous-status anti-rut block when getPreviousStatus returns a value', async () => {
            const signals = makeSignals();
            const generator = createIdleStatusGenerator({
                logger:            mockLogger,
                activityType:      ActivityType.Custom,
                identityContext:   () => Promise.resolve('Test identity'),
                getLiveSignals:    () => Promise.resolve(signals),
                getPreviousStatus: () => '💤 Mind tangled in diaspora threads',
            });

            await generator.generate();

            const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
            expect(userPromptArg).toContain('The idea is to make the status different each time');
            expect(userPromptArg).toContain('"💤 Mind tangled in diaspora threads"');
        });

        test('should omit previous-status block when getPreviousStatus returns undefined', async () => {
            const signals = makeSignals();
            const generator = createIdleStatusGenerator({
                logger:            mockLogger,
                activityType:      ActivityType.Custom,
                identityContext:   () => Promise.resolve('Test identity'),
                getLiveSignals:    () => Promise.resolve(signals),
                getPreviousStatus: () => undefined,
            });

            await generator.generate();

            const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
            expect(userPromptArg).not.toContain('The idea is to make the status different');
        });

        test('should omit previous-status block when getPreviousStatus is not provided', async () => {
            const signals = makeSignals();
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
                getLiveSignals:  () => Promise.resolve(signals),
                // No getPreviousStatus
            });

            await generator.generate();

            const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
            expect(userPromptArg).not.toContain('The idea is to make the status different');
        });

        test('should call setPreviousStatus with statusText (without emoji prefix) after successful generate', async () => {
            mockGenerateTextWithSystemPrompt.mockResolvedValue('Deep in thought');
            const mockSetPreviousStatus = mock((_text: string) => undefined);
            const signals = makeSignals();

            const generator = createIdleStatusGenerator({
                logger:            mockLogger,
                activityType:      ActivityType.Custom,
                identityContext:   () => Promise.resolve('Test identity'),
                getLiveSignals:    () => Promise.resolve(signals),
                setPreviousStatus: mockSetPreviousStatus,
            });

            await generator.generate();

            expect(mockSetPreviousStatus).toHaveBeenCalledTimes(1);
            expect(mockSetPreviousStatus).toHaveBeenCalledWith('Deep in thought');
        });

        test('should not call setPreviousStatus when not provided', async () => {
            mockGenerateTextWithSystemPrompt.mockResolvedValue('Deep in thought');
            const signals = makeSignals();

            // Should not throw when setPreviousStatus is absent
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
                getLiveSignals:  () => Promise.resolve(signals),
                // No setPreviousStatus
            });

            await expect(generator.generate()).resolves.toBeDefined();
        });

        test('should call setPreviousStatus even when the generation is rejected as too_long (using the fallback text)', async () => {
            // Was: 200 A's, truncated by composeDefaultIdleStatus. Now rejected outright as
            // too_long before composition, so the fallback ('Idle', nothing cached) is what
            // gets composed and persisted instead.
            const longText = 'A'.repeat(200);
            mockGenerateTextWithSystemPrompt.mockResolvedValue(longText);
            const mockSetPreviousStatus = mock((_text: string) => undefined);
            const signals = makeSignals();

            const generator = createIdleStatusGenerator({
                logger:            mockLogger,
                activityType:      ActivityType.Custom,
                identityContext:   () => Promise.resolve('Test identity'),
                getLiveSignals:    () => Promise.resolve(signals),
                setPreviousStatus: mockSetPreviousStatus,
            });

            await generator.generate();

            // setPreviousStatus receives the fallback text ('Idle'), not the rejected generation
            expect(mockSetPreviousStatus).toHaveBeenCalledTimes(1);
            expect(mockSetPreviousStatus).toHaveBeenCalledWith('Idle');
        });

        test('should fall back to Idle on getLiveSignals error without calling setPreviousStatus', async () => {
            const mockSetPreviousStatus = mock((_text: string) => undefined);

            const generator = createIdleStatusGenerator({
                logger:            mockLogger,
                activityType:      ActivityType.Custom,
                identityContext:   () => Promise.resolve('Test identity'),
                getLiveSignals:    () => Promise.reject(new Error('signals failed')),
                setPreviousStatus: mockSetPreviousStatus,
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 Idle');
            expect(mockSetPreviousStatus).not.toHaveBeenCalled();
        });

        test('should use legacy fallback path (no systemPrompt array) when getLiveSignals is not provided', async () => {
            const taskContext = 'Working on: Test task';
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
                getTaskContext:  () => Promise.resolve(taskContext),
                // No getLiveSignals
            });

            await generator.generate();

            const systemPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][0];
            const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];

            // Legacy path uses a plain string system prompt, not an array
            expect(typeof systemPromptArg).toBe('string');
            // Legacy user prompt contains task context
            expect(userPromptArg).toContain('Current work:');
            expect(userPromptArg).toContain(taskContext);
        });

        test('should include signal label in brackets in numbered menu', async () => {
            const signals: Signal[] = [
                { kind: 'channel', label: 'channel', content: '5m ago: #general' },
            ];
            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
                getLiveSignals:  () => Promise.resolve(signals),
            });

            await generator.generate();

            const userPromptArg = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
            expect(userPromptArg).toContain('[channel] 5m ago: #general');
        });
    });

    describe('generate with a composed prefix (P11)', () => {
        test('default call (no options) still yields 💤 <text> within 128, unchanged', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Dozing peacefully'));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 Dozing peacefully');
            expect(result.name.length).toBeLessThanOrEqual(128);
        });

        test('generate({ prefix }) keeps the prefix intact and word-boundary-truncates the text to fit 128', async () => {
            // Digest kept <=80 chars (so it survives resolveIdleText's own too_long rejection —
            // #122's fix rejects the RAW generation over 80 chars before composition even runs);
            // the prefix is widened so the remaining P11 budget (128 - 70 - 3 = 55) is still
            // narrower than the 74-char digest, so renderPrefixedText's real word-boundary
            // truncation is exercised here rather than at generation time.
            const digest = 'word '.repeat(15).trim(); // 74 chars
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(digest));
            const prefix = 'X'.repeat(70);

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate({ prefix });

            expect(result.name).toStartWith(`${prefix} • word word`);
            expect(result.name).toEndWith('…');
            expect(result.name).not.toContain(digest); // proves it was actually truncated
            expect(result.name.length).toBeLessThanOrEqual(128);
        });

        test('generate({ prefix, compacting: true }) inserts the compacting marker before the text', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Mulling it over'));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate({ prefix: '💤', compacting: true });

            expect(result.name).toBe('💤 • compacting • Mulling it over');
        });

        test('a very long prefix leaves the text dropped rather than the prefix cut', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Something to say'));
            const bigPrefix = 'X'.repeat(120);

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate({ prefix: bigPrefix });

            expect(result.name).toBe(bigPrefix);
        });

        test('digest included when exactly 12 code units remain (the boundary)', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('twelve chars'));
            // 128 - 3 (separator) - 12 (remaining) = 113
            const prefix = 'X'.repeat(113);

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate({ prefix });

            expect(result.name).toBe(`${prefix} • twelve chars`);
        });

        test('digest dropped when exactly 11 code units remain (one below the boundary)', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('twelve chars'));
            // 128 - 3 (separator) - 11 (remaining) = 114
            const prefix = 'X'.repeat(114);

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate({ prefix });

            expect(result.name).toBe(prefix);
        });

        test('setPreviousStatus is not called when the digest is dropped for lack of budget', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Something to say'));
            const mockSetPreviousStatus = mock((_text: string) => undefined);
            const bigPrefix = 'X'.repeat(120);

            const generator = createIdleStatusGenerator({
                logger:            mockLogger,
                activityType:      ActivityType.Custom,
                identityContext:   () => Promise.resolve('Test identity'),
                setPreviousStatus: mockSetPreviousStatus,
            });

            await generator.generate({ prefix: bigPrefix });

            expect(mockSetPreviousStatus).not.toHaveBeenCalled();
        });

        test('setPreviousStatus receives the rendered (possibly truncated) digest text when it fits', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Mulling it over'));
            const mockSetPreviousStatus = mock((_text: string) => undefined);

            const generator = createIdleStatusGenerator({
                logger:            mockLogger,
                activityType:      ActivityType.Custom,
                identityContext:   () => Promise.resolve('Test identity'),
                setPreviousStatus: mockSetPreviousStatus,
            });

            await generator.generate({ prefix: '💤' });

            expect(mockSetPreviousStatus).toHaveBeenCalledWith('Mulling it over');
        });

        test('falls back to the composed prefix (not the hardcoded "💤 Idle") when generation errors, so task counts survive a Haiku failure', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(new Error('API rate limit exceeded')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate({ prefix: '💤 • 1 🪾', compacting: false });

            expect(result.name).toBe('💤 • 1 🪾');
            expect(result.type).toBe(ActivityType.Custom);
        });

        test('falls back to the composed prefix with the compacting marker when generation errors', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(new Error('API rate limit exceeded')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate({ prefix: '💤 • 1 🪾', compacting: true });

            expect(result.name).toBe('💤 • 1 🪾 • compacting');
        });

        test('falls back to the composed prefix with no compacting marker when generation errors and `compacting` is omitted', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(new Error('API rate limit exceeded')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate({ prefix: '💤 • 1 🪾' });

            expect(result.name).toBe('💤 • 1 🪾');
            expect(result.name).not.toContain('compacting');
        });

        test('still falls back to the hardcoded "💤 Idle" when no prefix was composed (unchanged pre-P11 behaviour)', async () => {
            mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.reject(new Error('API rate limit exceeded')));

            const generator = createIdleStatusGenerator({
                logger:          mockLogger,
                activityType:    ActivityType.Custom,
                identityContext: () => Promise.resolve('Test identity'),
            });

            const result = await generator.generate();

            expect(result.name).toBe('💤 Idle');
        });
    });
});

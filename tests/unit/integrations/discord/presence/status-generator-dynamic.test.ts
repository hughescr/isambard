import { describe, it, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { mockGenerateTextWithSystemPrompt, mockLogger, originalGenerateTextWithSystemPrompt } from '../../../../setup';
import {
    createDynamicStatusGenerator,
    rejectSynopsis,
    truncateToWordBoundary,
    HARD_MAX_STATUS_LENGTH
} from '@/integrations/discord/presence/status-generator-dynamic';
import type { SynopsisContext } from '@/integrations/discord/presence/types';

/**
 * The line every user prompt has to end with. Without an ask at the end, the `##` sections read
 * as a document to comment on and Haiku narrates the task instead of answering it.
 */
const CLOSING_ASK = "Izzy's status line right now (first person, under 40 characters, nothing else):";

describe('truncateToWordBoundary', () => {
    describe('text within maxLength', () => {
        it('should return text unchanged if under maxLength', () => {
            const result = truncateToWordBoundary('Short text', 20);
            expect(result).toBe('Short text');
        });

        it('should return text unchanged if exactly at maxLength', () => {
            const text = 'Exactly ten';
            expect(text).toHaveLength(11);
            const result = truncateToWordBoundary(text, 11);
            expect(result).toBe('Exactly ten');
        });
    });

    describe('text exceeding maxLength', () => {
        it('should truncate at word boundary with ellipsis when over maxLength', () => {
            const result = truncateToWordBoundary('Hello world how are you', 15);
            // Should cut at 'world' (11 chars) + ellipsis = 12 chars total
            expect(result).toBe('Hello world\u2026');
            expect(result.length).toBeLessThanOrEqual(15);
        });

        it('should handle multiple spaces correctly', () => {
            const result = truncateToWordBoundary('Word one  two three four', 15);
            // Should find the last space before position 15
            expect(result).toBe('Word one  two\u2026');
            expect(result.length).toBeLessThanOrEqual(15);
        });

        it('should handle text ending with space', () => {
            const result = truncateToWordBoundary('Hello world ', 10);
            // Last space before position 10 is at position 5
            expect(result).toBe('Hello\u2026');
        });
    });

    describe('single long word (no space found)', () => {
        it('should hard truncate single long word at maxLength-1 plus ellipsis', () => {
            const result = truncateToWordBoundary('Supercalifragilisticexpialidocious', 10);
            // No space found, so hard truncate at 9 chars + ellipsis
            expect(result).toBe('Supercali\u2026');
            expect(result).toHaveLength(10);
        });

        it('should hard truncate when first word is too long', () => {
            const result = truncateToWordBoundary('Pneumonoultramicroscopicsilicovolcanoconiosis is a word', 20);
            // The first space is at position 45, which is > 20, so no valid space
            expect(result).toBe('Pneumonoultramicros\u2026');
            expect(result).toHaveLength(20);
        });
    });

    describe('edge cases', () => {
        it('should handle empty string', () => {
            const result = truncateToWordBoundary('', 10);
            expect(result).toBe('');
        });

        it('should handle maxLength of 1 with multi-char text', () => {
            const result = truncateToWordBoundary('Hello', 1);
            // Hard truncate: 0 chars + ellipsis = ellipsis only
            expect(result).toBe('\u2026');
        });

        it('should handle maxLength of 2', () => {
            const result = truncateToWordBoundary('Hello world', 2);
            // Hard truncate: 1 char + ellipsis
            expect(result).toBe('H\u2026');
        });

        it('should handle space at exact maxLength position', () => {
            // 'Hello world' - space is at position 5
            const result = truncateToWordBoundary('Hello world', 6);
            // Last space before position 6 is at position 5
            expect(result).toBe('Hello\u2026');
        });

        it('should hard truncate when only space is at position 0', () => {
            // When the only space is at position 0, lastSpaceIndex === 0
            // Original code (> 0) should fall through to hard truncate
            // Mutant (>= 0) would truncate at position 0, giving just ellipsis
            const result = truncateToWordBoundary(' Nospace', 5);
            // Last space within range is at position 0, but we don't want to truncate there
            // (would result in empty string + ellipsis). Instead hard truncate at position 4.
            expect(result).toBe(' Nos\u2026');
            expect(result).toHaveLength(5);
        });
    });

    describe('HARD_MAX_STATUS_LENGTH constant', () => {
        it('should be 80', () => {
            expect(HARD_MAX_STATUS_LENGTH).toBe(80);
        });
    });
});

describe('rejectSynopsis', () => {
    describe('accepted responses', () => {
        it.each([
            'Digging through memories for that thread...',
            'Wondering whether the Goldstein cite holds',
            'Three essays, one fix—where does it go?',
            'Rereading my own repair plan, wincing',
        ])('should accept the status line %s', (text) => {
            expect(rejectSynopsis(text)).toBeNull();
        });

        it('should accept a meta phrase that is not at the START of the line', () => {
            // Kills the ^-anchor mutant: without the anchor this legitimate thought is refused.
            const text = 'Digging for what I need to fix 9x7z';
            expect(text).toContain('I need to');
            expect(rejectSynopsis(text)).toBeNull();
        });

        it('should accept naming Izzy without a third-person verb after it', () => {
            expect(rejectSynopsis('Izzy and Craig, mid-repair 9x7z')).toBeNull();
        });

        it('should accept an empty string (the empty-response path handles it)', () => {
            expect(rejectSynopsis('')).toBeNull();
        });
    });

    describe('multiline', () => {
        it('should reject a response containing a newline', () => {
            expect(rejectSynopsis('Rereading the plan 9x7z\nContext: the repair')).toBe('multiline');
        });

        it('should reject multiline BEFORE any other reason', () => {
            // Straight from the production log: also meta, also over 80 chars. `multiline` wins.
            const text = "I need to capture what's actually happening in this moment for Izzy.\n\nContext: Craig asked";
            expect(text.length).toBeGreaterThan(HARD_MAX_STATUS_LENGTH);
            expect(rejectSynopsis(text)).toBe('multiline');
        });
    });

    describe('too_long', () => {
        it('should accept a response of exactly 80 characters', () => {
            const text = `Wondering whether the cite holds up 9x7z${'.'.repeat(40)}`;
            expect(text).toHaveLength(80);
            expect(rejectSynopsis(text)).toBeNull();
        });

        it('should reject a response of 81 characters', () => {
            const text = `Wondering whether the cite holds up 9x7z${'.'.repeat(41)}`;
            expect(text).toHaveLength(81);
            expect(rejectSynopsis(text)).toBe('too_long');
        });

        it('should reject on length BEFORE the meta check', () => {
            // Straight from the production log: also meta. `too_long` is checked first.
            const text = "Looking at what's happening here: Craig is asking me to take another pass at the prompt";
            expect(text.length).toBeGreaterThan(HARD_MAX_STATUS_LENGTH);
            expect(rejectSynopsis(text)).toBe('too_long');
        });
    });

    describe('meta', () => {
        it.each([
            'I need to capture what is happening',
            'I should describe the current moment',
            "I'm generating a status line now",
            "I'm going to write the status line",
            'Looking at this snapshot of the turn',
            "Looking at what's happening here",
            "Here's the status line you asked for",
            'Here is the status line',
            'Status: reading the config file',
            'Context: Craig asked about the cite',
            'Reading the context you handed me',
        ])('should reject the narration %s', (text) => {
            expect(text.length).toBeLessThanOrEqual(HARD_MAX_STATUS_LENGTH);
            expect(rejectSynopsis(text)).toBe('meta');
        });

        it('should match the meta openings case-insensitively', () => {
            expect(rejectSynopsis('i need to capture what is happening')).toBe('meta');
        });

        it('should reject meta BEFORE third person', () => {
            const text = 'I need to say Izzy is busy 9x7z';
            expect(rejectSynopsis(text)).toBe('meta');
        });

        it('should not reject a line that merely starts with a similar word', () => {
            expect(rejectSynopsis('Herewith the config, reread 9x7z')).toBeNull();
            expect(rejectSynopsis('Reading the config, not the plan')).toBeNull();
        });
    });

    describe('third_person', () => {
        it.each([
            'Izzy is deep in the config 9x7z',
            'Izzy was rereading the plan 9x7z',
            'Izzy needs a moment with the cite',
            'Izzy wants the other repair plan',
            'Isambard is chasing the hunch 9x7z',
        ])('should reject the third-person line %s', (text) => {
            expect(rejectSynopsis(text)).toBe('third_person');
        });

        it('should require a word boundary after the verb', () => {
            // "island" is not "is": the trailing \b keeps this from being read as third person.
            expect(rejectSynopsis('Izzy island, Craig mainland')).toBeNull();
        });

        it('should require a word boundary before the name', () => {
            expect(rejectSynopsis('McIzzy is not a name 9x7z')).toBeNull();
        });
    });
});

describe('DynamicStatusGenerator', () => {
    beforeEach(() => {
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockResolvedValue('Pondering deeply...');
        // Clear logger mocks - use try/catch in case another test corrupted the mock
        try {
            mockLogger.debug.mockClear();
            mockLogger.info.mockClear();
            mockLogger.warn.mockClear();
            mockLogger.error.mockClear();
        } catch{
            // Logger mocks may have been corrupted by another test modifying the logger object
            // This is a known issue with context-builder-loading.test.ts
        }
        // P14: cooldown/cache/in-flight state now lives per-instance (createDynamicStatusGenerator's
        // own closure), so a fresh `generator` per test — the existing pattern throughout this file —
        // already gives test isolation with no module-level reset needed.
    });

    afterEach(() => {
        // Reset system time in case any test used setSystemTime
        setSystemTime();
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);
    });

    describe('generateSynopsis', () => {
        describe('prompt construction - system prompt', () => {
            it('should include the identity context verbatim', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'I am Isambard, a curious 9x7z owl who loves learning',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const system = (mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string[])[0];
                expect(system).toContain('I am Isambard, a curious 9x7z owl who loves learning');
            });

            it('should not leave the {identityContext} placeholder in the system prompt', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Identity 9x7z',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const system = (mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string[])[0];
                expect(system).not.toContain('{identityContext}');
            });

            it('should state the status-line task, the 40-character cap and the first-person rule', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const system = (mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string[])[0];
                expect(system).toContain("You write Izzy's Discord status line");
                expect(system).toContain('at most 40 characters');
                expect(system).toContain('First person, present tense, one line, no more than 40 characters.');
            });

            it('should describe every labelled section the user prompt can carry', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const system = (mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string[])[0];
                expect(system).toContain('"Question being answered"');
                expect(system).toContain('"Most recent thinking"');
                expect(system).toContain('"Doing right now"');
                expect(system).toContain('"Recent tools"');
                expect(system).toContain('"Background work"');
                expect(system).toContain('"Previous status"');
                expect(system).toContain('Weight it most.');
            });

            it('should describe the "Doing right now" section exactly as the user prompt builds it', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const system = (mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string[])[0];
                expect(system).toContain('- "Doing right now": the current phase. For a tool call, also the tool, what it does, and the arguments. When any reply text has been written, also the newest part of it.');
            });

            it('should tell the model the previous status is there to be varied from', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const system = (mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string[])[0];
                expect(system).toContain('- "Previous status": the thought shown last time. Write a different one.');
            });

            it('should forbid third person, filler and meta-commentary, and end with the output rule', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const system = (mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string[])[0];
                expect(system).toContain('Third person, or naming Izzy');
                expect(system).toContain('Filler that fits any moment');
                expect(system).toContain('Describing the job of writing a status');
                expect(system).toContain('Quotation marks, markdown, emoji, or any explanation.');
                expect(system).toContain('Output only the thought.');
            });

            it('should show good and bad output examples, after the Never list and before the output rule', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const system = (mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string[])[0];
                expect(system).toContain('## Examples');
                expect(system).toContain('Good (each is a complete answer):');
                expect(system).toContain('- Digging through memories for that thread...');
                expect(system).toContain('- Wondering whether the Goldstein cite holds');
                expect(system).toContain('- Three essays, one fix—where does it go?');
                expect(system).toContain('- Rereading my own repair plan, wincing');
                expect(system).toContain('Bad (never answer like this):');
                expect(system).toContain("- I need to capture what's happening for Izzy...");
                expect(system).toContain('narrates the job instead of doing it');
                expect(system).toContain("- Looking at what's happening here: Craig is...");
                expect(system).toContain('commentary, third person');
                expect(system).toContain('- Thinking...');
                expect(system).toContain('filler');
                expect(system).toContain('- "Pondering the question"');
                expect(system).toContain('quotation marks');

                // Position, not just presence: the examples land between the Never list and the
                // closing output rule.
                expect(system.indexOf('## Examples')).toBeGreaterThan(system.indexOf('Quotation marks, markdown, emoji, or any explanation.'));
                expect(system.indexOf('## Examples')).toBeLessThan(system.indexOf('Output only the thought.'));
                expect(system).toEndWith('Output only the thought.');
            });

            it('should keep the instructions out of the user prompt (system and user are sent separately)', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Identity 9x7z',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).not.toContain("You write Izzy's Discord status line");
                expect(user).not.toContain('Identity 9x7z');
            });

            it('should send the system prompt as the [text, SYSTEM_PROMPT_DYNAMIC_BOUNDARY] array form for prompt caching', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Identity 9x7z',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const system = mockGenerateTextWithSystemPrompt.mock.calls[0][0] as string[];
                expect(Array.isArray(system)).toBe(true);
                expect(system).toHaveLength(2);
                expect(system[0]).toContain('Identity 9x7z');
                expect(system[1]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
            });

            it('should build the system prompt once per instance and hand the same array to every call', async () => {
                const baseTime = 2_000_000;
                setSystemTime(new Date(baseTime));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Identity 9x7z',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });
                setSystemTime(new Date(baseTime + 2001));
                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(2);
                expect(mockGenerateTextWithSystemPrompt.mock.calls[1][0]).toBe(mockGenerateTextWithSystemPrompt.mock.calls[0][0]);
            });
        });

        describe('prompt construction - user prompt: whole document', () => {
            it('should emit every section, in order, separated by blank lines', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'using_tool',
                    userMessage:     'Where is the config?',
                    thinkingContent: 'Maybe under src/config.',
                    toolDescription: 'Reading a file',
                    toolInput:       { path: '/src/config.ts' },
                    accumulatedText: 'Let me look.',
                    recentToolCalls: ['Grep', 'Read'],
                    subagentSummary: 'Scout is scanning docs.',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toBe([
                    '## Question being answered',
                    'Where is the config?',
                    '',
                    '## Most recent thinking',
                    'Maybe under src/config.',
                    '',
                    '## Doing right now',
                    'Phase: Using a tool',
                    'Tool: Reading a file',
                    'Arguments: {"path":"/src/config.ts"}',
                    'Reply so far: Let me look.',
                    '',
                    '## Recent tools',
                    'Searching file contents, Reading a file',
                    '',
                    '## Background work',
                    'Scout is scanning docs.',
                    '',
                    CLOSING_ASK,
                ].join('\n'));
            });

            it('should append the "Previous status" section last, after Background work', async () => {
                const baseTime = 3_000_000;
                setSystemTime(new Date(baseTime));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                mockGenerateTextWithSystemPrompt.mockResolvedValue('Chasing a hunch 9x7z');
                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Question 9x7z' });

                setSystemTime(new Date(baseTime + 2001));
                await generator.generateSynopsis({
                    phase:           'responding',
                    userMessage:     'Question 9x7z',
                    subagentSummary: 'Sub 9x7z',
                });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[1][1];
                expect(user).toBe([
                    '## Question being answered',
                    'Question 9x7z',
                    '',
                    '## Doing right now',
                    'Phase: Writing the reply',
                    '',
                    '## Background work',
                    'Sub 9x7z',
                    '',
                    '## Previous status',
                    'Chasing a hunch 9x7z',
                    '',
                    CLOSING_ASK,
                ].join('\n'));
            });

            it('should emit only the "Doing right now" section when nothing else is present', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: '',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toBe(`## Doing right now\nPhase: Just received the question, starting to think\n\n${CLOSING_ASK}`);
            });

            it('should keep sections in the fixed order even when the middle ones are missing', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'responding',
                    userMessage:     'Question 9x7z',
                    recentToolCalls: ['Read'],
                    subagentSummary: 'Sub 9x7z',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toBe([
                    '## Question being answered',
                    'Question 9x7z',
                    '',
                    '## Doing right now',
                    'Phase: Writing the reply',
                    '',
                    '## Recent tools',
                    'Reading a file',
                    '',
                    '## Background work',
                    'Sub 9x7z',
                    '',
                    CLOSING_ASK,
                ].join('\n'));
            });
        });

        describe('prompt construction - the closing ask', () => {
            // Without a question at the end, the sections read as a document to comment on, and
            // Haiku answers with narration ("Looking at what's happening here: Craig is...").
            it.each<SynopsisContext['phase']>(['thinking', 'using_tool', 'responding'])('should end the %s user prompt with the ask', async (phase) => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({
                    phase,
                    userMessage:     'Where is the config?',
                    toolName:        'Read',
                    thinkingContent: 'Maybe under src/config 9x7z',
                    accumulatedText: 'Let me look 9x7z',
                    recentToolCalls: ['Grep'],
                    subagentSummary: 'Scout is scanning docs 9x7z',
                });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toEndWith(`\n\n${CLOSING_ASK}`);
                // Once, and only as the tail — never spliced in among the sections.
                expect(user.indexOf(CLOSING_ASK)).toBe(user.lastIndexOf(CLOSING_ASK));
                expect(user).toContain('Scout is scanning docs 9x7z');
            });
        });

        describe('prompt construction - "Question being answered" section', () => {
            it('should include the user message under its own heading', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'How do I implement authentication?',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('## Question being answered\nHow do I implement authentication?');
            });

            it('should truncate the user message to the first 200 characters', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const longMessage = `${'q'.repeat(200)}TAIL9x7z`;
                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: longMessage,
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain(`## Question being answered\n${'q'.repeat(200)}\n\n## Doing right now`);
                expect(user).not.toContain('TAIL9x7z');
            });

            it('should omit the section entirely when the user message is empty', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: '',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).not.toContain('## Question being answered');
            });
        });

        describe('prompt construction - "Most recent thinking" section', () => {
            it('should include the thinking content under its own heading', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'thinking',
                    userMessage:     'Test',
                    thinkingContent: 'The user wants authentication advice',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('## Most recent thinking\nThe user wants authentication advice');
            });

            it('should keep the LAST 500 characters of thinking content, not the first', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                // 628 chars: the first 128 (head marker + filler) must fall outside a 500-char tail
                const thinkingContent = `HEADMARKER9x7z${'.'.repeat(600)}TAILMARKER9x7z`;
                expect(thinkingContent).toHaveLength(628);

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                    thinkingContent,
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                // Exact 500-char tail: kills both "no slice at all" and "slice(+500)" mutants
                expect(user).toContain(`## Most recent thinking\n${thinkingContent.slice(-500)}\n\n## Doing right now`);
                expect(user).toContain('TAILMARKER9x7z');
                expect(user).not.toContain('HEADMARKER9x7z');
            });

            it('should include short thinking content untouched', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const thinkingContent = 'x'.repeat(499);
                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                    thinkingContent,
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain(`## Most recent thinking\n${thinkingContent}\n\n## Doing right now`);
            });

            it('should omit the section when thinkingContent is undefined', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).not.toContain('## Most recent thinking');
            });

            it('should omit the section when thinkingContent is an empty string', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'thinking',
                    userMessage:     'Test',
                    thinkingContent: '',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).not.toContain('## Most recent thinking');
            });

            it('should include the newest thinking in the using_tool phase', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'using_tool',
                    userMessage:     'Test',
                    toolName:        'Read',
                    thinkingContent: 'Checking the config file 9x7z',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('## Most recent thinking\nChecking the config file 9x7z');
            });

            it('should include the newest thinking in the responding phase', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'responding',
                    userMessage:     'Test',
                    thinkingContent: 'Wording the answer 9x7z',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('## Most recent thinking\nWording the answer 9x7z');
            });
        });

        describe('prompt construction - "Doing right now" section', () => {
            it('should label the turn\'s very first thinking synopsis as just-received', async () => {
                // Built from the user message alone: no thinking has streamed and no tool has run.
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('## Doing right now\nPhase: Just received the question, starting to think');
            });

            it('should label a thinking phase that already has thinking content as mid-turn', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test', thinkingContent: 'Weighing options 9x7z' });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('Phase: Thinking about the next step');
                expect(user).not.toContain('Just received the question');
            });

            it('should label a thinking phase that already has tool history as mid-turn', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test', recentToolCalls: ['Read'] });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('Phase: Thinking about the next step');
                expect(user).not.toContain('Just received the question');
            });

            it('should treat an empty recentToolCalls array as no tool history yet', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test', recentToolCalls: [] });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('Phase: Just received the question, starting to think');
            });

            it('should label the using_tool phase', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'using_tool', userMessage: 'Test', toolName: 'Read' });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('## Doing right now\nPhase: Using a tool');
            });

            it('should label the responding phase', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'responding', userMessage: 'Test' });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('## Doing right now\nPhase: Writing the reply');
            });

            it('should include the tool description and arguments for using_tool', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'using_tool',
                    userMessage:     'Test',
                    toolName:        'mcp__memory__search',
                    toolDescription: 'Searching through memories 9x7z',
                    toolInput:       { query: 'auth' },
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('Phase: Using a tool\nTool: Searching through memories 9x7z\nArguments: {"query":"auth"}');
            });

            it('should look up the tool description from ToolDescriptions when none is provided', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                    toolName:    'mcp__memory__search',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('Tool: Searching through memories\n');
            });

            it('should fall back to the raw tool name when no description is known', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                    toolName:    'unknown_tool_9x7z',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('Tool: unknown_tool_9x7z\n');
            });

            it('should fall back to "unknown tool" when no tool name is provided', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('Tool: unknown tool\n');
            });

            it('should show "(no input)" when the tool input is undefined', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                    toolName:    'Read',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('Arguments: (no input)');
            });

            it('should show "(no input)" when the tool input is null', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                    toolName:    'Read',
                    toolInput:   null,
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('Arguments: (no input)');
            });

            it('should truncate long tool input to 200 characters plus an ellipsis', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                    toolName:    'Read',
                    toolInput:   { data: 'y'.repeat(300) },
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                const json = JSON.stringify({ data: 'y'.repeat(300) });
                expect(user).toContain(`Arguments: ${json.slice(0, 200)}...`);
                expect(user).not.toContain(json);
            });

            it('should NOT emit Tool or Arguments lines outside the using_tool phase', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                    toolName:    'Read',
                    toolInput:   { path: '/tmp/x' },
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).not.toContain('Tool:');
                expect(user).not.toContain('Arguments:');
            });
        });

        describe('prompt construction - "Reply so far" line', () => {
            it('should keep the LAST 150 characters of accumulated text, not the first', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const accumulatedText = `HEADACC9x7z${'a'.repeat(200)}TAILACC9x7z`;
                const context: SynopsisContext = {
                    phase:       'responding',
                    userMessage: 'Test',
                    accumulatedText,
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain(`Reply so far: ${accumulatedText.slice(-150)}`);
                expect(user).toContain('TAILACC9x7z');
                expect(user).not.toContain('HEADACC9x7z');
            });

            it('should include short accumulated text untouched', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'responding',
                    userMessage:     'Test',
                    accumulatedText: 'Half a sentence so far 9x7z',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('Phase: Writing the reply\nReply so far: Half a sentence so far 9x7z');
            });

            it('should omit the line when there is no accumulated text', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'responding',
                    userMessage: 'Test',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).not.toContain('Reply so far');
            });

            it('should omit the line when the accumulated text is an empty string', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'responding',
                    userMessage:     'Test',
                    accumulatedText: '',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).not.toContain('Reply so far');
            });

            it('should include the line in the using_tool phase, after the Arguments line', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'using_tool',
                    userMessage:     'Test',
                    toolName:        'Read',
                    toolInput:       { path: '/tmp/x' },
                    accumulatedText: 'Partial answer 9x7z',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('Arguments: {"path":"/tmp/x"}\nReply so far: Partial answer 9x7z');
            });

            it('should include the line in the thinking phase', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'thinking',
                    userMessage:     'Test',
                    accumulatedText: 'Earlier words 9x7z',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('Phase: Just received the question, starting to think\nReply so far: Earlier words 9x7z');
            });
        });

        describe('prompt construction - "Recent tools" section', () => {
            it('should render each tool through its human-readable description, joined with ", " in the order given (newest first)', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'thinking',
                    userMessage:     'Test',
                    recentToolCalls: ['Read', 'Grep', 'Bash'],
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('## Recent tools\nReading a file, Searching file contents, Running a command');
            });

            it('should fall back to the raw tool name for a tool with no known description', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'thinking',
                    userMessage:     'Test',
                    recentToolCalls: ['Read', 'mystery_tool_9x7z'],
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('## Recent tools\nReading a file, mystery_tool_9x7z');
            });

            it('should omit the section when recentToolCalls is undefined', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).not.toBeNull();
                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).not.toContain('## Recent tools');
            });

            it('should omit the section when recentToolCalls is empty', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'thinking',
                    userMessage:     'Test',
                    recentToolCalls: [],
                };

                const result = await generator.generateSynopsis(context);

                expect(result).not.toBeNull();
                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).not.toContain('## Recent tools');
            });

            it('should emit a single recent tool without a separator', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'thinking',
                    userMessage:     'Test',
                    recentToolCalls: ['Read'],
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('## Recent tools\nReading a file');
                expect(user).not.toContain('Reading a file,');
            });
        });

        describe('prompt construction - "Background work" section', () => {
            it('should include the subagent summary under its own heading', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'thinking',
                    userMessage:     'Test',
                    subagentSummary: 'Scout is reading the changelog 9x7z',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).toContain('## Background work\nScout is reading the changelog 9x7z');
            });

            it('should omit the section when there is no subagent summary', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).not.toContain('## Background work');
            });

            it('should omit the section when the subagent summary is an empty string', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:           'thinking',
                    userMessage:     'Test',
                    subagentSummary: '',
                };

                await generator.generateSynopsis(context);

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).not.toContain('## Background work');
            });
        });

        describe('prompt construction - "Previous status" section', () => {
            // The system prompt tells the model to make each thought different from the last, so
            // it has to actually be shown the last one.
            it('should omit the section on the first call, when there is nothing shown yet', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(user).not.toContain('## Previous status');
            });

            it('should carry the previous call\'s result on the next call from the same instance', async () => {
                const baseTime = 4_000_000;
                setSystemTime(new Date(baseTime));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                mockGenerateTextWithSystemPrompt.mockResolvedValue('Retracing the config path 9x7z');
                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                setSystemTime(new Date(baseTime + 2001));
                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[1][1];
                expect(user).toContain('## Previous status\nRetracing the config path 9x7z');
            });

            it('should not share the previous status across generator instances', async () => {
                const baseTime = 5_000_000;
                setSystemTime(new Date(baseTime));

                const first = createDynamicStatusGenerator({ identityContext: 'Test identity' });
                const second = createDynamicStatusGenerator({ identityContext: 'Test identity' });

                mockGenerateTextWithSystemPrompt.mockResolvedValue('Only the first instance saw this 9x7z');
                await first.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                setSystemTime(new Date(baseTime + 2001));
                await second.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[1][1];
                expect(user).not.toContain('## Previous status');
            });
        });

        describe('output handling', () => {
            it('should keep a response of exactly HARD_MAX_STATUS_LENGTH (80) characters', async () => {
                const text = `Wondering whether the cite holds up 9x7z${'.'.repeat(40)}`;
                expect(text).toHaveLength(HARD_MAX_STATUS_LENGTH);
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(text));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const result = await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                expect(result).toBe(text);
                expect(result!.length).toBeLessThanOrEqual(HARD_MAX_STATUS_LENGTH);
            });

            it('should reject a response one character over the cap instead of truncating it', async () => {
                const text = `Wondering whether the cite holds up 9x7z${'.'.repeat(41)}`;
                expect(text).toHaveLength(HARD_MAX_STATUS_LENGTH + 1);
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(text));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const result = await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                expect(result).toBeNull();
            });

            it('should reject a multiline response', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Rereading the plan 9x7z\nContext: the repair'));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const result = await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                expect(result).toBeNull();
            });

            it('should reject a narration of the task', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve("I need to capture what's happening 9x7z"));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const result = await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                expect(result).toBeNull();
            });

            it('should reject a third-person response', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Izzy is deep in the config 9x7z'));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const result = await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                expect(result).toBeNull();
            });

            it.each([
                ['straight', '"Chasing a hunch 9x7z"'],
                ['curly', '“Chasing a hunch 9x7z”'],
            ])('should strip one pair of surrounding %s double quotes', async (_label, quoted) => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(quoted));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const result = await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                expect(result).toBe('Chasing a hunch 9x7z');
            });

            it('should leave quotes that are not a surrounding pair alone', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Wondering if "cite" holds 9x7z'));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const result = await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                expect(result).toBe('Wondering if "cite" holds 9x7z');
            });

            it('should leave a status that merely ENDS with a quoted word alone', async () => {
                // Kills the ^-anchor mutant: unanchored, this would swallow the inner quotes.
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Wondering about "the cite"'));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const result = await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                expect(result).toBe('Wondering about "the cite"');
            });

            it('should leave a status that merely STARTS with a quoted word alone', async () => {
                // Kills the $-anchor mutant: without it, the leading quoted word would be unwrapped.
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('"the cite" still holds 9x7z'));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const result = await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                expect(result).toBe('"the cite" still holds 9x7z');
            });

            it('should strip the quotes BEFORE validating, so a quoted narration is still rejected', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('"I need to capture what\'s happening 9x7z"'));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const result = await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                expect(result).toBeNull();
            });

            it('should leave the cached status untouched when a response is rejected', async () => {
                const baseTime = 6_000_000;
                setSystemTime(new Date(baseTime));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                mockGenerateTextWithSystemPrompt.mockResolvedValueOnce('Chasing a good hunch 9x7z');
                expect(await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' })).toBe('Chasing a good hunch 9x7z');

                setSystemTime(new Date(baseTime + 2001));
                mockGenerateTextWithSystemPrompt.mockResolvedValueOnce("I need to capture what's happening 9x7z");
                expect(await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' })).toBeNull();

                // Within the rejected call's cooldown: the cache still holds the last GOOD status.
                expect(await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' })).toBe('Chasing a good hunch 9x7z');
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(2);

                // And the next real call carries the good status forward, not the rejected text.
                setSystemTime(new Date(baseTime + 4002));
                mockGenerateTextWithSystemPrompt.mockResolvedValueOnce('Rereading the repair plan 9x7z');
                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                const user = mockGenerateTextWithSystemPrompt.mock.calls[2][1];
                expect(user).toContain('## Previous status\nChasing a good hunch 9x7z');
                expect(user).not.toContain('I need to capture');
            });

            it('should trim whitespace from output', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('  Pondering...  '));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Pondering...');
                expect(result).not.toMatch(/^\s/);
                expect(result).not.toMatch(/\s$/);
            });
        });

        describe('fallback behavior', () => {
            it('should return null on error for thinking phase', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() =>
                    Promise.reject(new Error('API error'))
                );

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBeNull();
            });

            it('should return null on error for using_tool phase', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() =>
                    Promise.reject(new Error('API error'))
                );

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                    toolName:    'some_tool',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBeNull();
            });

            it('should return null on error for responding phase', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() =>
                    Promise.reject(new Error('API error'))
                );

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'responding',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBeNull();
            });

            it('should return null on empty response', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve(''));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBeNull();
            });

            it('should return null on whitespace-only response', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('   '));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'responding',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBeNull();
            });
        });

        describe('cooldown', () => {
            it('should throttle rapid calls within 2 second cooldown', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First call should go through
                await generator.generateSynopsis(context);
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(1);

                // Second call within cooldown window should use cache
                await generator.generateSynopsis(context);
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(1);
            });

            it('should use cached status when within cooldown', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('First status'));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                const first = await generator.generateSynopsis(context);
                expect(first).toBe('First status');

                // Change the mock for second call (but it should use cache)
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Second status'));

                const second = await generator.generateSynopsis(context);
                expect(second).toBe('First status'); // Should use cached value
            });

            it('should allow call after cooldown period expires', async () => {
                const baseTime = 2_000_000;
                setSystemTime(new Date(baseTime));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First call
                await generator.generateSynopsis(context);
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(1);

                // Advance real (system) time past the 2s cooldown window
                setSystemTime(new Date(baseTime + 2001));

                // Now call should go through
                await generator.generateSynopsis(context);
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(2);

                setSystemTime();
            });

            it('should make real API call when within cooldown window but cache is null', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First call fails, cache stays null
                mockGenerateTextWithSystemPrompt.mockRejectedValueOnce(new Error('fail'));
                await generator.generateSynopsis(context); // fails, null returned, cache stays null

                // Second call within cooldown window - should NOT use null cache
                mockGenerateTextWithSystemPrompt.mockResolvedValueOnce('Success after fail');
                const result = await generator.generateSynopsis(context);

                // With && mutation to ||: would return null (cachedStatus)
                // With original &&: makes real call since cachedStatus is null
                expect(result).toBe('Success after fail');
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(2);
            });

            it('should verify cache is updated and used on subsequent cooldown calls', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                mockGenerateTextWithSystemPrompt.mockResolvedValue('Cached successfully');

                // First call - should cache the result
                const first = await generator.generateSynopsis(context);
                expect(first).toBe('Cached successfully');

                // Change mock to return different value
                mockGenerateTextWithSystemPrompt.mockResolvedValue('Should not see this');

                // Second call within cooldown - should use cached value
                const second = await generator.generateSynopsis(context);
                expect(second).toBe('Cached successfully');
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(1); // Only called once
            });

            it('should call API when exactly at cooldown boundary (2000ms)', async () => {
                // Use fake timers to test exact 2000ms boundary
                // With post-completion cooldown, lastHaikuCall is set in `finally` after the await.
                // Since mockGenerateTextWithSystemPrompt resolves immediately, lastHaikuCall = Date.now() at call time.
                const baseTime = 1_000_000;
                setSystemTime(new Date(baseTime));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                mockGenerateTextWithSystemPrompt.mockResolvedValue('First call');

                // Call 1: t=baseTime, should call API. lastHaikuCall set to baseTime in finally.
                await generator.generateSynopsis(context);
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(1);

                mockGenerateTextWithSystemPrompt.mockResolvedValue('Second call');

                // Call 2: t=baseTime+1999ms, should use cache (within cooldown window)
                setSystemTime(new Date(baseTime + 1999));
                const result1999 = await generator.generateSynopsis(context);
                expect(result1999).toBe('First call');
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(1);

                // Call 3: t=baseTime+2000ms, should call API again (exactly at boundary)
                // This tests the < vs <= mutation: with <, 2000ms should make new call
                setSystemTime(new Date(baseTime + 2000));
                const result2000 = await generator.generateSynopsis(context);
                expect(result2000).toBe('Second call');
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(2);

                // Reset system time
                setSystemTime();
            });

            it('should cancel previous in-flight call and start a new one (cancel-and-replace)', async () => {
                // Cancel-and-replace: when a call is in-flight, a second call aborts the first
                // and starts a new one. The first call resolves to '' (aborted), the second
                // call wins and returns its result.
                let firstAbortController!: AbortController;

                // First call: capture the abort controller, return a value that's only
                // produced if not aborted
                mockGenerateTextWithSystemPrompt.mockImplementationOnce(
                    async (_system: string | string[], _user: string, opts?: { abortController?: AbortController }) => {
                        firstAbortController = opts?.abortController ?? new AbortController();
                        // Wait until aborted
                        await new Promise<void>((resolve) => {
                            firstAbortController.signal.addEventListener('abort', () => resolve(), { once: true });
                        });
                        // Return empty string (aborted)
                        return '';
                    }
                );
                mockGenerateTextWithSystemPrompt.mockResolvedValueOnce('Second call wins');

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // Start first call (will be in-flight, waiting for abort)
                const firstCallPromise = generator.generateSynopsis(context);

                // Second call cancels the first and starts fresh
                const second = await generator.generateSynopsis(context);
                expect(second).toBe('Second call wins');

                // First call was aborted — it resolves to null (aborted returns '')
                const first = await firstCallPromise;
                expect(first).toBeNull();
            });

            it('should pass abortController to generateTextWithSystemPrompt so cancel-and-replace works', async () => {
                let capturedController: AbortController | undefined;
                mockGenerateTextWithSystemPrompt.mockImplementationOnce(
                    async (_system: string | string[], _user: string, opts?: { abortController?: AbortController }) => {
                        capturedController = opts?.abortController;
                        return 'result';
                    }
                );

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                await generator.generateSynopsis(context);

                // abortController should have been passed to generateTextWithSystemPrompt
                expect(capturedController).toBeInstanceOf(AbortController);
            });

            it('should clear inFlightController after call completes so next call starts fresh', async () => {
                // After a call completes successfully, the inFlightController should be null.
                // A subsequent call within cooldown (with cache) should return cache, NOT null.
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First call completes successfully
                mockGenerateTextWithSystemPrompt.mockResolvedValueOnce('Cached status');
                const first = await generator.generateSynopsis(context);
                expect(first).toBe('Cached status');

                // Second call within cooldown — should use cache (inFlightController is null)
                const second = await generator.generateSynopsis(context);
                expect(second).toBe('Cached status');
            });

            it('should clear inFlightController on error so subsequent cooldown calls use cache', async () => {
                const baseTime = 1_000_000;
                setSystemTime(new Date(baseTime));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First call succeeds — populates cache
                mockGenerateTextWithSystemPrompt.mockResolvedValueOnce('Cached from success');
                const first = await generator.generateSynopsis(context);
                expect(first).toBe('Cached from success');

                // Advance time past cooldown window to allow a second real call
                setSystemTime(new Date(baseTime + 3000));

                // Second call fails — finally block should still clear inFlightController
                mockGenerateTextWithSystemPrompt.mockRejectedValueOnce(new Error('API error'));
                const second = await generator.generateSynopsis(context);
                expect(second).toBeNull(); // Error returns null

                // Third call within cooldown window of second call — should use cached status from first call
                // If inFlightController were still set, this would behave differently
                const third = await generator.generateSynopsis(context);
                expect(third).toBe('Cached from success');
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(2); // Only 2 real calls, third used cache

                setSystemTime();
            });
        });

        describe('logging', () => {
            // Note: These logging tests verify that the production code logs correctly.
            // Due to Bun's mock.module behavior, the logger mock can be corrupted by
            // other tests (specifically context-builder-loading.test.ts which modifies
            // logger.debug directly). When the mock is corrupted, the production code
            // sees a non-functional logger that doesn't record calls.
            //
            // These tests work correctly when run in isolation. When run with the full
            // suite, we skip assertions if the mock has been corrupted.

            it('should log debug before generating synopsis', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'A test message',
                };

                await generator.generateSynopsis(context);

                expect(mockLogger.debug).toHaveBeenCalledWith({
                    phase:             'thinking',
                    userMessageLength: 14,
                    msg:               'Generating synopsis with Haiku',
                });
            });

            it('should log info on successful generation', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Pondering code...'));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                await generator.generateSynopsis(context);

                expect(mockLogger.info).toHaveBeenCalledWith({
                    phase:      'thinking',
                    statusText: 'Pondering code...',
                    msg:        'Generated dynamic status',
                });
            });

            it('should log error on failure', async () => {
                const testError = new Error('API failure');
                mockGenerateTextWithSystemPrompt.mockImplementation(() =>
                    Promise.reject(testError)
                );

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'responding',
                    userMessage: 'Test',
                };

                await generator.generateSynopsis(context);

                expect(mockLogger.error).toHaveBeenCalledWith({
                    error: testError,
                    phase: 'responding',
                    msg:   'Failed to generate synopsis',
                });
            });

            it('should log warn with the rejected text and reason when a response is refused', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('  "Izzy is deep in the config 9x7z"  '));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'responding', userMessage: 'Test' });

                // The trimmed, unquoted candidate is what was judged, so it is what gets logged.
                expect(mockLogger.warn).toHaveBeenCalledWith({
                    rejectedText: 'Izzy is deep in the config 9x7z',
                    reason:       'third_person',
                    phase:        'responding',
                    msg:          'Rejected synopsis',
                });
                expect(mockLogger.info).not.toHaveBeenCalled();
            });

            it('should not log warn when the response is accepted', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Rereading the repair plan 9x7z'));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                await generator.generateSynopsis({ phase: 'thinking', userMessage: 'Test' });

                expect(mockLogger.warn).not.toHaveBeenCalled();
            });

            it('should log debug when cancelling a previous in-flight call', async () => {
                let firstAbortController!: AbortController;
                mockGenerateTextWithSystemPrompt.mockImplementationOnce(
                    async (_system: string | string[], _user: string, opts?: { abortController?: AbortController }) => {
                        firstAbortController = opts?.abortController ?? new AbortController();
                        await new Promise<void>((resolve) => {
                            firstAbortController.signal.addEventListener('abort', () => resolve(), { once: true });
                        });
                        return '';
                    }
                );
                mockGenerateTextWithSystemPrompt.mockResolvedValueOnce('Second call wins');

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                    toolName:    'Read',
                };

                // First call stays in-flight; the second cancels it and must log the cancellation
                const firstCallPromise = generator.generateSynopsis(context);
                await generator.generateSynopsis(context);
                await firstCallPromise;

                expect(mockLogger.debug).toHaveBeenCalledWith({
                    phase: 'using_tool',
                    msg:   'Cancelling previous in-flight synopsis call',
                });
            });

            it('should log debug when call is within cooldown', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First call
                await generator.generateSynopsis(context);
                mockLogger.debug.mockClear();

                // Second call (within cooldown)
                await generator.generateSynopsis(context);

                expect(mockLogger.debug).toHaveBeenCalledWith({
                    phase: 'thinking',
                    msg:   'Haiku call within cooldown, using cached status',
                });
            });

            it('should not log info when using cached/cooldown status', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First call
                await generator.generateSynopsis(context);
                mockLogger.info.mockClear();

                // Second call (within cooldown)
                await generator.generateSynopsis(context);

                expect(mockLogger.info).not.toHaveBeenCalled();
            });
        });

        describe('each phase type', () => {
            it('should handle thinking phase correctly', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Pondering the question...'));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Pondering the question...');
            });

            it('should handle using_tool phase correctly', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Consulting memories...'));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Find something',
                    toolName:    'mcp__memory__search',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Consulting memories...');
            });

            it('should handle responding phase correctly', async () => {
                mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Crafting a response...'));

                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'responding',
                    userMessage: 'Test',
                };

                const result = await generator.generateSynopsis(context);

                expect(result).toBe('Crafting a response...');
            });
        });

        describe('multiple generators (P14: per-instance cooldown/cache/in-flight state)', () => {
            it('does NOT share cooldown state across generators — a second instance is not gated by the first\'s cooldown', async () => {
                const generator1 = createDynamicStatusGenerator({
                    identityContext: 'Identity 1',
                });
                const generator2 = createDynamicStatusGenerator({
                    identityContext: 'Identity 2',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                // First generator call
                await generator1.generateSynopsis(context);
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(1);

                // Second generator, called immediately after, must NOT be gated by generator1's
                // cooldown — each instance keeps its own cooldown clock.
                await generator2.generateSynopsis(context);
                expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalledTimes(2);
            });

            it('does NOT share cache across generators — a second instance never returns the first\'s cached status', async () => {
                const generator1 = createDynamicStatusGenerator({
                    identityContext: 'Identity 1',
                });
                const generator2 = createDynamicStatusGenerator({
                    identityContext: 'Identity 2',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                mockGenerateTextWithSystemPrompt.mockResolvedValueOnce('Generator 1 status');
                const first = await generator1.generateSynopsis(context);
                expect(first).toBe('Generator 1 status');

                mockGenerateTextWithSystemPrompt.mockResolvedValueOnce('Generator 2 status');
                const second = await generator2.generateSynopsis(context);
                expect(second).toBe('Generator 2 status');
            });

            it('instance B\'s call does not abort instance A\'s STILL-IN-FLIGHT AbortController', async () => {
                const generator1 = createDynamicStatusGenerator({
                    identityContext: 'Identity 1',
                });
                const generator2 = createDynamicStatusGenerator({
                    identityContext: 'Identity 2',
                });

                const context: SynopsisContext = {
                    phase:       'thinking',
                    userMessage: 'Test',
                };

                let firstAbortController: AbortController | undefined;
                let abortFired = false;
                let resolveFirstCall!: (value: string) => void;

                // Generator1's call hangs until we resolve it below — it is still in-flight
                // when generator2's call runs, which is the only way to observe a shared
                // (module-level) in-flight controller getting aborted by a second instance.
                mockGenerateTextWithSystemPrompt.mockImplementationOnce(
                    async (_system: string | string[], _user: string, opts?: { abortController?: AbortController }) => {
                        firstAbortController = opts?.abortController;
                        firstAbortController?.signal.addEventListener('abort', () => {
                            abortFired = true;
                        }, { once: true });
                        return new Promise<string>((resolve) => {
                            resolveFirstCall = resolve;
                        });
                    }
                );

                // Start generator1's call but do NOT await it yet — it stays in-flight.
                const firstCallPromise = generator1.generateSynopsis(context);
                // Let the mock implementation run far enough to capture its AbortController.
                await Promise.resolve();
                expect(firstAbortController).toBeDefined();

                // generator2's call runs to completion WHILE generator1's call is still pending.
                // It must use its own AbortController and never touch generator1's.
                mockGenerateTextWithSystemPrompt.mockResolvedValueOnce('Generator 2 result');
                const second = await generator2.generateSynopsis(context);
                expect(second).toBe('Generator 2 result');

                expect(abortFired).toBe(false);

                // Clean up: let generator1's still-pending call resolve.
                resolveFirstCall('Generator 1 result');
                const first = await firstCallPromise;
                expect(first).toBe('Generator 1 result');
            });
        });

        describe('formatToolInputSummary edge cases', () => {
            it('should handle circular references gracefully', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                // Create a circular reference
                const circular: Record<string, unknown> = { a: 1 };
                circular.self = circular;

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                    toolName:    'Read',
                    toolInput:   circular,
                };

                await generator.generateSynopsis(context);

                const prompt = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(prompt).toContain('(complex input)');
            });

            it('should handle BigInt gracefully', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                    toolName:    'Read',
                    toolInput:   { value: 12_345n },
                };

                await generator.generateSynopsis(context);

                const prompt = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                expect(prompt).toContain('(complex input)');
            });

            it('should handle short JSON input without truncation', async () => {
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                    toolName:    'Read',
                    toolInput:   { path: '/short' },
                };

                await generator.generateSynopsis(context);

                const prompt = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                // Should contain the full JSON without trailing ...
                expect(prompt).toContain('{"path":"/short"}');
                // The tool input summary should NOT be truncated (no trailing ... after the JSON)
                expect(prompt).not.toContain('{"path":"/short"}...');
            });

            it('should include exactly 200-char JSON without truncation (boundary test)', async () => {
                // This test kills the mutant that changes <= to < at line 124
                // MAX_TOOL_INPUT_LENGTH is 200, so a 200-char JSON should NOT be truncated
                const generator = createDynamicStatusGenerator({
                    identityContext: 'Test identity',
                });

                // Create an object whose JSON stringification is exactly 200 characters
                // {"data":"..."} is 11 chars for the wrapper, so we need 189 x's
                const exactInput = { data: 'x'.repeat(189) };
                const json = JSON.stringify(exactInput);
                expect(json).toHaveLength(200); // Verify our test setup is correct

                const context: SynopsisContext = {
                    phase:       'using_tool',
                    userMessage: 'Test',
                    toolName:    'Read',
                    toolInput:   exactInput,
                };

                await generator.generateSynopsis(context);

                const prompt = mockGenerateTextWithSystemPrompt.mock.calls[0][1];
                // With <= : 200 chars passes, returns JSON as-is (no ellipsis)
                // With < mutant: 200 chars fails, returns JSON.slice(0,200) + "..." (adds ellipsis)
                expect(prompt).toContain(json);
                expect(prompt).not.toContain(`${json}...`);
            });
        });
    });
});

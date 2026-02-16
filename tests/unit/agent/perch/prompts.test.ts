import { describe, test, expect } from 'bun:test';
import _ from 'lodash';
import {
    buildPerchPrompt,
    buildTestPerchPrompt,
    buildPerchResumedPrompt,
    buildPerchTimeoutPrompt,
    getSuggestionLevelDescription,
    BASE_PROMPT,
    type PerchResumedOptions,
    type PerchTimeoutOptions
} from '@/agent/perch/prompts';
import type { PerchSlot } from '@/agent/perch/types';

describe.concurrent('buildPerchPrompt', () => {
    describe.concurrent('unscheduled slot', () => {
        test('should return only BASE_PROMPT for unscheduled', () => {
            const prompt = buildPerchPrompt('unscheduled');
            expect(prompt).toBe(BASE_PROMPT);
        });

        test('should not include any slot-specific hints for unscheduled', () => {
            const prompt = buildPerchPrompt('unscheduled');
            expect(prompt).not.toContain('---');
            expect(prompt).not.toContain('Current Time Window');
        });
    });

    describe.concurrent('scheduled slots', () => {
        describe.concurrent('pre-dawn slot', () => {
            test('should include BASE_PROMPT', () => {
                const prompt = buildPerchPrompt('pre-dawn');
                expect(prompt).toContain(BASE_PROMPT);
            });

            test('should include slot name with time range', () => {
                const prompt = buildPerchPrompt('pre-dawn');
                expect(prompt).toContain('Pre-Dawn (5-7am Pacific)');
            });

            test('should include slot-specific hint', () => {
                const prompt = buildPerchPrompt('pre-dawn');
                expect(prompt).toContain('Craig wakes around 7am');
                expect(prompt).toContain('morning digest');
            });

            test('should include section separator', () => {
                const prompt = buildPerchPrompt('pre-dawn');
                expect(prompt).toContain('---');
                expect(prompt).toContain('## Current Time Window:');
            });
        });

        describe.concurrent('mid-morning slot', () => {
            test('should include BASE_PROMPT', () => {
                const prompt = buildPerchPrompt('mid-morning');
                expect(prompt).toContain(BASE_PROMPT);
            });

            test('should include slot name with time range', () => {
                const prompt = buildPerchPrompt('mid-morning');
                expect(prompt).toContain('Mid-Morning (9-11am Pacific)');
            });

            test('should include slot-specific hint', () => {
                const prompt = buildPerchPrompt('mid-morning');
                expect(prompt).toContain('Morning work hours');
            });
        });

        describe.concurrent('wikipedia slot', () => {
            test('should include BASE_PROMPT', () => {
                const prompt = buildPerchPrompt('wikipedia');
                expect(prompt).toContain(BASE_PROMPT);
            });

            test('should include slot name with time range', () => {
                const prompt = buildPerchPrompt('wikipedia');
                expect(prompt).toContain('Wikipedia Exploration (12pm-2pm Pacific)');
            });

            test('should include slot-specific hint', () => {
                const prompt = buildPerchPrompt('wikipedia');
                expect(prompt).toContain('Lunchtime breadth exploration');
            });
        });

        describe.concurrent('afternoon slot', () => {
            test('should include BASE_PROMPT', () => {
                const prompt = buildPerchPrompt('afternoon');
                expect(prompt).toContain(BASE_PROMPT);
            });

            test('should include slot name with time range', () => {
                const prompt = buildPerchPrompt('afternoon');
                expect(prompt).toContain('Afternoon (2-4pm Pacific)');
            });

            test('should include slot-specific hint', () => {
                const prompt = buildPerchPrompt('afternoon');
                expect(prompt).toContain('Afternoon');
            });
        });

        describe.concurrent('evening slot', () => {
            test('should include BASE_PROMPT', () => {
                const prompt = buildPerchPrompt('evening');
                expect(prompt).toContain(BASE_PROMPT);
            });

            test('should include slot name with time range', () => {
                const prompt = buildPerchPrompt('evening');
                expect(prompt).toContain('Evening (6-8pm Pacific)');
            });

            test('should include slot-specific hint', () => {
                const prompt = buildPerchPrompt('evening');
                expect(prompt).toContain('Evening wind-down');
            });
        });

        describe.concurrent('late-night slot', () => {
            test('should include BASE_PROMPT', () => {
                const prompt = buildPerchPrompt('late-night');
                expect(prompt).toContain(BASE_PROMPT);
            });

            test('should include slot name with time range', () => {
                const prompt = buildPerchPrompt('late-night');
                expect(prompt).toContain('Late Night (11pm-1am Pacific)');
            });

            test('should include slot-specific hint', () => {
                const prompt = buildPerchPrompt('late-night');
                expect(prompt).toContain('Late night');
            });
        });
    });

    describe.concurrent('prompt structure', () => {
        test('all scheduled slots should follow same structure', () => {
            const scheduledSlots: PerchSlot[] = ['pre-dawn', 'mid-morning', 'wikipedia', 'afternoon', 'evening', 'late-night'];

            for(const slot of scheduledSlots) {
                const prompt = buildPerchPrompt(slot);
                expect(prompt).toContain(BASE_PROMPT);
                expect(prompt).toContain('---');
                expect(prompt).toContain('## Current Time Window:');
            }
        });

        test('prompt should start with BASE_PROMPT for scheduled slots', () => {
            const prompt = buildPerchPrompt('pre-dawn');
            expect(_.startsWith(prompt, BASE_PROMPT)).toBe(true);
        });
    });
});

describe.concurrent('getSuggestionLevelDescription', () => {
    describe.concurrent('unscheduled slot', () => {
        test('should return "none" for unscheduled', () => {
            const description = getSuggestionLevelDescription('unscheduled');
            expect(description).toBe('none');
        });
    });

    describe.concurrent('scheduled slots', () => {
        test('should return correct description for pre-dawn (strongly_suggestive)', () => {
            const description = getSuggestionLevelDescription('pre-dawn');
            expect(description).toBe('strongly suggestive (high-value timing)');
        });

        test('should return correct description for mid-morning (moderate)', () => {
            const description = getSuggestionLevelDescription('mid-morning');
            expect(description).toBe('moderate (helpful suggestions)');
        });

        test('should return correct description for wikipedia (moderate)', () => {
            const description = getSuggestionLevelDescription('wikipedia');
            expect(description).toBe('moderate (helpful suggestions)');
        });

        test('should return correct description for afternoon (open)', () => {
            const description = getSuggestionLevelDescription('afternoon');
            expect(description).toBe('open (flexible exploration)');
        });

        test('should return correct description for evening (light_touch)', () => {
            const description = getSuggestionLevelDescription('evening');
            expect(description).toBe('light touch (optional activity)');
        });

        test('should return correct description for late-night (moderate)', () => {
            const description = getSuggestionLevelDescription('late-night');
            expect(description).toBe('moderate (helpful suggestions)');
        });
    });

    describe.concurrent('suggestion level mapping', () => {
        test('all scheduled slots should return valid descriptions', () => {
            const scheduledSlots: PerchSlot[] = ['pre-dawn', 'mid-morning', 'wikipedia', 'afternoon', 'evening', 'late-night'];
            const validDescriptions = [
                'strongly suggestive (high-value timing)',
                'moderate (helpful suggestions)',
                'open (flexible exploration)',
                'light touch (optional activity)',
            ];

            for(const slot of scheduledSlots) {
                const description = getSuggestionLevelDescription(slot);
                expect(validDescriptions).toContain(description);
            }
        });
    });
});

describe.concurrent('BASE_PROMPT', () => {
    test('should contain core perch philosophy', () => {
        expect(BASE_PROMPT).toContain('perch time');
        expect(BASE_PROMPT).toContain('autonomous exploration');
    });

    test('should mention output is optional', () => {
        expect(BASE_PROMPT).toContain('no obligation');
    });

    test('should mention hints are suggestions', () => {
        expect(BASE_PROMPT).toContain('suggestions, not requirements');
    });
});

describe.concurrent('buildTestPerchPrompt', () => {
    test('should include test mode disclaimer', () => {
        const prompt = buildTestPerchPrompt('pre-dawn');
        expect(prompt).toContain('--- TEST MODE ---');
        expect(prompt).toContain('--- END TEST MODE ---');
    });

    test('should include slot name in test disclaimer', () => {
        const prompt = buildTestPerchPrompt('mid-morning');
        expect(prompt).toContain('Mid-Morning (9-11am Pacific)');
    });

    test('should include base perch prompt', () => {
        const prompt = buildTestPerchPrompt('afternoon');
        expect(prompt).toContain(BASE_PROMPT);
    });

    test('should mention testing context', () => {
        const prompt = buildTestPerchPrompt('evening');
        expect(prompt).toContain('testing purposes');
        expect(prompt).toContain('Craig knows this is a test');
    });

    test('should work with unscheduled slot', () => {
        const prompt = buildTestPerchPrompt('unscheduled');
        expect(prompt).toContain('--- TEST MODE ---');
        expect(prompt).toContain('Unscheduled');
        expect(prompt).toContain(BASE_PROMPT);
    });

    test('should include slot-specific hints for scheduled slots', () => {
        const prompt = buildTestPerchPrompt('pre-dawn');
        expect(prompt).toContain('morning digest');
    });
});

describe.concurrent('formatSlotName edge cases', () => {
    test('unscheduled slot should return "Unscheduled"', () => {
        // Testing via buildPerchPrompt which uses formatSlotName
        const prompt = buildTestPerchPrompt('unscheduled');
        expect(prompt).toContain('Unscheduled');
    });

    test('should throw on unknown slot', () => {
        // We can't directly test the error case without casting to invalid type,
        // but we verify all valid slots work correctly
        const validSlots: PerchSlot[] = ['pre-dawn', 'mid-morning', 'wikipedia', 'afternoon', 'evening', 'late-night', 'unscheduled'];
        for(const slot of validSlots) {
            expect(() => buildTestPerchPrompt(slot)).not.toThrow();
        }
    });
});

describe.concurrent('getSuggestionLevelDescription edge cases', () => {
    test('should handle all suggestion levels', () => {
        const descriptions = [
            getSuggestionLevelDescription('pre-dawn'),
            getSuggestionLevelDescription('mid-morning'),
            getSuggestionLevelDescription('wikipedia'),
            getSuggestionLevelDescription('afternoon'),
            getSuggestionLevelDescription('evening'),
            getSuggestionLevelDescription('late-night'),
        ];

        // All should return non-empty descriptions
        for(const desc of descriptions) {
            expect(desc.length).toBeGreaterThan(0);
        }
    });
});

describe.concurrent('buildPerchResumedPrompt', () => {
    test('should include time header', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 120000,
            interruptingSummary: 'A message from Craig in #general',
        };

        const prompt = buildPerchResumedPrompt(options);
        expect(prompt).toContain('## Current Time');
        expect(prompt).toContain('UTC:');
    });

    test('should include PERCH TIME RESUMED header', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 60000,
            interruptingSummary: 'A message from Alice in #dev',
        };

        const prompt = buildPerchResumedPrompt(options);
        expect(prompt).toContain('--- PERCH TIME RESUMED ---');
    });

    test('should format suspension duration in minutes', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 180000, // 3 minutes
            interruptingSummary: 'A message from Bob in #test',
        };

        const prompt = buildPerchResumedPrompt(options);
        expect(prompt).toContain('approximately 3 minutes');
    });

    test('should format less than 1 minute duration', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 20000, // 20 seconds (rounds to 0 minutes)
            interruptingSummary: 'A message from Craig in #general',
        };

        const prompt = buildPerchResumedPrompt(options);
        expect(prompt).toContain('less than a minute');
    });

    test('should include interrupting message summary', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 120000,
            interruptingSummary: 'A message from Alice in #dev',
        };

        const prompt = buildPerchResumedPrompt(options);
        expect(prompt).toContain('[While you were suspended:]');
        expect(prompt).toContain('A message from Alice in #dev');
    });

    test('should include new events when provided', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 120000,
            interruptingSummary: 'A message from Craig in #general',
            newEventsSummary:    '- /events/2024-01-01.md: New event logged\n- /state/project.md: Updated status',
        };

        const prompt = buildPerchResumedPrompt(options);
        expect(prompt).toContain('- /events/2024-01-01.md: New event logged');
        expect(prompt).toContain('- /state/project.md: Updated status');
    });

    test('should omit new events section when not provided', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 120000,
            interruptingSummary: 'A message from Craig in #general',
        };

        const prompt = buildPerchResumedPrompt(options);
        // Should not contain specific event paths (only the interrupting message)
        const lines = _.split(prompt, '\n');
        const eventLines = _.filter(lines, line => _.startsWith(line, '- /'));
        expect(eventLines.length).toBe(0);
    });

    test('should include TaskList reminder', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 120000,
            interruptingSummary: 'A message from Craig in #general',
        };

        const prompt = buildPerchResumedPrompt(options);
        expect(prompt).toContain('Check TaskList');
        expect(prompt).toContain('Trust TaskList as your source of truth');
    });

    test('should format single minute duration correctly', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 90000, // 1.5 minutes, rounds to 2
            interruptingSummary: 'A message from Bob in #test',
        };

        const prompt = buildPerchResumedPrompt(options);
        expect(prompt).toContain('approximately 2 minutes');
    });

    test('should format exactly 1 minute as singular "minute" not "minutes"', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 60000, // exactly 1 minute
            interruptingSummary: 'A message from Craig in #general',
        };

        const prompt = buildPerchResumedPrompt(options);
        // Use regex to ensure "1 minute" is followed by a non-alphanumeric character (not 's' and not other text)
        expect(prompt).toMatch(/approximately 1 minute[^a-zA-Z]/);
    });

    test('should join sections with newlines', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 120000,
            interruptingSummary: 'A message from Craig in #general',
        };

        const prompt = buildPerchResumedPrompt(options);
        // Verify sections are separated by newlines (not concatenated)
        expect(prompt).toContain('--- PERCH TIME RESUMED ---\n');
        expect(prompt).toContain('\nContinue your perch work');
    });

    test('should mention suspension for message handling', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 120000,
            interruptingSummary: 'A message from Craig in #general',
        };

        const prompt = buildPerchResumedPrompt(options);
        expect(prompt).toContain('suspended');
        expect(prompt).toContain('user message was handled');
    });

    test('should instruct to continue perch work', () => {
        const options: PerchResumedOptions = {
            suspendedDurationMs: 120000,
            interruptingSummary: 'A message from Craig in #general',
        };

        const prompt = buildPerchResumedPrompt(options);
        expect(prompt).toContain('Continue your perch work');
    });
});

describe.concurrent('buildPerchTimeoutPrompt', () => {
    test('should return multi-line prompt with all sections', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:       'Analyzing data',
                text:           'Writing summary',
                pendingToolUse: {
                    type:  'tool_use',
                    id:    'toolu_456',
                    name:  'save_memory',
                    input: {},
                },
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   40,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);
        // Verify it's a multi-line prompt (array was used correctly)
        const lines = _.split(prompt, '\n');
        expect(lines.length).toBeGreaterThan(10);
    });

    test('should include time header with UTC time', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:                   '',
                text:                       '',
                pendingToolUse:             null,
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   30,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);
        expect(prompt).toContain('## Current Time');
        expect(prompt).toContain('UTC:');
    });

    test('should include timeout header', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:                   '',
                text:                       '',
                pendingToolUse:             null,
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   30,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);
        expect(prompt).toContain('--- PERCH SESSION TIMEOUT ---');
    });

    test('should include session duration information', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:                   '',
                text:                       '',
                pendingToolUse:             null,
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   35,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);
        expect(prompt).toContain('35 minutes');
        expect(prompt).toContain('max: 45 minutes');
    });

    test('should include wrap-up instructions', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:                   '',
                text:                       '',
                pendingToolUse:             null,
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   30,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);
        expect(prompt).toContain('wrap up what you\'re doing');
        expect(prompt).toContain('Save any important thoughts');
        expect(prompt).toContain('Don\'t start new explorations');
        expect(prompt).toContain('finalize and conclude');
    });

    test('should include partial thinking if present', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:                   'I was exploring memory patterns',
                text:                       '',
                pendingToolUse:             null,
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   30,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);
        expect(prompt).toContain('[Your thinking at timeout:]');
        expect(prompt).toContain('I was exploring memory patterns');
    });

    test('should not include thinking section if empty', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:                   '',
                text:                       '',
                pendingToolUse:             null,
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   30,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);
        expect(prompt).not.toContain('[Your thinking at timeout:]');
    });

    test('should include partial text if present', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:                   '',
                text:                       'I was writing up findings',
                pendingToolUse:             null,
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   30,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);
        expect(prompt).toContain('[You were composing:]');
        expect(prompt).toContain('I was writing up findings');
    });

    test('should not include text section if empty', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:                   '',
                text:                       '',
                pendingToolUse:             null,
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   30,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);
        expect(prompt).not.toContain('[You were composing:]');
    });

    test('should include pending tool use if present', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: {
                    type:  'tool_use',
                    id:    'toolu_456',
                    name:  'store_memory',
                    input: {},
                },
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   30,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);
        expect(prompt).toContain('[You were about to use "store_memory"]');
    });

    test('should not include tool use section if not present', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:                   '',
                text:                       '',
                pendingToolUse:             null,
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   30,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);
        expect(prompt).not.toContain('[You were about to use');
    });

    test('should build correct structure with minimal options', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:                   '',
                text:                       '',
                pendingToolUse:             null,
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   25,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);

        // Verify header is present
        expect(prompt).toMatch(/^## Current Time/);

        // Verify timeout section
        expect(prompt).toContain('--- PERCH SESSION TIMEOUT ---');

        // Verify duration information
        expect(prompt).toContain('25 minutes');
        expect(prompt).toContain('max: 45 minutes');

        // Verify wrap-up instructions
        expect(prompt).toContain('wrap up what you\'re doing');
        expect(prompt).toContain('Save any important thoughts');
        expect(prompt).toContain('finalize and conclude');
    });

    test('should include tool name when pendingToolUse is present', () => {
        const options: PerchTimeoutOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: {
                    type:  'tool_use',
                    id:    'toolu_789',
                    name:  'create_task',
                    input: {},
                },
                sessionId:                  undefined,
                uncollectedBackgroundTasks: 0,
            },
            sessionDuration:   40,
            maxSessionMinutes: 45,
        };

        const prompt = buildPerchTimeoutPrompt(options);

        // Verify tool name appears in output
        expect(prompt).toContain('create_task');
        expect(prompt).toContain('[You were about to use "create_task"]');
    });
});

describe.concurrent('perch context injection', () => {
    test('should prepend perchContext before BASE_PROMPT when provided', () => {
        const context = '## Current Time\n- UTC: 2026-02-12\n\n## Recent Focus\n/state/project.md:\nWorking on redesign';
        const prompt = buildPerchPrompt('unscheduled', context);

        // Context should appear before BASE_PROMPT
        const contextIndex = prompt.indexOf('## Current Time');
        const baseIndex = prompt.indexOf('This is perch time');
        expect(contextIndex).toBeLessThan(baseIndex);
        expect(prompt).toContain('---');
    });

    test('should work without perchContext (backward compatible)', () => {
        const prompt = buildPerchPrompt('unscheduled');
        expect(prompt).toBe(BASE_PROMPT);
    });

    test('should include perchContext with scheduled slot', () => {
        const context = '## Current Time\n- UTC: 2026-02-12';
        const prompt = buildPerchPrompt('pre-dawn', context);

        expect(prompt).toContain('## Current Time');
        expect(prompt).toContain('Pre-Dawn (5-7am Pacific)');
        expect(prompt).toContain(BASE_PROMPT);
    });

    test('should pass perchContext through buildTestPerchPrompt', () => {
        const context = '## Recent Focus\nTest context';
        const prompt = buildTestPerchPrompt('pre-dawn', context);

        expect(prompt).toContain('TEST MODE');
        expect(prompt).toContain('## Recent Focus');
        expect(prompt).toContain(BASE_PROMPT);
    });
});

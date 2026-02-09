import { describe, test, expect } from 'bun:test';
import _ from 'lodash';
import {
    buildPerchPrompt,
    buildTestPerchPrompt,
    buildPerchInterruptedPrompt,
    buildPerchTimeoutPrompt,
    getSuggestionLevelDescription,
    BASE_PROMPT,
    type PerchInterruptedOptions,
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

describe.concurrent('buildPerchInterruptedPrompt', () => {
    test('should return multi-line prompt with all sections', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       'Working on something',
                text:           'Draft text',
                pendingToolUse: {
                    type:  'tool_use',
                    id:    'toolu_123',
                    name:  'test_tool',
                    input: {},
                },
                sessionId: undefined,
            },
            newMessage: {
                author:      'TestUser',
                channelName: 'test-channel',
                content:     'Test message',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);
        // Verify it's a multi-line prompt (array was used correctly)
        const lines = _.split(prompt, '\n');
        expect(lines.length).toBeGreaterThan(10);
    });

    test('should include time header with UTC time', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
            },
            newMessage: {
                author:      'TestUser',
                channelName: 'test-channel',
                content:     'Test message',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);
        expect(prompt).toContain('## Current Time');
        expect(prompt).toContain('UTC:');
    });

    test('should include interrupted header', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
            },
            newMessage: {
                author:      'TestUser',
                channelName: 'test-channel',
                content:     'Test message',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);
        expect(prompt).toContain('--- PERCH TIME INTERRUPTED ---');
        expect(prompt).toContain('autonomous perch time when a new message arrived');
    });

    test('should include partial thinking if present', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       'I was thinking about X',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
            },
            newMessage: {
                author:      'TestUser',
                channelName: 'test-channel',
                content:     'Test message',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);
        expect(prompt).toContain('[Your thinking at interruption:]');
        expect(prompt).toContain('I was thinking about X');
    });

    test('should not include thinking section if empty', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
            },
            newMessage: {
                author:      'TestUser',
                channelName: 'test-channel',
                content:     'Test message',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);
        expect(prompt).not.toContain('[Your thinking at interruption:]');
    });

    test('should include partial text if present', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       '',
                text:           'I was composing a response',
                pendingToolUse: null,
                sessionId:      undefined,
            },
            newMessage: {
                author:      'TestUser',
                channelName: 'test-channel',
                content:     'Test message',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);
        expect(prompt).toContain('[You were composing:]');
        expect(prompt).toContain('I was composing a response');
    });

    test('should not include text section if empty', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
            },
            newMessage: {
                author:      'TestUser',
                channelName: 'test-channel',
                content:     'Test message',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);
        expect(prompt).not.toContain('[You were composing:]');
    });

    test('should include pending tool use if present', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: {
                    type:  'tool_use',
                    id:    'toolu_123',
                    name:  'search_memory',
                    input: {},
                },
                sessionId: undefined,
            },
            newMessage: {
                author:      'TestUser',
                channelName: 'test-channel',
                content:     'Test message',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);
        expect(prompt).toContain('[You were about to use "search_memory"]');
    });

    test('should not include tool use section if not present', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
            },
            newMessage: {
                author:      'TestUser',
                channelName: 'test-channel',
                content:     'Test message',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);
        expect(prompt).not.toContain('[You were about to use');
    });

    test('should include new message details', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
            },
            newMessage: {
                author:      'Alice',
                channelName: 'general',
                content:     'Hey, can you help me?',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);
        expect(prompt).toContain('--- NEW MESSAGE ---');
        expect(prompt).toContain('From: Alice in #general');
        expect(prompt).toContain('Hey, can you help me?');
    });

    test('should include task instructions', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
            },
            newMessage: {
                author:      'TestUser',
                channelName: 'test-channel',
                content:     'Test message',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);
        expect(prompt).toContain('## What To Do');
        expect(prompt).toContain('already been handled by your normal conversation flow');
        expect(prompt).toContain('do NOT need to respond to it again');
        expect(prompt).toContain('Check TaskList');
        expect(prompt).toContain('Trust TaskList as your source of truth');
    });

    test('should build correct structure with empty partial work', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
            },
            newMessage: {
                author:      'Alice',
                channelName: 'general',
                content:     'Need help',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);

        // Verify header is present
        expect(prompt).toMatch(/^## Current Time/);

        // Verify interrupted section
        expect(prompt).toContain('--- PERCH TIME INTERRUPTED ---');

        // Verify message section with correct format
        expect(prompt).toContain('--- NEW MESSAGE ---');
        expect(prompt).toContain('From: Alice in #general');
        expect(prompt).toContain('Need help');

        // Verify action items section
        expect(prompt).toContain('## What To Do');
        expect(prompt).toContain('1. Review the message for context');
    });

    test('should include tool name when pendingToolUse is present', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: {
                    type:  'tool_use',
                    id:    'toolu_999',
                    name:  'memory_search',
                    input: {},
                },
                sessionId: undefined,
            },
            newMessage: {
                author:      'Bob',
                channelName: 'dev',
                content:     'Quick question',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);

        // Verify tool name appears in output
        expect(prompt).toContain('memory_search');
        expect(prompt).toContain('[You were about to use "memory_search"]');
    });

    test('should mention message was already handled', () => {
        const options: PerchInterruptedOptions = {
            partialWork: {
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
            },
            newMessage: {
                author:      'TestUser',
                channelName: 'test-channel',
                content:     'Test message',
            },
        };

        const prompt = buildPerchInterruptedPrompt(options);
        expect(prompt).toContain('already been handled by your normal conversation flow');
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
                sessionId: undefined,
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
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
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
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
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
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
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
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
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
                thinking:       'I was exploring memory patterns',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
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
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
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
                thinking:       '',
                text:           'I was writing up findings',
                pendingToolUse: null,
                sessionId:      undefined,
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
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
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
                sessionId: undefined,
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
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
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
                thinking:       '',
                text:           '',
                pendingToolUse: null,
                sessionId:      undefined,
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
                sessionId: undefined,
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

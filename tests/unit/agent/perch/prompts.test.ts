import { describe, test, expect } from 'bun:test';
import _ from 'lodash';
import {
    buildPerchPrompt,
    getSuggestionLevelDescription,
    BASE_PROMPT
} from '@/agent/perch/prompts';
import type { PerchSlot } from '@/agent/perch/types';

describe.concurrent('buildPerchPrompt', () => {
    describe('unscheduled slot', () => {
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

    describe('scheduled slots', () => {
        describe('pre-dawn slot', () => {
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

        describe('mid-morning slot', () => {
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

        describe('afternoon slot', () => {
            test('should include BASE_PROMPT', () => {
                const prompt = buildPerchPrompt('afternoon');
                expect(prompt).toContain(BASE_PROMPT);
            });

            test('should include slot name with time range', () => {
                const prompt = buildPerchPrompt('afternoon');
                expect(prompt).toContain('Afternoon (1-3pm Pacific)');
            });

            test('should include slot-specific hint', () => {
                const prompt = buildPerchPrompt('afternoon');
                expect(prompt).toContain('Afternoon');
            });
        });

        describe('evening slot', () => {
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

        describe('late-night slot', () => {
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

    describe('prompt structure', () => {
        test('all scheduled slots should follow same structure', () => {
            const scheduledSlots: PerchSlot[] = ['pre-dawn', 'mid-morning', 'afternoon', 'evening', 'late-night'];

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
    describe('unscheduled slot', () => {
        test('should return "none" for unscheduled', () => {
            const description = getSuggestionLevelDescription('unscheduled');
            expect(description).toBe('none');
        });
    });

    describe('scheduled slots', () => {
        test('should return correct description for pre-dawn (strongly_suggestive)', () => {
            const description = getSuggestionLevelDescription('pre-dawn');
            expect(description).toBe('strongly suggestive (high-value timing)');
        });

        test('should return correct description for mid-morning (moderate)', () => {
            const description = getSuggestionLevelDescription('mid-morning');
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

    describe('suggestion level mapping', () => {
        test('all scheduled slots should return valid descriptions', () => {
            const scheduledSlots: PerchSlot[] = ['pre-dawn', 'mid-morning', 'afternoon', 'evening', 'late-night'];
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

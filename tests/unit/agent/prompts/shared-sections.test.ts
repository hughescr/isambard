/**
 * Contract tests for the prompt fragments shared by the long-lived session prompt and the
 * sub-agent prompt. These constants are rendered verbatim into both, so what is asserted here
 * is asserted once for both prompts.
 */
import { describe, test, expect } from 'bun:test';
import { assertPromptHygiene } from '../../../helpers/prompt-hygiene';
import { MANAGING_QUOTA_SECTION } from '@/agent/prompts/shared-sections';

describe.concurrent('shared-sections', () => {
    describe('MANAGING_QUOTA_SECTION', () => {
        test('opens with its own "## Managing quota" heading', () => {
            expect(MANAGING_QUOTA_SECTION.startsWith('## Managing quota\n')).toBe(true);
        });

        test('carries no live utilization number — the section must be byte-stable across turns for prompt caching', () => {
            expect(MANAGING_QUOTA_SECTION).not.toContain('%');
            expect(MANAGING_QUOTA_SECTION).not.toContain('percent');
        });

        test('names both levers and all four offered effort levels, and never offers `max`', () => {
            expect(MANAGING_QUOTA_SECTION).toContain('model');
            expect(MANAGING_QUOTA_SECTION).toContain('effort');
            for(const effort of ['`low`', '`medium`', '`high`', '`xhigh`']) {
                expect(MANAGING_QUOTA_SECTION).toContain(effort);
            }
            expect(MANAGING_QUOTA_SECTION).not.toContain('`max`');
        });

        test('states that low and medium cannot launch sub-agents or workflows of their own', () => {
            expect(MANAGING_QUOTA_SECTION).toContain('`low` and `medium` cannot launch sub-agents or workflows of their own.');
        });

        test('ranks the models by cost per token and says the cost of finishing the task is what matters', () => {
            expect(MANAGING_QUOTA_SECTION).toContain('Fable costs roughly twice Opus, and Opus roughly twice Sonnet');
            expect(MANAGING_QUOTA_SECTION).toContain('the cost of finishing the task');
            expect(MANAGING_QUOTA_SECTION).toContain('judgement call per task');
        });

        test('gives the rough tiers and forbids leaving model or effort to default', () => {
            expect(MANAGING_QUOTA_SECTION).toContain('Sonnet at medium');
            expect(MANAGING_QUOTA_SECTION).toContain('Opus at medium or high');
            expect(MANAGING_QUOTA_SECTION).toContain('Fable only where judgement is the hard part');
            expect(MANAGING_QUOTA_SECTION).toContain('Never leave model or effort to default.');
        });

        test('says to prefer the lower tier when a window is near full, and not to hoard when they are empty', () => {
            expect(MANAGING_QUOTA_SECTION).toContain('prefer the lower tier');
            expect(MANAGING_QUOTA_SECTION).toContain('an unused window resets to nothing');
        });

        test('sets both model and effort on every workflow agent() call', () => {
            expect(MANAGING_QUOTA_SECTION).toContain('set model and effort on every `agent()` call');
        });

        test('is non-empty and passes prompt hygiene on its own', () => {
            expect(MANAGING_QUOTA_SECTION.length).toBeGreaterThan(0);
            assertPromptHygiene(MANAGING_QUOTA_SECTION);
        });
    });
});

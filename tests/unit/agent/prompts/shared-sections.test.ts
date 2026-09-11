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
            expect(MANAGING_QUOTA_SECTION).toContain('Low and medium definitions may not launch further agents or workflows.');
        });

        test('routes by expected total cost and task fit without fixed cross-provider multipliers', () => {
            expect(MANAGING_QUOTA_SECTION).toContain('including likely retries and review');
            expect(MANAGING_QUOTA_SECTION).toContain('no fixed multiplier');
            expect(MANAGING_QUOTA_SECTION).toContain('DeepSeek Pro\'s name alone');
        });

        test('gives bounded, substantive, and strongest-available routes', () => {
            expect(MANAGING_QUOTA_SECTION).toContain('Luna or DeepSeek Flash for bounded work');
            expect(MANAGING_QUOTA_SECTION).toContain('Terra or Sol for substantive');
            expect(MANAGING_QUOTA_SECTION).toContain('Astra or Fable for consequential judgement');
        });

        test('compares headroom and pace, switching only when exhaustion is likely', () => {
            expect(MANAGING_QUOTA_SECTION).toContain('Compare remaining capacity and time to reset with the reported recent pace');
            expect(MANAGING_QUOTA_SECTION).toContain('choose another capable provider, lower effort or scope, or defer optional work');
            expect(MANAGING_QUOTA_SECTION).toContain('Use healthy subscription capacity');
        });

        test('sets workflow route explicitly and explains the Agent enum limitation', () => {
            expect(MANAGING_QUOTA_SECTION).toContain('Set model and effort explicitly on workflow `agent()` calls');
            expect(MANAGING_QUOTA_SECTION).toContain('OMIT the Agent `model` override');
        });

        test('distinguishes Claude, Codex and DeepSeek accounting', () => {
            expect(MANAGING_QUOTA_SECTION).toContain('shared five-hour and weekly windows');
            expect(MANAGING_QUOTA_SECTION).toContain('Codex is a separate shared subscription');
            expect(MANAGING_QUOTA_SECTION).toContain('DeepSeek is pay-as-you-go');
            expect(MANAGING_QUOTA_SECTION).toContain('Never sum quota buckets');
        });

        test('is non-empty and passes prompt hygiene on its own', () => {
            expect(MANAGING_QUOTA_SECTION.length).toBeGreaterThan(0);
            assertPromptHygiene(MANAGING_QUOTA_SECTION);
        });
    });
});

import { describe, it, expect } from 'bun:test';
import type { APIButtonComponentWithCustomId } from 'discord.js';
import type { QuestionOption } from '@/agent/question-registry';
import { buildQuestionButtons } from '@/integrations/discord/button-builder';

describe('buildQuestionButtons', () => {
    it('should create buttons with correct customId format', () => {
        const options: QuestionOption[] = [
            { label: 'Option 1', value: 'opt1' },
            { label: 'Option 2', value: 'opt2' },
        ];

        const rows = buildQuestionButtons({
            questionId: 'test-q-123',
            options,
        });

        expect(rows).toHaveLength(1);
        const buttons = rows[0].components;
        expect(buttons).toHaveLength(2);

        // Use toJSON() to access the data
        const button0Data = buttons[0].toJSON() as APIButtonComponentWithCustomId;
        const button1Data = buttons[1].toJSON() as APIButtonComponentWithCustomId;

        expect(button0Data.custom_id).toBe('question:test-q-123:opt1');
        expect(button0Data.label).toBe('Option 1');

        expect(button1Data.custom_id).toBe('question:test-q-123:opt2');
        expect(button1Data.label).toBe('Option 2');
    });

    it('should set button labels from options', () => {
        const options: QuestionOption[] = [
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
            { label: 'Maybe', value: 'maybe' },
        ];

        const rows = buildQuestionButtons({
            questionId: 'q-abc',
            options,
        });

        const buttons = rows[0].components;
        expect((buttons[0].toJSON() as APIButtonComponentWithCustomId).label).toBe('Yes');
        expect((buttons[1].toJSON() as APIButtonComponentWithCustomId).label).toBe('No');
        expect((buttons[2].toJSON() as APIButtonComponentWithCustomId).label).toBe('Maybe');
    });

    it('should split into multiple rows when > 5 options', () => {
        const options: QuestionOption[] = [
            { label: 'Opt 1', value: '1' },
            { label: 'Opt 2', value: '2' },
            { label: 'Opt 3', value: '3' },
            { label: 'Opt 4', value: '4' },
            { label: 'Opt 5', value: '5' },
            { label: 'Opt 6', value: '6' },
            { label: 'Opt 7', value: '7' },
        ];

        const rows = buildQuestionButtons({
            questionId: 'q-multi',
            options,
        });

        expect(rows).toHaveLength(2);
        expect(rows[0].components).toHaveLength(5);
        expect(rows[1].components).toHaveLength(2);

        expect((rows[1].components[0].toJSON() as APIButtonComponentWithCustomId).custom_id).toBe('question:q-multi:6');
        expect((rows[1].components[1].toJSON() as APIButtonComponentWithCustomId).custom_id).toBe('question:q-multi:7');
    });

    it('should handle single option', () => {
        const options: QuestionOption[] = [
            { label: 'Only Option', value: 'only' },
        ];

        const rows = buildQuestionButtons({
            questionId: 'q-single',
            options,
        });

        expect(rows).toHaveLength(1);
        expect(rows[0].components).toHaveLength(1);
        expect((rows[0].components[0].toJSON() as APIButtonComponentWithCustomId).custom_id).toBe('question:q-single:only');
        expect((rows[0].components[0].toJSON() as APIButtonComponentWithCustomId).label).toBe('Only Option');
    });

    it('should correctly handle exactly 5 options (boundary test)', () => {
        const options: QuestionOption[] = [
            { label: 'Opt 1', value: '1' },
            { label: 'Opt 2', value: '2' },
            { label: 'Opt 3', value: '3' },
            { label: 'Opt 4', value: '4' },
            { label: 'Opt 5', value: '5' },
        ];

        const rows = buildQuestionButtons({
            questionId: 'q-five',
            options,
        });

        // Should be exactly 1 row with 5 buttons
        expect(rows).toHaveLength(1);
        expect(rows[0].components).toHaveLength(5);
    });

    it('should correctly handle exactly 6 options (boundary test)', () => {
        const options: QuestionOption[] = [
            { label: 'Opt 1', value: '1' },
            { label: 'Opt 2', value: '2' },
            { label: 'Opt 3', value: '3' },
            { label: 'Opt 4', value: '4' },
            { label: 'Opt 5', value: '5' },
            { label: 'Opt 6', value: '6' },
        ];

        const rows = buildQuestionButtons({
            questionId: 'q-six',
            options,
        });

        // Should be 2 rows: first with 5 buttons, second with 1 button
        expect(rows).toHaveLength(2);
        expect(rows[0].components).toHaveLength(5);
        expect(rows[1].components).toHaveLength(1);
    });
});

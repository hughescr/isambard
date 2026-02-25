import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { QuestionOption } from '@/agent';

export interface ButtonBuilderConfig {
    questionId: string
    options:    QuestionOption[]
}

/**
 * Build Discord button rows for question options.
 * Returns array of ActionRowBuilder (max 5 buttons per row, max 5 rows).
 */
export function buildQuestionButtons(config: ButtonBuilderConfig): ActionRowBuilder<ButtonBuilder>[] {
    const { questionId, options } = config;
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];

    // Discord allows max 5 buttons per row
    const BUTTONS_PER_ROW = 5;

    for(let i = 0; i < options.length; i += BUTTONS_PER_ROW) {
        const rowOptions = options.slice(i, i + BUTTONS_PER_ROW);
        const row = new ActionRowBuilder<ButtonBuilder>();

        for(const option of rowOptions) {
            const button = new ButtonBuilder()
                .setCustomId(`question:${questionId}:${option.value}`)
                .setLabel(option.label)
                .setStyle(ButtonStyle.Primary);

            row.addComponents(button);
        }

        rows.push(row);
    }

    return rows;
}

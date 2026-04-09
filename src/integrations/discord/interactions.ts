import { logger } from '@hughescr/logger';
import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { createUserId, createChannelId } from './types';
import type { QuestionRegistry, QuestionAnswer } from '@/agent';

interface InteractionHandlerConfig {
    questionRegistry: QuestionRegistry
}

interface InteractionHandler {
    /** Handle a button interaction */
    handleButtonInteraction(interaction: ButtonInteraction): Promise<void>
}

/**
 * Creates an interaction handler for Discord button clicks.
 *
 * Button customId format: `question:${questionId}:${value}`
 * - "question" prefix identifies it as a question answer button
 * - questionId correlates to the pending question
 * - value is the selected option value
 */
export function createInteractionHandler(config: InteractionHandlerConfig): InteractionHandler {
    const { questionRegistry } = config;

    async function handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
        // Parse customId: question:${questionId}:${value}

        const parts = interaction.customId.split(':');

        // Ignore if not a question button
        if(parts[0] !== 'question') {
            return;
        }

        // Stryker disable all: Integration code - Button validation and early returns
        if(parts.length < 3) {
            return;
        }

        const questionId = parts[1];
        const value = parts.slice(2).join(':'); // Rejoin in case value contains colons

        // Look up question in registry
        const question = questionRegistry.getQuestion(questionId);

        // If question not found or expired
        if(!question) {
            await interaction.reply({
                content: 'This question has expired or is no longer valid.',
                flags:   MessageFlags.Ephemeral,
            });
            return;
        }

        // Check if question is still waiting (not already answered/cancelled/timed out)
        if(question.state !== 'waiting') {
            await interaction.reply({
                content: 'This question has expired or is no longer valid.',
                flags:   MessageFlags.Ephemeral,
            });
            return;
        }

        // Check if question has expired (expiresAt < now)
        const now = Date.now();
        if(question.expiresAt < now) {
            await interaction.reply({
                content: 'This question has expired or is no longer valid.',
                flags:   MessageFlags.Ephemeral,
            });
            return;
        }
        // Stryker restore all

        // Stryker disable all: Logger info object
        logger.info({
            questionId,
            userId:        interaction.user.id,
            selectedValue: value,
            msg:           'Button answer received',
        });
        // Stryker restore all

        // Update the message to remove buttons (acknowledge click)
        await interaction.update({
            components: [],
        });

        // Determine channelId and threadId from interaction context
        // Stryker disable OptionalChaining: equivalent mutant - channel existence guaranteed by isThread() check
        const channelId = interaction.channel?.isThread()
            ? createChannelId(interaction.channel.parentId ?? interaction.channelId)
            : createChannelId(interaction.channelId);
        // Stryker restore OptionalChaining
        const threadId = interaction.channel?.isThread() ? interaction.channelId : undefined;

        // Create QuestionAnswer
        const answer: QuestionAnswer = {
            content:        value,
            selectedOption: value,
            responderId:    createUserId(interaction.user.id),
            messageId:      interaction.message.id,
            channelId,
            threadId,
        };

        // Resolve the question
        questionRegistry.resolveWithAnswer(questionId, answer);
    }

    return {
        handleButtonInteraction,
    };
}

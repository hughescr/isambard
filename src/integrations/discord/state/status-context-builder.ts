/**
 * StatusContextBuilder reads BotState and produces context for status generation.
 *
 * This module provides a builder that:
 * - Maps operational modes to emoji prefixes
 * - Determines status generation strategy (LLM vs static)
 * - Extracts context for LLM-based status generation
 * - Handles catch-up mode context
 */

import { getModeEmoji } from './transitions';
import type { BotState, BotStateManager, CatchingUpModeContext } from './types';

// ============================================================================
// Types
// ============================================================================

/**
 * Strategy for generating status text.
 *
 * - idle_llm: Generate creative idle status via LLM
 * - active_dynamic: Generate contextual status via LLM (based on activity phase)
 * - active_static: Use static fallback (no activity phase available)
 */
export type StatusGenerationStrategy = 'idle_llm' | 'active_dynamic' | 'active_static';

/**
 * Context for status generation.
 *
 * Provides all information needed to generate a Discord presence status:
 * - Emoji prefix for visual indicator
 * - Generation strategy
 * - Prompt context for LLM-based generation
 */
export interface StatusContext {
    /** Emoji prefix for Discord status (💤, 📥, 📥💬, 💬, 🪶, 🪶💬) */
    emojiPrefix:    string
    /** How to generate the status text */
    strategy:       StatusGenerationStrategy
    /** Context for Haiku prompt generation (when strategy is active_dynamic) */
    promptContext?: StatusPromptContext
}

/**
 * Context for LLM prompt generation.
 *
 * Contains all relevant information about the current activity phase,
 * user interaction, and catch-up state.
 */
export interface StatusPromptContext {
    /** Current activity phase type */
    phase:            'thinking' | 'using_tool' | 'responding'
    /** User message being processed (for thinking phase) */
    userMessage?:     string
    /** Tool name (for using_tool phase) */
    toolName?:        string
    /** Accumulated response text (for responding phase) */
    accumulatedText?: string
    /** Pre-generated status from activityPhase */
    generatedStatus?: string
    /** Catch-up context (when in catch-up mode) */
    catchUpContext?:  CatchUpPromptContext
}

/**
 * Context for catch-up mode status generation.
 *
 * Provides information about unread messages and catch-up progress.
 */
export interface CatchUpPromptContext {
    /** Total unread messages when catch-up started */
    unreadCount:         number
    /** Names of channels with unread messages */
    channelNames:        string[]
    /** Top authors who sent messages */
    topAuthors:          string[]
    /** Human-readable time since last active */
    timeSinceLastActive: string | null
    /** Number of channels already viewed */
    viewedChannelCount:  number
}

/**
 * Dependencies for StatusContextBuilder.
 */
export interface StatusContextBuilderDeps {
    stateManager: BotStateManager
}

/**
 * Builder for status context.
 *
 * Reads BotState and produces StatusContext for status generation.
 */
export interface StatusContextBuilder {
    /**
     * Build status context from current bot state.
     * Uses state from stateManager.getState().
     */
    buildContext(): StatusContext

    /**
     * Build context with additional activity details.
     * Merges provided activity details into the context.
     *
     * @param activity - Additional activity details to merge
     */
    buildContextWithActivity(activity: {
        userMessage?:     string
        toolName?:        string
        accumulatedText?: string
    }): StatusContext
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a StatusContextBuilder.
 *
 * @param deps - Dependencies (state manager)
 * @returns StatusContextBuilder instance
 */
export function createStatusContextBuilder(deps: StatusContextBuilderDeps): StatusContextBuilder {
    const { stateManager } = deps;

    return {
        buildContext(): StatusContext {
            const state = stateManager.getState();
            return buildContextFromState(state, {});
        },

        buildContextWithActivity(activity: {
            userMessage?:     string
            toolName?:        string
            accumulatedText?: string
        }): StatusContext {
            const state = stateManager.getState();
            return buildContextFromState(state, activity);
        },
    };
}

// ============================================================================
// Internal Logic
// ============================================================================

/**
 * Build status context from bot state.
 *
 * @param state - Current bot state
 * @param activity - Optional activity details to merge
 * @returns StatusContext
 */
function buildContextFromState(
    state: BotState,
    activity: {
        userMessage?:     string
        toolName?:        string
        accumulatedText?: string
    }
): StatusContext {
    // Get emoji prefix using getModeEmoji
    const emojiPrefix = getModeEmoji(state.mode, state.interrupted);

    // Determine strategy
    const strategy = determineStrategy(state);

    // Build prompt context if needed
    const promptContext = strategy === 'active_dynamic'
        ? buildPromptContext(state, activity)
        : undefined;

    return {
        emojiPrefix,
        strategy,
        promptContext,
    };
}

/**
 * Determine status generation strategy based on bot state.
 *
 * @param state - Current bot state
 * @returns StatusGenerationStrategy
 */
function determineStrategy(state: BotState): StatusGenerationStrategy {
    // Idle mode → idle_llm
    if(state.mode === 'idle') {
        return 'idle_llm';
    }

    // Active mode with activity phase → active_dynamic
    if(state.activityPhase !== null) {
        return 'active_dynamic';
    }

    // Active mode without activity phase → active_static
    return 'active_static';
}

/**
 * Build prompt context from bot state and activity details.
 *
 * @param state - Current bot state
 * @param activity - Activity details to merge
 * @returns StatusPromptContext
 */
function buildPromptContext(
    state: BotState,
    activity: {
        userMessage?:     string
        toolName?:        string
        accumulatedText?: string
    }
): StatusPromptContext {
    const { activityPhase } = state;

    // Stryker disable StringLiteral: Error message for invalid state
    if(activityPhase === null) {
        throw new Error('Cannot build prompt context without activityPhase');
    }
    // Stryker restore StringLiteral

    // Base context from activity phase
    const context: StatusPromptContext = {
        phase:           activityPhase.type,
        generatedStatus: activityPhase.generatedStatus,
    };

    // Extract phase-specific fields
    // Stryker disable ConditionalExpression: Type checks in conditional chain - all branches tested
    if(activityPhase.type === 'thinking') {
        context.userMessage = activity.userMessage ?? activityPhase.userMessage;
    } else if(activityPhase.type === 'using_tool') {
        context.toolName = activity.toolName ?? activityPhase.toolName;
    } else if(activityPhase.type === 'responding') {
        context.accumulatedText = activity.accumulatedText;
    }
    // Stryker restore ConditionalExpression

    // Add catch-up context if in catching_up mode
    if(state.mode === 'catching_up') {
        context.catchUpContext = buildCatchUpContext(state.modeContext as CatchingUpModeContext);
    }

    return context;
}

/**
 * Build catch-up context from catching_up mode context.
 *
 * @param modeContext - Catching up mode context
 * @returns CatchUpPromptContext
 */
function buildCatchUpContext(modeContext: CatchingUpModeContext): CatchUpPromptContext {
    return {
        unreadCount:         modeContext.unreadCount,
        channelNames:        modeContext.channelNames,
        topAuthors:          modeContext.topAuthors,
        timeSinceLastActive: modeContext.timeSinceLastActive,
        viewedChannelCount:  modeContext.viewedChannels.size,
    };
}

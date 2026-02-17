import { ActivityType } from 'discord.js';
import type { Client } from 'discord.js';
import type { DiscordConfig } from '@/config/schemas';
import type { BotStateManager, StateChange } from '../state';
import type { InboxManager } from '../inbox';
import type { ContextBuilder } from '@/agent/context-builder';
import {
    createActiveStatusGenerator,
    createDynamicStatusGenerator,
    createIdleStatusGenerator,
    PresenceManager
} from '../presence';
import { logger } from '@hughescr/logger';

/**
 * Result of setting up presence management.
 */
export interface PresenceSetupResult {
    /** Presence manager for Discord status updates */
    presenceManager:           PresenceManager
    /** Unsubscribe function for mode transition subscription */
    unsubscribeModeTransition: () => void
    /** Unsubscribe function for activity phase subscription */
    unsubscribeActivityPhase:  () => void
}

/**
 * Sets up Discord presence management with status generators and state manager integration.
 *
 * Creates the presence manager with active, idle, and dynamic status generators.
 * Sets up bidirectional integration with bot state manager:
 * - Mode transitions sync to presence display modes
 * - Activity phase changes update Discord status
 *
 * @param params - Configuration for presence setup
 * @returns Presence setup result with manager and unsubscribe functions, or undefined if presence config not provided
 */
export function setupPresence(params: {
    identityContext:         string
    presenceConfig:          NonNullable<DiscordConfig['presence']>
    readyClient:             Client
    botStateManager:         BotStateManager
    dynamicStatusGenerator:  ReturnType<typeof createDynamicStatusGenerator> | undefined
    inboxManager:            InboxManager | undefined
    getTaskContext?:         () => Promise<string | undefined>
    getRecentContext:        () => Promise<string | undefined>
    contextBuilder?:         ContextBuilder
    getLastThinkingContent?: () => string | undefined
}): PresenceSetupResult {
    const {
        identityContext,
        presenceConfig,
        readyClient,
        botStateManager,
        dynamicStatusGenerator,
        inboxManager,
        getTaskContext,
        getRecentContext,
        contextBuilder,
        getLastThinkingContent,
    } = params;

    const activeStatusGenerator = createActiveStatusGenerator({
        activityType: ActivityType.Custom,
        logger,
    });

    // Create TTL-cached identity context callback
    // Stryker disable next-line ArithmeticOperator: TTL constant
    const IDENTITY_TTL_MS = 5 * 60 * 1000; // 5 minutes
    let cachedIdentity: string | undefined;
    let cachedAt = 0;

    const getIdentityContext = async (): Promise<string> => {
        const now = Date.now();
        // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator,BlockStatement: TTL cache check - boundary logic
        if(cachedIdentity && (now - cachedAt) < IDENTITY_TTL_MS) {
            return cachedIdentity;
        }
        // Stryker disable BlockStatement: Identity loading with fallback - tested via integration
        if(contextBuilder) {
            // Stryker disable next-line LogicalOperator: Nullish coalescing fallback for missing identity
            cachedIdentity = await contextBuilder.loadCoreIdentity() ?? identityContext;
        } else {
            cachedIdentity = identityContext;
        }
        // Stryker restore BlockStatement
        cachedAt = now;
        return cachedIdentity;
    };

    const idleStatusGenerator = createIdleStatusGenerator({
        logger,
        activityType:    ActivityType.Custom,
        identityContext: getIdentityContext,
        getTaskContext,
        getRecentContext,
        getLastThinkingContent,
    });

    const presenceManager = new PresenceManager({
        discordClient: readyClient,
        config:        presenceConfig,
        activeStatusGenerator,
        idleStatusGenerator,
        dynamicStatusGenerator,
        logger,
    });

    presenceManager.start();

    // Stryker disable all: Integration callbacks syncing state between components - tested via bot integration tests
    // Bridge: Sync BotStateManager → PresenceManager
    const unsubscribeModeTransition = botStateManager.subscribe((change: StateChange) => {
        // Sync mode changes to presence manager
        if(change.changeType === 'mode_transition') {
            const mode = change.newState.mode;

            // Map BotState mode to PresenceDisplayMode for presence
            if(mode === 'idle') {
                presenceManager.transitionPresenceDisplayMode('none');
                // Explicitly transition presence to idle phase
                void presenceManager.updatePhase({ type: 'idle', since: new Date() });
            } else if(mode === 'catching_up') {
                presenceManager.transitionPresenceDisplayMode('catching_up');
            } else if(mode === 'processing_message') {
                presenceManager.transitionPresenceDisplayMode('processing_message');
            } else if(mode === 'perching') {
                presenceManager.transitionPresenceDisplayMode('perching');
            }
        }
    });

    // Bridge: Sync activity phases to presence manager
    const unsubscribeActivityPhase = botStateManager.subscribe((change: StateChange) => {
        if(change.changeType === 'activity_phase' && presenceManager) {
            const phase = change.newState.activityPhase;
            if(phase) {
                // Throttle active phase updates to avoid Discord rate limits
                if(botStateManager.shouldUpdatePresence()) {
                    void presenceManager.updatePhase(phase);
                    botStateManager.recordPresenceUpdate();
                }
            } else {
                // Idle transitions intentionally bypass throttling:
                // - End of work should show immediately to users
                // - Prevents "stuck" active status after processing completes
                // - Idle is a stable state, not a rapid-fire event
                if(change.newState.mode === 'idle') {
                    void presenceManager.updatePhase({ type: 'idle', since: new Date() });
                    botStateManager.recordPresenceUpdate();
                }
            }
        }
    });

    // If no inbox manager, transition to idle immediately
    // (otherwise, idle transition happens after catch-up check in inbox init)
    if(!inboxManager) {
        void presenceManager.updatePhase({ type: 'idle', since: new Date() });
    }

    return {
        presenceManager,
        unsubscribeModeTransition,
        unsubscribeActivityPhase,
    };
}
// Stryker restore all

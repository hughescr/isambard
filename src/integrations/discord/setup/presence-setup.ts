import { logger } from '@hughescr/logger';
import { ActivityType, type Client  } from 'discord.js';
import type { InboxManager } from '../inbox';
import {
    createActiveStatusGenerator,
    type createDynamicStatusGenerator,
    createIdleStatusGenerator,
    PresenceManager
} from '../presence';
import type { BotStateManager, StateChange } from '../state';
import { IdentityCache, type ContextBuilder, type Signal } from '@/agent';
import type { DiscordConfig } from '@/config';

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
    /** Pre-built write-through identity cache. When provided, replaces the inline loader. */
    identityCache?:          IdentityCache
    /** Optional live-signals snapshot callback. Step 3 will consume this. */
    getLiveSignals?:         () => Promise<Signal[]>
    /** Setter for persisting the last idle status text (anti-rut, Step 3). */
    setPreviousStatus?:      (text: string) => void
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
        identityCache: providedIdentityCache,
        getLiveSignals,
        setPreviousStatus,
    } = params;

    const activeStatusGenerator = createActiveStatusGenerator({
        activityType: ActivityType.Custom,
        logger,
    });

    // Use the provided write-through identity cache, or create a local one.
    // The loader falls back to the static identityContext string when contextBuilder
    // is not available (e.g. in tests or minimal setups).
    const identityCache = providedIdentityCache ?? new IdentityCache(
        // Stryker disable next-line ConditionalExpression: loader fallback — contextBuilder absent path is a valid production configuration
        contextBuilder ? () => contextBuilder.loadCoreIdentity() : () => Promise.resolve(identityContext)
    );

    const idleStatusGenerator = createIdleStatusGenerator({
        logger,
        activityType:    ActivityType.Custom,
        identityContext: () => identityCache.get(),
        getLiveSignals,
        setPreviousStatus,
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
            switch(mode) {
                case 'idle': {
                    presenceManager.transitionPresenceDisplayMode('none');
                    // Explicitly transition presence to idle phase
                    void presenceManager.updatePhase({ type: 'idle', since: new Date() });

                    break;
                }
                case 'catching_up': {
                    presenceManager.transitionPresenceDisplayMode('catching_up');

                    break;
                }
                case 'processing_message': {
                    presenceManager.transitionPresenceDisplayMode('processing_message');

                    break;
                }
                case 'perching': {
                    presenceManager.transitionPresenceDisplayMode('perching');

                    break;
                }
            // No default
            }
        }
    });

    // Bridge: Sync activity phases to presence manager
    const unsubscribeActivityPhase = botStateManager.subscribe((change: StateChange) => {
        if(change.changeType === 'activity_phase') {
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

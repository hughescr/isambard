/**
 * Discord bot state management module.
 *
 * Provides a state machine for managing operational modes, activity phases,
 * and context injection for the Claude agent.
 *
 * ## Operational Modes
 * - idle: Normal operation, no active conversation
 * - catching_up: Processing backlog of unread messages
 * - processing_message: Actively responding to a user message
 * - perching: Observing without active engagement
 *
 * ## Activity Phases (within-mode activity)
 * - thinking: Processing user message
 * - using_tool: Executing a tool
 * - responding: Generating response text
 *
 * @example
 * ```typescript
 * // Create state manager
 * const manager = new BotStateManagerImpl({ logger });
 * manager.start();
 *
 * // Subscribe to state changes
 * manager.subscribe((change) => {
 *   console.log('State changed:', change.changeType);
 * });
 *
 * // Transition through states
 * manager.startProcessingMessage(channelId, 'Hello!');
 * manager.updateActivityPhase({ type: 'thinking', startedAt: new Date() });
 * manager.goIdle();
 * ```
 */

// ============================================================================
// Types from types.ts
// ============================================================================

export type {
    StateChange,
    CatchingUpModeContext,
    BotStateManager,
    InterruptingMessageDetails,
    SessionType
} from './types';

// ============================================================================
// Manager from manager.ts
// ============================================================================

export { BotStateManagerImpl } from './manager';

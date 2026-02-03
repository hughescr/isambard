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
 * const manager = createBotStateManager({ logger });
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
    OperationalMode,
    ActivityPhase,
    BotState,
    StateChange,
    IdleModeContext,
    CatchingUpModeContext,
    ProcessingMessageModeContext,
    PerchingModeContext,
    ModeContext,
    BotStateManager,
    InterruptingMessageDetails,
    SessionType
} from './types';

// Schemas from types.ts
export {
    operationalModeSchema,
    activityPhaseSchema,
    botStateSchema,
    stateChangeSchema,
    modeContextSchema,
    idleModeContextSchema,
    catchingUpModeContextSchema,
    processingMessageModeContextSchema,
    perchingModeContextSchema,
    interruptingMessageDetailsSchema
} from './types';

// Type guards and factories from types.ts
export {
    isActivityPhase,
    isModeContext,
    createDefaultBotState
} from './types';

// ============================================================================
// Transitions from transitions.ts
// ============================================================================

export {
    VALID_TRANSITIONS,
    isValidTransition,
    assertValidTransition,
    canInterrupt,
    getModeEmoji,
    TransitionError
} from './transitions';

// ============================================================================
// Manager from manager.ts
// ============================================================================

export type { BotStateManagerDeps } from './manager';
export { createBotStateManager } from './manager';

// ============================================================================
// StatusContextBuilder from status-context-builder.ts
// ============================================================================

export type {
    StatusGenerationStrategy,
    StatusContext,
    StatusPromptContext,
    CatchUpPromptContext,
    StatusContextBuilder,
    StatusContextBuilderDeps
} from './status-context-builder';
export { createStatusContextBuilder } from './status-context-builder';

// ============================================================================
// AgentContextBuilder from agent-context-builder.ts
// ============================================================================

export type {
    AgentConfig,
    McpServerConfig,
    ContextInjection,
    CatchUpContextInjection,
    AgentContextBuilder,
    AgentContextBuilderDeps
} from './agent-context-builder';
export { createAgentContextBuilder } from './agent-context-builder';

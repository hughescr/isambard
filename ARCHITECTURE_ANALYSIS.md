# Discord Bot State Management Architecture Analysis

## Executive Summary

The Discord bot state management system is **well-designed with clear separation of concerns**, but there are **subtle coordination issues** between the three central managers (`BotStateManager`, `PresenceManager`, and `StreamEventHandler`) that could lead to state inconsistencies and unnecessary complexity.

The core architecture is sound: `BotStateManager` is properly established as the single source of truth for operational state. However, the data flow between state changes and presence updates involves multiple bidirectional dependencies that make the system harder to reason about than necessary.

---

## GOOD: Well-Designed Aspects

### 1. **Orthogonal State Design in BotStateManager**
**File**: `src/integrations/discord/state/manager.ts`

✓ The separation of `mode` and `interrupted` flags is elegant:
```typescript
mode: OperationalMode           // What the bot is doing
interrupted: boolean            // Whether current activity was interrupted
```

This orthogonal design avoids exponential state combinations (e.g., no need for separate `catching_up_interrupted` mode state).

**Why it's good**:
- Separates concerns cleanly
- Single responsibility per flag
- Allows future modes to support interruption without changes to existing logic
- Well-documented in type comments

---

### 2. **Immutable State Pattern with Freezing**
**File**: `src/integrations/discord/state/manager.ts` (lines 85-161)

✓ BotStateManager enforces immutability through:
- Deep cloning state before returning to subscribers
- Deep freezing state to prevent external mutation
- Creating new Set instances for mode context data

**Benefits**:
- Prevents external code from corrupting internal state
- Makes state changes explicit and traceable
- Enables safe subscriber notifications

```typescript
function cloneState(state: BotState): BotState {
    const cloned: BotState = {
        mode: state.mode,
        interrupted: state.interrupted,
        activityPhase: state.activityPhase ? { ...state.activityPhase } : null,
        modeEnteredAt: new Date(state.modeEnteredAt),
        modeContext: cloneModeContext(state.modeContext),
    };
    return cloned;
}

function deepFreeze(state: BotState): Readonly<BotState> {
    Object.freeze(state);
    if(state.activityPhase) {
        Object.freeze(state.activityPhase);
    }
    Object.freeze(state.modeContext);
    return state;
}
```

---

### 3. **Throttling Placement at the Right Layer**
**File**: `src/integrations/discord/state/manager.ts` (lines 171-175)

✓ BotStateManager tracks presence update timing:
```typescript
function shouldUpdatePresence(): boolean {
    const now = Date.now();
    return (now - lastPresenceUpdateTime) >= updateThrottleMs;
}
```

This is the correct place because:
- Discord rate limits presence updates globally
- The state manager has visibility into all state changes
- Presence updates are a byproduct of state changes, not a primary operation
- Single throttle gate prevents wasted LLM calls for synopsis generation

---

### 4. **Comprehensive State Change Notifications**
**File**: `src/integrations/discord/state/manager.ts` (lines 346-352)

✓ State changes are typed with specific change types:
```typescript
type StateChange['changeType'] = 'mode_transition' | 'activity_phase' | 'interrupted' | 'context_update'
```

Subscribers can react specifically to the type of change, not just recompute everything.

---

### 5. **Stream Event Handler's Smart Synopsis Generation**
**File**: `src/integrations/discord/presence/stream-event-handler.ts` (lines 42-47)

✓ The `shouldGenerateSynopsis()` function acts as a type guard:
```typescript
export function shouldGenerateSynopsis(
    dynamicStatusGenerator: DynamicStatusGenerator | undefined,
    botStateManager: BotStateManager | undefined
): dynamicStatusGenerator is DynamicStatusGenerator {
    return Boolean(dynamicStatusGenerator && (botStateManager?.shouldUpdatePresence() ?? false));
}
```

**Why it's excellent**:
- Couples synopsis generation to the global throttle
- Prevents expensive LLM calls when updates would be discarded anyway
- Type-safe: narrows the type within conditional blocks
- Defensive: fails closed if botStateManager unavailable

---

### 6. **Clear Module Responsibilities**

**BotStateManager**:
- Single source of truth for operational state
- Enforces state machine rules
- Manages subscriptions
- Tracks presence update timing for throttling

**PresenceManager**:
- Updates Discord presence API
- Manages idle refresh loop lifecycle
- Applies immediate updates (throttling handled upstream)

**StreamEventHandler**:
- Converts agent stream events to activity phases
- Generates context-aware synopsis text
- Routes phase updates through BotStateManager
- Accumulates state from multiple stream events for rich context

**Middleware**:
- Wraps message processing with presence updates
- Starts typing indicator
- Orchestrates stream event handling

**Handlers** (in `handlers.ts`):
- Converts Discord.js messages to DiscordMessageContext
- Applies filtering rules (bot detection, channel monitoring)
- Routes to coordinator or direct processing
- Handles question/answer classification

---

## CONCERNS: Potential Issues & Anti-Patterns

### 1. **Bidirectional Coupling Between State and Presence (CRITICAL)**
**Files**: `src/integrations/discord/bot.ts`, `src/integrations/discord/presence/manager.ts`

**Problem**: State and presence are tightly coupled through multiple subscription paths:

```typescript
// In bot.ts lines 560-585: BotStateManager → PresenceManager
unsubscribeModeTransition ??= botStateManager.subscribe((change: StateChange) => {
    if(change.changeType === 'mode_transition') {
        const mode = change.newState.mode;
        const interrupted = change.newState.interrupted;

        if(mode === 'idle') {
            presenceManager!.transitionCatchUpMode('none');
        } else if(mode === 'catching_up') {
            presenceManager!.transitionCatchUpMode(interrupted ? 'catching_up_interrupted' : 'catching_up');
        }
    }

    if(change.changeType === 'interrupted') {
        const mode = change.newState.mode;
        const interrupted = change.newState.interrupted;
        if(mode === 'catching_up') {
            presenceManager!.transitionCatchUpMode(interrupted ? 'catching_up_interrupted' : 'catching_up');
        }
    }
});
```

**And**: PresenceManager internally manages its own `catchUpMode` state (line 126):
```typescript
let catchUpMode: CatchUpMode = 'none';
```

**Why this is problematic**:
- **Distributed state**: `catchUpMode` is duplicated between BotStateManager and PresenceManager's internal state
- **Synchronization risk**: The subscription in `bot.ts` keeps them in sync, but they're still separate
- **Cognitive load**: Understanding presence state requires looking at both managers
- **Logic fragility**: The mapping between BotState and CatchUpMode happens in `bot.ts`, not in either manager

Example of fragility (lines 567-573):
```typescript
// Map BotState mode to CatchUpMode for presence
if(mode === 'idle') {
    presenceManager!.transitionCatchUpMode('none');
} else if(mode === 'catching_up') {
    presenceManager!.transitionCatchUpMode(interrupted ? 'catching_up_interrupted' : 'catching_up');
} else if(mode === 'processing_message') {
    presenceManager!.transitionCatchUpMode('processing_message');
}
// perching mode will be handled when implemented
```

This mapping is fragile because:
- It's repeated in multiple places in `bot.ts`
- If a new mode is added, all these mappings must be updated
- The `perching` mode isn't handled yet (commented out)

**Risk**: If one path forgets to update this mapping, mode and presence become desynchronized.

---

### 2. **Activity Phase Updates Route Through Multiple Paths**
**Files**: `src/integrations/discord/presence/stream-event-handler.ts`, `src/integrations/discord/bot.ts`

**The issue**: Activity phases are updated through two different mechanisms:

**Path 1** - Direct to BotStateManager (in stream-event-handler.ts, lines 131-138):
```typescript
const safeUpdatePhase = async (phase: PresencePhase): Promise<void> => {
    try {
        if(phase.type === 'idle') {
            botStateManager.clearActivityPhase();
        } else {
            botStateManager.updateActivityPhase(phase);
        }
    } catch (error) {
        logger.error({ error, messageId }, 'Failed to update presence from stream event');
    }
};
```

**Path 2** - Through state manager subscription in bot.ts (lines 603-623):
```typescript
unsubscribeActivityPhase ??= botStateManager.subscribe((change: StateChange) => {
    if(change.changeType === 'activity_phase' && presenceManager) {
        const phase = change.newState.activityPhase;
        if(phase) {
            if(botStateManager.shouldUpdatePresence()) {
                void presenceManager.updatePhase(phase);
                botStateManager.recordPresenceUpdate();
            }
        } else {
            if(change.newState.mode === 'idle') {
                void presenceManager.updatePhase({ type: 'idle', since: new Date() });
                botStateManager.recordPresenceUpdate();
            }
        }
    }
});
```

**Why this is problematic**:
- Stream event handler calls `safeUpdatePhase()` which updates `BotStateManager`
- This triggers the subscription in `bot.ts`
- The subscription then calls `presenceManager.updatePhase()`
- There are **two separate throttle checks**: one in stream-event-handler.ts (via `shouldGenerateSynopsis()` for synopsis) and one in bot.ts (via `shouldUpdatePresence()` for actual presence)

**Data flow is convoluted**:
```
Stream Event
  → safeUpdatePhase(phase)
    → botStateManager.updateActivityPhase(phase)
      → notifySubscribers()
        → [bot.ts subscription]
          → if(shouldUpdatePresence())
            → presenceManager.updatePhase(phase)
```

This is **indirect communication** rather than **direct coordination**.

---

### 3. **PresenceManager Internal State Mutation**
**File**: `src/integrations/discord/presence/manager.ts` (lines 124-126)

PresenceManager maintains three pieces of mutable internal state:
```typescript
let currentPhase: PresencePhase | null = null;
let idleRefreshInterval: NodeJS.Timeout | null = null;
let catchUpMode: CatchUpMode = 'none';  // <-- Duplicates BotStateManager state
```

**The `catchUpMode` state** is problematic:
- It's updated only when `transitionCatchUpMode()` is called externally
- It's used to generate different status text prefixes (📥 for catch-up)
- If the BotStateManager subscription doesn't fire for some reason, this becomes stale

**Example**: In `refreshIdleStatus()` (lines 161-183), the `catchUpMode` is used to decide what status to generate:
```typescript
const modeAtStart = catchUpMode;
const activity = await idleStatusGenerator.generate(true, catchUpMode);

if(catchUpMode !== modeAtStart) {
    logger.debug({ modeAtStart, currentMode: catchUpMode }, 'Discarding stale idle status (mode changed during generation)');
    return;
}
```

This check is defensive against stale LLM responses, but the underlying issue is that `catchUpMode` shouldn't be in PresenceManager at all—it should come from BotStateManager.

---

### 4. **Idle Refresh Loop Lifecycle Management is Subtle**
**File**: `src/integrations/discord/presence/manager.ts` (lines 189-217)

The idle refresh loop is started in `updatePhase()` but stopped in `updatePhase()` and also in `stop()`. The logic is:

```typescript
// Transition TO idle: start the refresh loop
if(nowIdle && !wasIdle) {
    if(catchUpMode === 'none') {
        await startIdleRefresh();
    }
    return;
}

// Transition FROM idle: stop the refresh loop
if(!nowIdle && wasIdle) {
    stopIdleRefresh();
}
```

**Subtlety**: The idle refresh loop is **not** started when `catchUpMode !== 'none'`:
```typescript
if(catchUpMode === 'none') {
    await startIdleRefresh();
}
```

This is because during catch-up mode, the stream event handler drives status updates. But this means:
- The state of "should idle refresh be running" is distributed across:
  - The `idleRefreshInterval` variable (boolean-ish)
  - The `catchUpMode` variable
  - The logic in `updatePhase()`
- If `catchUpMode` and actual mode get out of sync, this breaks

---

### 5. **Redundant State Synchronization in Handlers**
**File**: `src/integrations/discord/handlers.ts` (lines 244-265)

In `handleStateAndInbox()`, the code updates BotStateManager directly:
```typescript
function handleStateAndInbox(
    message: Message,
    botStateManager: BotStateManager | undefined,
    inboxManager: InboxManager | undefined,
    shouldRespond: boolean
): void {
    // Transition state manager to processing_message mode when in idle mode
    if(botStateManager?.getMode() === 'idle') {
        botStateManager.startProcessingMessage(
            createChannelId(message.channel.id),
            message.content
        );
    }

    // Update channel metadata in inbox...
}
```

But there's a separate subscription in `bot.ts` (lines 603-623) that syncs to PresenceManager. This means:
- Multiple places in the codebase can call BotStateManager methods
- Each one relies on the subscriptions in `bot.ts` to propagate to PresenceManager
- This is implicit coordination rather than explicit APIs

**Better approach** would be: If presence updates are always needed when state changes, the BotStateManager could have a `PresenceManager` injected, or there should be a single place that owns all state-to-presence synchronization.

---

### 6. **PresenceManager.transitionCatchUpMode() Has Complex Side Effects**
**File**: `src/integrations/discord/presence/manager.ts` (lines 220-287)

This method is marked as "has side effects" in its JSDoc, but the side effects are quite hidden:

```typescript
transitionCatchUpMode(mode: CatchUpMode, catchUpContext?: CatchUpSynopsisContext): void {
    const previousMode = catchUpMode;
    catchUpMode = mode;

    // When ENTERING catch-up mode (from 'none'), generate ONE initial status update
    const enteringCatchUp = (mode === 'catching_up' || mode === 'catching_up_interrupted') && previousMode === 'none';

    // Handle based on current phase state
    if(currentPhase) {
        // ... complex logic for different phase states
    }

    // DON'T trigger idle refresh loop during catch-up - stream handler drives updates
    // DO trigger immediate idle refresh when exiting catch-up to 'none' (handled above)
}
```

**Side effects include**:
- Mutating internal `catchUpMode` state
- Potentially generating and applying presence updates (async)
- Starting/stopping the idle refresh loop indirectly
- Different behavior depending on `currentPhase` state

This method needs to be called in the right order relative to other operations. For example, if you call `transitionCatchUpMode('catching_up')` before `updatePhase()` sets `currentPhase`, behavior differs.

---

## RECOMMENDATIONS: Specific Improvements

### 1. **Move CatchUpMode Computation to BotStateManager (HIGH PRIORITY)**

**Current problem**: `CatchUpMode` in PresenceManager duplicates BotStateManager state.

**Solution**: Add a method to BotStateManager:
```typescript
function getCatchUpMode(): CatchUpMode {
    const mode = currentState.mode;
    const interrupted = currentState.interrupted;

    if(mode === 'idle') return 'none';
    if(mode === 'catching_up') return interrupted ? 'catching_up_interrupted' : 'catching_up';
    if(mode === 'processing_message') return 'processing_message';
    if(mode === 'perching') return 'perching'; // Future

    return 'none';
}
```

Then in PresenceManager, accept BotStateManager in deps and query it instead of maintaining separate state:
```typescript
export interface PresenceManagerDeps {
    discordClient: DiscordClient
    activeStatusGenerator: ActiveStatusGenerator
    idleStatusGenerator: IdleStatusGenerator
    dynamicStatusGenerator?: DynamicStatusGenerator
    botStateManager: BotStateManager  // NEW: Get mode from here
    config: PresenceConfig
    logger: Logger
}
```

Then in `refreshIdleStatus()`:
```typescript
async function refreshIdleStatus(): Promise<void> {
    if(currentPhase?.type !== 'idle') return;

    const modeAtStart = botStateManager.getCatchUpMode();  // Query instead of reading local state
    const activity = await idleStatusGenerator.generate(true, modeAtStart);

    if(botStateManager.getCatchUpMode() !== modeAtStart) {
        logger.debug({ modeAtStart, currentMode: botStateManager.getCatchUpMode() }, '...');
        return;
    }

    await applyPresenceUpdate(activity);
}
```

**Benefits**:
- ✓ Single source of truth (BotStateManager)
- ✓ No synchronization needed
- ✓ Removes fragile mapping logic from bot.ts
- ✓ Easier to add new modes (just update the switch/if statement in one place)
- ✓ Type-safe when new modes are added (compiler will complain about uncovered cases)

---

### 2. **Collapse Activity Phase Update Paths (HIGH PRIORITY)**

**Current problem**: Activity phase updates route through BotStateManager subscription, then to PresenceManager, with two separate throttle checks.

**Solution**: Have StreamEventHandler call PresenceManager directly for non-throttled operations:

```typescript
// In stream-event-handler.ts
const safeUpdatePhase = async (phase: PresencePhase): Promise<void> => {
    try {
        // Update state manager (for state tracking)
        if(phase.type === 'idle') {
            botStateManager.clearActivityPhase();
        } else {
            botStateManager.updateActivityPhase(phase);
        }

        // Apply presence update DIRECTLY (without waiting for subscription)
        // This keeps the data flow linear: Stream → State → Presence
        if(botStateManager.shouldUpdatePresence()) {
            await presenceManager.updatePhase(phase);
            botStateManager.recordPresenceUpdate();
        }
    } catch (error) {
        logger.error({ error, messageId }, 'Failed to update presence from stream event');
    }
};
```

Then in `bot.ts`, the subscription becomes a secondary synchronization for other callers:
```typescript
// This subscription now acts as a fallback for state changes initiated outside stream events
unsubscribeActivityPhase ??= botStateManager.subscribe((change: StateChange) => {
    if(change.changeType === 'activity_phase' && presenceManager) {
        // Only update presence if NOT already updated by stream handler
        // (This is now the exception path, not the main path)
        const phase = change.newState.activityPhase;
        if(phase && botStateManager.shouldUpdatePresence()) {
            void presenceManager.updatePhase(phase);
            botStateManager.recordPresenceUpdate();
        }
    }
});
```

**Benefits**:
- ✓ Single, linear data flow: Stream Event → BotStateManager → PresenceManager
- ✓ Single throttle gate (in StreamEventHandler)
- ✓ No implicit coordination through subscriptions for the main path
- ✓ Easier to trace and debug

---

### 3. **Formalize State-to-Presence Mapping**

**Current problem**: The mapping between `BotState.mode` and `CatchUpMode` is scattered and repeated.

**Solution**: Create a dedicated mapper module:

```typescript
// src/integrations/discord/presence/mode-mapper.ts

export interface ModeMapping {
    readonly botMode: BotStateManager['getMode']
    readonly interrupted: boolean
    readonly catchUpMode: CatchUpMode
}

export function computeCatchUpMode(
    mode: OperationalMode,
    interrupted: boolean
): CatchUpMode {
    switch(mode) {
        case 'idle': return 'none';
        case 'catching_up': return interrupted ? 'catching_up_interrupted' : 'catching_up';
        case 'processing_message': return 'processing_message';
        case 'perching': return 'perching';
        default: return 'none'; // Exhaustive check by TS
    }
}

// Test for completeness:
// Ensures all OperationalMode values are handled
const exhaustiveCheck: OperationalMode = 'idle';
switch(exhaustiveCheck) {
    case 'idle':
    case 'catching_up':
    case 'processing_message':
    case 'perching':
        break;
}
```

Then use this single function everywhere:
- In BotStateManager.getCatchUpMode() (from recommendation 1)
- In the subscription mapper in bot.ts
- In tests

**Benefits**:
- ✓ Single, tested mapping logic
- ✓ Type-safe: compiler ensures all cases handled
- ✓ Easy to add new modes (add case, compiler complains)
- ✓ Centralizes business logic

---

### 4. **Make Idle Refresh Loop Dependency on Mode Explicit**

**Current problem**: The idle refresh loop is conditionally started based on `catchUpMode` being 'none', making its lifecycle fragile.

**Solution**: Have PresenceManager subscribe to mode changes:

```typescript
export function createPresenceManager(
    deps: PresenceManagerDeps & { botStateManager: BotStateManager }
): PresenceManager {
    // ... existing code ...

    // Listen to mode transitions to manage idle refresh lifecycle
    const unsubscribe = botStateManager.subscribe((change) => {
        if(change.changeType === 'mode_transition' || change.changeType === 'interrupted') {
            const catchUpMode = computeCatchUpMode(change.newState.mode, change.newState.interrupted);

            // If transitioning TO idle from non-catch-up, start idle refresh
            if(catchUpMode === 'none' && currentPhase?.type === 'idle') {
                void startIdleRefresh();
            }

            // If transitioning FROM idle or entering catch-up, stop idle refresh
            if(catchUpMode !== 'none' || currentPhase?.type !== 'idle') {
                stopIdleRefresh();
            }
        }
    });

    // ... return interface with cleanup ...
    return {
        stop() {
            unsubscribe(); // Clean up listener
            stopIdleRefresh();
            // ...
        }
    };
}
```

**Benefits**:
- ✓ Idle refresh lifecycle is explicit and self-contained
- ✓ No fragile conditional logic in updatePhase()
- ✓ State machine for idle refresh is visible and testable
- ✓ Automatically handles edge cases (e.g., interrupted transitions)

---

### 5. **Document State Flow with Architecture Diagram**

**Current problem**: The data flow is implicit and distributed across files.

**Solution**: Create a flow diagram in documentation:

```
Message Received
    ↓
[handlers.ts] determineResponseContext()
    ↓
shouldRespond? → No → Return
    ↓
[handlers.ts] handleStateAndInbox()
    → botStateManager.startProcessingMessage(channelId, userMessage)
    ↓
[bot.ts] BotStateManager subscription: mode_transition
    → presenceManager.transitionCatchUpMode('processing_message')
    ↓
[bot.ts] coordinator.handleMessage(context, message, channel)
    → agent.chat(context, onStreamEvent)
    ↓
[stream-event-handler.ts] onStreamEvent(event)
    → Analyzes event (assistant, tool_progress, result)
    → Updates botStateManager.updateActivityPhase(phase)
    ↓
[bot.ts] BotStateManager subscription: activity_phase
    → Checks shouldUpdatePresence()
    → presenceManager.updatePhase(phase)
    → botStateManager.recordPresenceUpdate()
    ↓
[middleware.ts] complete()
    → botStateManager.clearActivityPhase()
    → botStateManager.goIdle()
    ↓
[bot.ts] BotStateManager subscription: mode_transition
    → presenceManager.transitionCatchUpMode('none')
    → Starts idle refresh loop
```

Document also:
- Throttling happens at BotStateManager level
- Synopsis generation checks throttle before attempting LLM call
- Catch-up mode interruption path
- Recovery after completion or error

---

### 6. **Extract CatchUpMode Mapping to PresenceManager Constructor**

**Current problem**: `transitionCatchUpMode()` is called from multiple places in bot.ts with explicit mode mappings.

**Solution**: Make PresenceManager aware of BotStateManager and listen for changes:

```typescript
export function createPresenceManager(
    deps: PresenceManagerDeps & { botStateManager: BotStateManager }
): PresenceManager {
    const { botStateManager } = deps;

    // Listen for mode transitions and automatically update catch-up mode
    const unsubscribe = botStateManager.subscribe((change) => {
        if(change.changeType === 'mode_transition' || change.changeType === 'interrupted') {
            const newCatchUpMode = computeCatchUpMode(
                change.newState.mode,
                change.newState.interrupted
            );

            // Automatically update presence based on new mode
            // (no need to call transitionCatchUpMode from bot.ts)
            updateCatchUpModeInternal(newCatchUpMode);
        }
    });

    function updateCatchUpModeInternal(mode: CatchUpMode) {
        // ... existing logic from transitionCatchUpMode ...
    }

    return {
        // transitionCatchUpMode() is now rarely used (only at startup with context)
        transitionCatchUpMode(mode: CatchUpMode, catchUpContext?: CatchUpSynopsisContext) {
            // Update internal state and handle context-specific generation
            updateCatchUpModeInternal(mode);
            // ... handle catchUpContext ...
        },

        stop() {
            unsubscribe();
            stopIdleRefresh();
            // ...
        }
    };
}
```

Then in `bot.ts`, remove the complex subscription:
```typescript
// OLD: Removed - PresenceManager now handles this automatically
// unsubscribeModeTransition ??= botStateManager.subscribe((change) => { ... });

// ONLY call for initial context (startup):
presenceManager?.transitionCatchUpMode('catching_up', catchUpContext);
```

**Benefits**:
- ✓ PresenceManager is self-contained
- ✓ Removes complex mapping logic from bot.ts
- ✓ Automatic synchronization (no risk of forgetting to call transitionCatchUpMode)
- ✓ Single place where mode-to-presence mapping happens

---

## Summary Table

| Aspect | Status | Risk | Priority |
|--------|--------|------|----------|
| **Orthogonal state design** | ✓ Good | Low | — |
| **Immutable state pattern** | ✓ Good | Low | — |
| **Throttling placement** | ✓ Good | Low | — |
| **CatchUpMode duplication** | ⚠ Concern | Medium | HIGH |
| **Activity phase routing** | ⚠ Concern | Medium | HIGH |
| **PresenceManager internal state** | ⚠ Concern | Medium | MEDIUM |
| **Idle refresh lifecycle** | ⚠ Concern | Low | MEDIUM |
| **State-to-presence mapping** | ⚠ Concern | Medium | MEDIUM |
| **Documentation clarity** | ⚠ Concern | Low | LOW |

---

## Testing Recommendations

1. **Unit test CatchUpMode mapper** with all combinations of mode + interrupted
2. **Integration test** the full state → presence flow for each operational mode
3. **Test synchronization** between BotStateManager and PresenceManager by:
   - Triggering rapid mode changes
   - Verifying presence updates match mode changes
   - Checking idle refresh loop lifecycle
4. **Test error paths**: what happens if PresenceManager fails during an update?
5. **Test concurrent operations**: multiple messages arriving during catch-up

---

## Conclusion

The architecture is **fundamentally sound** with clear module boundaries and good design patterns. The **single source of truth principle is well-established** through BotStateManager.

The main improvement opportunity is **reducing bidirectional coupling** between the managers by:
1. Centralizing CatchUpMode computation in BotStateManager
2. Simplifying activity phase update routing
3. Making mode-to-presence mapping explicit and testable

These changes would reduce cognitive load and make the system easier to extend with new modes and features.

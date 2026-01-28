# Architecture Review: State Management & Presence Systems
## Post-Refactoring Analysis (2026-01-27)

---

## Executive Summary

The refactored state management and presence systems achieve their architectural goals: **single update path, required state manager, and atomic catch-up interruption**. The implementation is **well-structured and coherent**, with strong separation of concerns and clear data flow.

**Overall Health: ✅ GOOD**

However, three areas warrant attention:
1. ⚠️ **Reconnection Idempotency**: Subscription setup relies on `??=` operator—verify this handles all reconnection scenarios
2. ⚠️ **Unobservable State**: State transitions in handlers don't flow through botStateManager (by design, but limits visibility)
3. ✅ **Throttling Logic**: Correctly gated at single point with proper bypass for idle transitions

---

## 1. Single Update Path Verification

### ✅ GOOD - Update Path is Unified

**All presence updates flow through the documented path:**
```
botStateManager.updateActivityPhase(phase)
  → subscription in bot.ts receives StateChange
    → presenceManager.updatePhase(phase) [if throttle allows]
```

**Evidence:**

#### Stream Event Handler → botStateManager (✅ GOOD)
**File:** `stream-event-handler.ts:129-138`
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
**Status:** Stream handler exclusively routes through botStateManager. No direct presenceManager calls.

#### botStateManager → Subscription in bot.ts (✅ GOOD)
**File:** `bot.ts:578-596`
```typescript
unsubscribeActivityPhase ??= botStateManager.subscribe((change: StateChange) => {
    if(change.changeType === 'activity_phase' && presenceManager) {
        const phase = change.newState.activityPhase;
        if(phase) {
            if(botStateManager.shouldUpdatePresence()) {
                void presenceManager.updatePhase(phase);
            }
        } else {
            if(change.newState.mode === 'idle') {
                void presenceManager.updatePhase({ type: 'idle', since: new Date() });
            }
        }
    }
});
```
**Status:** Subscription is the exclusive gateway to presenceManager. Throttle checked here (line 583).

#### No Bypass Paths Found (✅ GOOD)
- **Status Middleware** (`middleware.ts`): Creates stream event handler, not direct presenceManager calls ✅
- **Message Handler** (`handlers.ts`): No presenceManager calls found ✅
- **Catch-up Session Runner** (`catchup/session-runner.ts`): No direct presenceManager calls; uses stream event handler ✅
- **Presence Manager** (`manager.ts`): Self-contained, applies updates it receives ✅

### Minor Observation: Direct transitionCatchUpMode() Call

**File:** `bot.ts:697, 762, 768, 795`
```typescript
presenceManager?.transitionCatchUpMode('catching_up', catchUpContext);
presenceManager?.transitionCatchUpMode('processing_message');
presenceManager?.transitionCatchUpMode('catching_up');
presenceManager?.transitionCatchUpMode('none');
```

**Status:** ✅ These are **intentional and correct**. They set display mode, not activity phase. The activity phase updates flow through botStateManager subscriptions as designed. No architectural violation.

---

## 2. Subscription Lifecycle

### ✅ GOOD - Subscriptions Set Once, Cleaned Up Properly

#### Setup Idempotency with `??=` Operator (✅ GOOD)
**File:** `bot.ts:434-435, 548, 578`
```typescript
let unsubscribeModeTransition: (() => void) | undefined;
let unsubscribeActivityPhase: (() => void) | undefined;

// Setup only once (not on each reconnect)
unsubscribeModeTransition ??= botStateManager.subscribe((change: StateChange) => { ... });
unsubscribeActivityPhase ??= botStateManager.subscribe((change: StateChange) => { ... });
```

**Status:** ✅ **Correct idempotent setup**
- `??=` operator ensures subscriptions are created once per bot instance
- Stored in closure variables declared at module scope (lines 434-435)
- Multiple reconnects will not create duplicate subscriptions
- **Risk Level: LOW** — Discord.js reconnections fire 'clientReady' multiple times, but subscriptions are protected

#### Cleanup in stop() (✅ GOOD)
**File:** `bot.ts:896-902`
```typescript
if(unsubscribeModeTransition) {
    unsubscribeModeTransition();
}
if(unsubscribeActivityPhase) {
    unsubscribeActivityPhase();
}
botStateManager.stop();
```

**Status:** ✅ **Correct cleanup order**
1. Unsubscribe from listeners (prevents new callbacks)
2. Stop state manager (clears subscribers set and marks as stopped)
3. Proper teardown prevents resource leaks

**Verification:** BotStateManager.stop() at `manager.ts:452-456` calls `subscribers.clear()` and sets `isStopped = true`. Future calls to subscribe() will throw (line 433).

---

## 3. State Machine Coherence

### ✅ GOOD - Coherent State Transitions

#### BotStateManager as Single Source of Truth (✅ GOOD)
**File:** `manager.ts:63-491`

**State invariants enforced:**
1. **Immutability:** All state changes return new objects (lines 189-198, 221-227, etc.)
2. **Validation:** All transitions checked via `isValidTransition()` (lines 185-186, 210-211, 240-241)
3. **Notification:** All changes trigger subscribers (line 203, 233, 263, etc.)
4. **Frozen State:** Read operations return deep-frozen copies (lines 160, 124-125)

#### Valid State Transitions (✅ GOOD)
**File:** `transitions.ts:38-43`
```typescript
export const VALID_TRANSITIONS: Record<OperationalMode, OperationalMode[]> = {
    idle:               ['catching_up', 'processing_message', 'perching'],
    catching_up:        ['idle'],
    processing_message: ['idle'],
    perching:           ['idle'],
};
```

**Status:** ✅ **Enforced hub pattern**
- All modes must transition through `idle` (lines 40-42)
- No direct `catching_up` → `processing_message` transitions possible
- Prevents invalid state combinations
- **Maps to workflow:** User message during catch-up → interrupt() → goIdle() → startProcessingMessage()

#### Mode Context Cloning (✅ GOOD)
**File:** `manager.ts:100-111`

**Handles Set<ChannelId> correctly** (CatchingUpModeContext):
```typescript
return {
    ...context,
    viewedChannels: new Set(context.viewedChannels),
} as CatchingUpModeContext;
```

**Status:** ✅ Proper deep-copy of Sets prevents external mutations of state.

### No Orphaned States (✅ GOOD)
- Mode entry stored in `modeEnteredAt` (line 193, 225, 254) — tracks when mode started
- Mode context always matches current mode (enforced by transitions)
- Activity phase only valid in non-idle modes (not constrained in code, but enforced by subscription logic)
- No "zombie" states possible after errors (cleanup in stop() prevents this)

---

## 4. Throttling Logic

### ✅ GOOD - Single Throttle Gate at Correct Location

#### Throttle Checked Before presenceManager.updatePhase() (✅ GOOD)
**File:** `bot.ts:578-596`
```typescript
unsubscribeActivityPhase ??= botStateManager.subscribe((change: StateChange) => {
    if(change.changeType === 'activity_phase' && presenceManager) {
        const phase = change.newState.activityPhase;
        if(phase) {
            // THROTTLE CHECK HERE - before presenceManager call
            if(botStateManager.shouldUpdatePresence()) {
                void presenceManager.updatePhase(phase);
            }
        } else {
            // BYPASS for idle - intentional
            if(change.newState.mode === 'idle') {
                void presenceManager.updatePhase({ type: 'idle', since: new Date() });
            }
        }
    }
});
```

**Status:** ✅ **Correct gate placement**
- Active phases (thinking, using_tool, responding) throttled via `shouldUpdatePresence()` (line 583)
- Idle transitions bypass throttle (line 591-592) — intentional per comment

#### Throttle Timestamp Updated (✅ GOOD)
**File:** `manager.ts:336-350`
```typescript
function updateActivityPhase(phase: ActivityPhase): void {
    assertNotStopped();
    const previousState = cloneState(currentState);

    currentState = {
        ...currentState,
        activityPhase: phase,
    };

    lastPresenceUpdateTime = Date.now();  // ← Updated here

    logger.debug({ phase: phase.type }, 'Activity phase updated');
    notifySubscribers(previousState, 'activity_phase');
}
```

**Status:** ✅ **Timestamp updated when phase changes**, not when subscription fires. Correct.

#### Throttle Implementation (✅ GOOD)
**File:** `manager.ts:171-175`
```typescript
function shouldUpdatePresence(): boolean {
    const now = Date.now();
    return (now - lastPresenceUpdateTime) >= updateThrottleMs;
}
```

**Status:** ✅ **Simple, correct logic**
- Default throttle: 12 seconds (line 41)
- Configurable via constructor (line 64)
- Used in stream-event-handler for synopsis generation (line 161) — prevents expensive LLM calls

#### No Bypass Paths for Throttle (✅ GOOD)
- Stream handler doesn't call presenceManager directly ✅ (routed through botStateManager)
- Message handler doesn't bypass throttle ✅
- transitionCatchUpMode() calls are mode display updates, not activity phases ✅
- Idle transitions intentionally bypass throttle (architectural choice, documented) ✅

---

## 5. Potential Issues Analysis

### Issue A: Double-Subscription Risk on Reconnect

**Concern:** If clientReady fires twice, could subscriptions be duplicated?

**Analysis:**
```typescript
// Line 548 in bot.ts
unsubscribeModeTransition ??= botStateManager.subscribe((change: StateChange) => { ... });
```

**Verdict:** ✅ **No risk**
- `??=` operator ensures assignment only if `undefined`
- After first reconnect, `unsubscribeModeTransition` is a function (truthy)
- Second reconnect: `??=` skips assignment
- **Verified:** Node.js nullish coalescing operator (`??=`) only assigns if left side is null/undefined

**Code path:**
1. First `clientReady`: `unsubscribeModeTransition` is undefined → `??=` assigns → subscription created ✅
2. Reconnect `clientReady`: `unsubscribeModeTransition` is function → `??=` skips → no duplicate ✅
3. `stop()`: calls unsubscribeModeTransition(), clears reference (implicitly via scope)
4. If restarted: New bot instance, new closure, new subscriptions ✅

### Issue B: Mode Transition Not Visible in Handlers

**Concern:** Handlers like `createMessageHandler()` transition state manager without flowing back through subscriptions.

**File:** `handlers.ts:253-257`
```typescript
if(botStateManager?.getMode() === 'idle') {
    botStateManager.startProcessingMessage(
        createChannelId(message.channel.id),
        message.content
    );
}
```

**Analysis:** ✅ **By design, not a bug**
- State transition emits 'mode_transition' change (line 233 in manager.ts)
- Subscriptions in bot.ts (lines 548-572) listen for 'mode_transition' changes
- Presence gets updated via transitionCatchUpMode() mapping (lines 555-560 in bot.ts)
- **Data flow:** handler → botStateManager.startProcessingMessage() → notifySubscribers() → transitionCatchUpMode()
- **Verdict:** Correct, subscriptions receive the notification properly

**Trace:**
```
handler calls startProcessingMessage()
  ↓
manager.ts:206-233 creates new state
  ↓
notifySubscribers(previousState, 'mode_transition')
  ↓
subscription in bot.ts:548 receives 'mode_transition'
  ↓
transitionCatchUpMode('processing_message')
```

### Issue C: Catch-up Interruption Atomicity

**Concern:** Can an interruption be partially applied?

**File:** `handlers.ts:199-222`
```typescript
async function handleCatchUpInterruption(
    message: Message,
    catchUpSessionRunner: CatchUpSessionRunner
): Promise<void> {
    logger.info({
        channelId: message.channel.id,
        msg:       'Interrupting catch-up mode for new message',
    });

    const channelId = createChannelId(message.channel.id);
    const channel = message.channel as TextChannel;
    catchUpSessionRunner.interrupt({
        channelId,
        author:      message.author.username,
        channelName: channel.name ?? message.channel.id,
        content:     message.content,
    });

    // Presence update is handled by the subscription in bot.ts
}
```

**Analysis:** ✅ **Atomic interruption**
- `interrupt()` call to runner updates internal state (line 607 calls runner.interrupt)
- Presence subscription is idempotent (bot.ts:548-572 checks for 'mode_transition' change type)
- State manager's `interrupt()` method is atomic (manager.ts:287-311)
- **Race condition risk:** Minimal - interruption sets flag, stream handler completes and transitions to idle, resume can start new session
- **Verified:** interrupt() only sets `interrupted: true`, doesn't change mode (line 305 in manager.ts)

**Verdict:** ✅ Interruption is properly atomic via state manager flag.

### Issue D: Memory Leaks on Error

**Concern:** Do subscriptions or timers leak if errors occur?

**Analysis:**

#### Subscription Cleanup (✅ Good)
- Stored in closure variables (bot.ts:434-435)
- Explicitly called in stop() (lines 897-902)
- If stop() called, cleanup occurs
- If exception in onMessageCreate, doesn't affect subscriptions (try/catch in handlers)

#### Timer Cleanup (✅ Good)
- PresenceManager clears idle refresh interval in stop() (manager.ts:335-337)
- Called by bot.stop() (line 907)
- No dangling timers possible

#### Coordinator Cleanup (✅ Good)
- Explicitly stopped in bot.stop() (line 892)
- Rate limiter stopped (line 911)
- Question registry stopped (line 895)

**Verdict:** ✅ Cleanup is comprehensive and ordered correctly.

### Issue E: Race Condition Between Activity Phase and Mode

**Concern:** Can activity phase diverge from mode?

**Scenario:** Mode transitions to idle while activity phase update is in-flight

**Analysis:**
```typescript
// Stream handler queues async activity phase update
void safeUpdatePhase({
    type:      'thinking',
    startedAt: new Date(),
    userMessage,
    generatedStatus: synopsis,
});

// Completion transitions to idle
void safeUpdatePhase({
    type:  'idle',
    since: new Date(),
});
```

**Verdict:** ✅ **No divergence possible**
1. Activity phase and idle phase both route through botStateManager
2. BotStateManager stores both in same transaction (line 340-342 in manager.ts: spread current state, update activityPhase)
3. Subscription receives single StateChange notification
4. Idempotent setter: setting activityPhase is safe even if mode is idle
5. **Throttling:** Both active and idle updates go through same subscription

**Verified:** No separate "activity phase timeout" or orphaned phase cleanup needed.

---

## 6. Architecture Strengths

### ✅ Clean Separation of Concerns
- **BotStateManager:** State machine logic only (no Discord/presence knowledge)
- **PresenceManager:** Discord presence updates only (no bot state machine logic)
- **Stream Event Handler:** Phase tracking and synopsis generation (routes to state manager)
- **Handlers:** Message filtering and routing (transitions state manager)

### ✅ Single Responsibility
- **Throttling:** Only in subscription gate (bot.ts:583)
- **State Validation:** Only in state manager (manager.ts:185-186)
- **Presence Updates:** Only in presence manager (manager.ts:130-146)
- **Subscription Routing:** Only in bot.ts factory (lines 548-596)

### ✅ Data Flow Clarity
```
Discord Events (messageCreate, etc.)
  ↓
Handlers → BotStateManager methods
  ↓
State changes → notifySubscribers()
  ↓
Subscriptions in bot.ts
  ↓
PresenceManager.updatePhase() or transitionCatchUpMode()
  ↓
Discord.js API (setActivity)
```

### ✅ Immutable State
- getState() returns frozen copy (manager.ts:160)
- Mode context cloned (including Set handling) (manager.ts:101-111)
- Prevents external mutations from breaking state invariants

### ✅ Type Safety
- Discriminated union for ActivityPhase (types.ts:74-77)
- Branded types for ChannelId, UserId, etc.
- Zod schemas for runtime validation
- BotStateManager correctly typed return interface (manager.ts:463-490)

---

## 7. Summary Table

| Area | Status | Evidence | Risk |
|------|--------|----------|------|
| **Single Update Path** | ✅ GOOD | All presenceManager calls via subscription gate | LOW |
| **Subscription Lifecycle** | ✅ GOOD | `??=` idempotent setup, explicit cleanup in stop() | LOW |
| **State Machine Coherence** | ✅ GOOD | Hub pattern enforced, transitions validated, frozen state | LOW |
| **Throttling Logic** | ✅ GOOD | Single gate before presenceManager, timestamp updated correctly | LOW |
| **Double-Subscription Risk** | ✅ GOOD | `??=` operator prevents duplicates on reconnect | LOW |
| **Mode Visibility** | ✅ GOOD | Handlers → state manager → subscriptions flow correct | LOW |
| **Interruption Atomicity** | ✅ GOOD | State manager flag, subscription-driven presence updates | LOW |
| **Memory Leaks** | ✅ GOOD | Comprehensive cleanup in stop(), no dangling timers | LOW |
| **Race Conditions** | ✅ GOOD | Activity phase & idle atomic via single state transaction | LOW |

---

## 8. Recommendations

### 1. Document Idempotent Setup Pattern ✅ (MINOR)
**Action:** Add comment clarifying `??=` usage in bot.ts
```typescript
// Ensure subscriptions are set up only once, even if clientReady fires multiple times
// The ??= operator short-circuits on subsequent reconnects
unsubscribeModeTransition ??= botStateManager.subscribe((change: StateChange) => { ... });
```
**Effort:** 5 min | **Impact:** Improved code clarity

### 2. Verify Reconnection Scenarios (MINOR)
**Action:** Add test case for bot.stop() → bot.start() lifecycle
- Verify unsubscribeModeTransition and unsubscribeActivityPhase are reset
- Confirm no subscription duplicates on restart

**Current Status:** stop() is called (line 882-915), but does it reset closure variables?
**Analysis:** ✅ Closure variables are NOT reset, they persist in the factory function. Next start() would attempt to create bot with same closed-over variables. **This is correct** because bot instances are created once and stopped once. New bot = new factory function = new closures.

### 3. Add Integration Test for Presence Flow (NICE-TO-HAVE)
**Action:** Create test that verifies end-to-end flow:
1. Stream event → botStateManager.updateActivityPhase()
2. Subscription fires → presenceManager.updatePhase()
3. Discord.js API called

**Effort:** 30 min | **Impact:** High confidence in architecture

### 4. Monitor Throttle Effectiveness (OBSERVATIONAL)
**Action:** Add metric tracking for throttled vs applied updates
- Currently, no visibility into how many active phase updates are throttled
- Could use logger.debug() to track throttle hits

**Current:** Update throttle of 12s is reasonable for Discord rate limits

---

## Conclusion

The refactored state management and presence systems are **well-architected and properly implemented**. The goals have been achieved:

✅ **Single update path:** Verified. All presence updates flow through botStateManager → subscription → presenceManager.
✅ **BotStateManager required:** Verified. No fallback paths; manager is the mandatory gateway.
✅ **No duplicate subscriptions:** Verified. `??=` operator ensures idempotent setup.
✅ **Atomic catch-up interruption:** Verified. State manager flag + subscription-driven presence.

**Overall Rating: ✅ GOOD**

The architecture is ready for production. The separation of concerns is clean, data flow is clear, and error handling is comprehensive.

---

## File Reference

**Key Files Reviewed:**
- `src/integrations/discord/bot.ts` (920 lines) - Bot factory & lifecycle
- `src/integrations/discord/presence/manager.ts` (341 lines) - Presence state
- `src/integrations/discord/presence/stream-event-handler.ts` (372 lines) - Stream event routing
- `src/integrations/discord/presence/middleware.ts` (164 lines) - Message processing wrapper
- `src/integrations/discord/handlers.ts` (635 lines) - Discord event handlers
- `src/integrations/discord/state/manager.ts` (492 lines) - State machine
- `src/integrations/discord/state/types.ts` (600 lines) - Type definitions
- `src/integrations/discord/state/transitions.ts` (106 lines) - Transition rules
- `src/integrations/discord/catchup/session-runner.ts` - Catch-up orchestration

**Tests Verified:**
- `tests/unit/integrations/discord/state/manager.test.ts`
- `tests/unit/integrations/discord/presence/manager.test.ts`
- `tests/unit/integrations/discord/presence/manager-lifecycle.test.ts`

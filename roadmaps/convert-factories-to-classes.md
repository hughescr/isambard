# Convert Factory Functions to TypeScript Classes

## Problem Statement

Many modules use closure-based factory functions (`createX()`) instead of proper TypeScript classes. While functional patterns have their place, TypeScript classes provide better tooling support, clearer visibility semantics, and more idiomatic TypeScript code.

**Key issues:**
- Factory functions hide implementation details in closures
- TypeScript can't infer proper types for returned objects
- IDE navigation and autocomplete are less effective
- No explicit visibility modifiers (public/private)
- Harder to extend or compose
- Less familiar pattern for TypeScript developers

## Current Pattern

Factory functions return objects with closures for state management:

**Example: createStreamTracker (src/agent/stream-tracker.ts)**
```typescript
export function createStreamTracker(): StreamTracker {
    // Internal state hidden in closure
    let thinking = '';
    let text = '';
    let pendingToolUse: ToolUseBlock | null = null;
    let sessionId: string | undefined;

    return {
        update(message: AgentStreamEvent): void {
            // Mutate closure variables
            if (message.type === 'assistant') {
                thinking = extractThinkingContent(message) ?? '';
                // ...
            }
        },

        getProgress(): StreamProgress {
            return { thinking, text, pendingToolUse, sessionId };
        },

        reset(): void {
            thinking = '';
            text = '';
            pendingToolUse = null;
            sessionId = undefined;
        },
    };
}
```

**Example: createMessageCoordinator (src/integrations/discord/message-coordinator.ts)**
```typescript
export function createMessageCoordinator(config?: MessageCoordinatorConfig): MessageCoordinator {
    const debounceMs = config?.debounceMs ?? 2000;
    const onResponse = config?.onResponse;

    // Hidden state in closures
    const channelStates = new Map<ChannelId, ChannelState>();
    let processor: MessageProcessor | null = null;

    function handleMessage(context: DiscordMessageContext, discordMessage: Message): void {
        // Mutate closure variables
        const state = getOrCreateState(context.channelId);
        // ...
    }

    return {
        handleMessage,
        setProcessor(newProcessor: MessageProcessor): void {
            processor = newProcessor;
        },
        stop(): void {
            channelStates.clear();
        },
    };
}
```

## Proposed Pattern

Convert to TypeScript classes with explicit visibility:

**StreamTracker as a class:**
```typescript
export class StreamTracker {
    private thinking = '';
    private text = '';
    private pendingToolUse: ToolUseBlock | null = null;
    private sessionId: string | undefined;

    update(message: AgentStreamEvent): void {
        if (message.type === 'assistant') {
            this.thinking = extractThinkingContent(message) ?? '';
            // ...
        }
    }

    getProgress(): StreamProgress {
        return {
            thinking: this.thinking,
            text: this.text,
            pendingToolUse: this.pendingToolUse,
            sessionId: this.sessionId,
        };
    }

    reset(): void {
        this.thinking = '';
        this.text = '';
        this.pendingToolUse = null;
        this.sessionId = undefined;
    }
}

// Keep factory for backward compatibility (optional)
export function createStreamTracker(): StreamTracker {
    return new StreamTracker();
}
```

**MessageCoordinator as a class:**
```typescript
export class MessageCoordinator {
    private readonly channelStates = new Map<ChannelId, ChannelState>();
    private processor: MessageProcessor | null = null;

    constructor(private readonly config?: MessageCoordinatorConfig) {}

    private get debounceMs(): number {
        return this.config?.debounceMs ?? 2000;
    }

    private get onResponse(): ((result: ProcessResult, msg: Message | null) => Promise<void>) | undefined {
        return this.config?.onResponse;
    }

    handleMessage(context: DiscordMessageContext, discordMessage: Message, channel?: TypingChannel): void {
        const state = this.getOrCreateState(context.channelId);
        // ...
    }

    setProcessor(processor: MessageProcessor): void {
        this.processor = processor;
    }

    stop(): void {
        this.channelStates.clear();
    }

    private getOrCreateState(channelId: ChannelId): ChannelState {
        let state = this.channelStates.get(channelId);
        if (!state) {
            state = { pendingMessages: [] };
            this.channelStates.set(channelId, state);
        }
        return state;
    }

    // ... other private methods
}

// Keep factory for backward compatibility (optional)
export function createMessageCoordinator(config?: MessageCoordinatorConfig): MessageCoordinator {
    return new MessageCoordinator(config);
}
```

## Audit of Factory Functions

Based on grep results, these modules use factory functions:

### High Priority (Complex State Management)

1. **src/integrations/discord/message-coordinator.ts**
   - `createMessageCoordinator()` - Complex state machine with timers, queues
   - High complexity: 400+ lines, multiple closures
   - **Impact:** High - central to message handling

2. **src/agent/stream-tracker.ts**
   - `createStreamTracker()` - Tracks agent stream progress
   - Medium complexity: 150 lines, simple state
   - **Impact:** Medium - used in every agent interaction

3. **src/integrations/discord/presence/manager.ts**
   - `createPresenceManager()` (if exists) - Manages Discord presence updates
   - Medium complexity: debouncing, rate limiting
   - **Impact:** Medium - visible user-facing behavior

4. **src/integrations/discord/state/manager.ts**
   - `createStateManager()` (if exists) - State machine for agent activity
   - High complexity: state transitions, context tracking
   - **Impact:** High - core state management

### Medium Priority (Simpler State)

5. **src/agent/event-delta-tracker.ts**
   - `createEventDeltaTracker()` - Tracks memory events between interruptions
   - Low complexity: simple array tracking
   - **Impact:** Low - helper utility

6. **src/integrations/discord/rate-limiter.ts**
   - `createRateLimiter()` - Rate limiting for Discord API
   - Medium complexity: token bucket algorithm
   - **Impact:** Medium - prevents rate limit errors

7. **src/agent/answer-classifier/classifier.ts**
   - `createAnswerClassifier()` - Classifies agent responses
   - Low complexity: stateless helper
   - **Impact:** Low - helper utility

8. **src/agent/question-registry/registry.ts**
   - `createQuestionRegistry()` - Tracks pending user questions
   - Medium complexity: Map-based state
   - **Impact:** Medium - user interaction flow

### Low Priority (Simple Utilities)

9. **src/agent/claude-retry.ts**
   - `createClaudeRetryWrapper()` (if exists) - Retry logic for Claude API
   - Low complexity: stateless wrapper
   - **Impact:** Low - infrastructure utility

10. **src/integrations/discord/client.ts**
    - `createDiscordClient()` - Discord.js client factory
    - Low complexity: simple configuration
    - **Impact:** Low - initialization only

11. **src/storage/client.ts**
    - `createDynamoDBClient()` - DynamoDB client factory
    - Low complexity: simple configuration
    - **Impact:** Low - initialization only

12. **src/agent/text-generator.ts**
    - `createTextGenerator()` (if exists) - LLM text generation
    - Low complexity: simple wrapper
    - **Impact:** Low - helper utility

### Consider Keeping as Factories

Some factory functions may be appropriate to keep:
- **Client factories** (Discord, DynamoDB) - these are initialization helpers, not stateful objects
- **Simple utility wrappers** - if they're truly stateless, closures are fine
- **Plugin loaders** - dynamic loading may benefit from factory pattern

## Priority Order for Conversion

1. **MessageCoordinator** - Highest complexity, central to message handling
2. **StateManager** - Core state machine, high visibility
3. **StreamTracker** - Used frequently, medium complexity
4. **PresenceManager** - User-facing, medium complexity
5. **QuestionRegistry** - User interaction flow
6. **RateLimiter** - Infrastructure, medium complexity
7. **EventDeltaTracker** - Simple helper, low priority
8. **AnswerClassifier** - Simple helper, low priority

Skip: Client factories and simple utilities can remain as functions.

## Changes Required

### For Each Factory Function

1. **Create class:**
   ```typescript
   export class ModuleName {
       private stateVar1: Type;
       private stateVar2: Type;

       constructor(config?: ModuleConfig) {
           // Initialize from config
       }

       // Public methods (same as factory return object)
       publicMethod(): void { }

       // Private helper functions become private methods
       private helperMethod(): void { }
   }
   ```

2. **Keep factory function for backward compatibility (optional):**
   ```typescript
   export function createModuleName(config?: ModuleConfig): ModuleName {
       return new ModuleName(config);
   }
   ```

3. **Update tests:**
   ```typescript
   // Before
   const tracker = createStreamTracker();

   // After (option 1 - use class directly)
   const tracker = new StreamTracker();

   // After (option 2 - keep factory)
   const tracker = createStreamTracker();
   ```

4. **Update call sites:**
   - Search for `createX()` calls
   - Replace with `new X()` or keep factory if provided
   - Update imports if needed

## Testing Strategy

### Unit Test Migration

For each factory function conversion:

1. **Run existing tests** - They should pass unchanged if factory function is kept
2. **Add class-based tests** - Test using `new ClassName()` directly
3. **Verify behavior** - Both factory and direct class instantiation should behave identically
4. **Remove factory** (optional) - Once all call sites updated, remove factory function

### Example Test Updates

**Before:**
```typescript
describe('StreamTracker', () => {
    it('should track stream progress', () => {
        const tracker = createStreamTracker();
        tracker.update(mockEvent);
        expect(tracker.getProgress()).toEqual(expectedProgress);
    });
});
```

**After (keeping factory):**
```typescript
describe('StreamTracker', () => {
    it('should track stream progress (factory)', () => {
        const tracker = createStreamTracker();
        tracker.update(mockEvent);
        expect(tracker.getProgress()).toEqual(expectedProgress);
    });

    it('should track stream progress (class)', () => {
        const tracker = new StreamTracker();
        tracker.update(mockEvent);
        expect(tracker.getProgress()).toEqual(expectedProgress);
    });
});
```

**After (factory removed):**
```typescript
describe('StreamTracker', () => {
    it('should track stream progress', () => {
        const tracker = new StreamTracker();
        tracker.update(mockEvent);
        expect(tracker.getProgress()).toEqual(expectedProgress);
    });
});
```

### Mutation Testing

- Verify that private methods are properly tested via public API
- Ensure mutation score remains 100%
- Private methods should be covered by tests of public methods that use them

## Benefits

### Better TypeScript Tooling
- IDE autocomplete works better with classes
- Go-to-definition navigates to class definition
- TypeScript can infer types more accurately
- Better refactoring support (rename, extract method)

### Explicit Visibility
- `private` methods are clearly marked
- `public` API is explicit in class definition
- No guessing about what's internal vs. external
- TypeScript enforces visibility at compile time

### Familiar Pattern
- Classes are idiomatic TypeScript
- Easier for new developers to understand
- Standard OOP patterns apply (inheritance, composition)
- Consistent with most TypeScript libraries

### Better Testing
- Can spy on private methods if needed
- Can extend class for test doubles
- Can use `instanceof` checks
- Easier to mock with TypeScript test frameworks

### Easier to Extend
- Can subclass for customization
- Can implement interfaces explicitly
- Can use decorators (future)
- Can use static methods and properties

## Migration Path

### Phase 1: High-Priority Factories
1. Convert `MessageCoordinator` to class
2. Keep factory function for backward compatibility
3. Update tests to use both factory and class
4. Run full test suite, verify 100% mutation score

### Phase 2: Core State Management
1. Convert `StateManager` to class
2. Convert `StreamTracker` to class
3. Same process: keep factories, test both paths

### Phase 3: Medium-Priority Factories
1. Convert `PresenceManager`, `QuestionRegistry`, `RateLimiter`
2. Same process: keep factories initially

### Phase 4: Remove Factories (Optional)
1. Update all call sites to use `new ClassName()`
2. Remove factory functions
3. Update documentation and examples

### Phase 5: Low-Priority Conversions
1. Convert remaining factories if needed
2. Leave client factories and simple utilities as-is

## Examples of Good Factory Functions to Keep

Not all factory functions should be converted. Keep these patterns:

### Client Initialization
```typescript
// Keep as factory - this is initialization logic
export function createDynamoDBClient(config: DynamoConfig): DynamoDBDocumentClient {
    const client = new DynamoDBClient(config);
    return DynamoDBDocumentClient.from(client);
}
```

### Plugin Loading
```typescript
// Keep as factory - dynamic loading benefits from function pattern
export function createMCPServer(pluginPath: string): MCPServer {
    const plugin = loadPlugin(pluginPath);
    return new MCPServer(plugin);
}
```

### Simple Stateless Wrappers
```typescript
// Could stay as factory - no complex state, just composition
export function createRetryWrapper<T>(fn: () => Promise<T>, config: RetryConfig) {
    return () => retryWithBackoff(fn, config);
}
```

## Priority

**Medium.** The current factory pattern works but isn't idiomatic TypeScript. Converting to classes will improve developer experience and tooling support, but doesn't fix any functional issues. Prioritize high-complexity factories first (MessageCoordinator, StateManager), and leave simple utilities as-is.

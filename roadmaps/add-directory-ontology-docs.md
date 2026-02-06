# Add Directory Ontology Documentation

## Problem Statement

The codebase has deep directory nesting (up to 3-4 levels in some areas) without documentation explaining what belongs where. This creates several problems:

**For AI Agents:**
- Cannot quickly understand where to find code for a given task
- Tendency to create duplicate code because existing code is hard to discover
- Uncertainty about where to place new code
- Must read many files to understand module boundaries

**For Human Developers:**
- Steep onboarding curve for new contributors
- Unclear architectural boundaries between modules
- Difficult to navigate without IDE assistance
- No quick reference for "where does X belong?"

**Current State:** No README files exist in subdirectories. The only documentation is in `.claude/CLAUDE.md`, which is project-wide and doesn't provide module-level guidance.

## Current Directory Structure

```
src/
├── agent/                          # Claude Agent SDK integration
│   ├── answer-classifier/          # Classify agent responses
│   ├── perch/                      # Autonomous perch time system
│   ├── prompts/                    # System prompts
│   └── question-registry/          # Question tracking
├── config/                         # Zod-validated configuration
├── integrations/                   # External service integrations
│   └── discord/                    # Discord bot integration
│       ├── attachments/            # Image/file attachment handling
│       ├── catchup/                # Catch-up mode logic
│       ├── channel-registry/       # Channel discovery and management
│       ├── inbox/                  # Message inbox management
│       ├── message-history/        # Historical message search
│       ├── presence/               # Discord presence/status system
│       └── state/                  # Bot state machine
├── storage/                        # Data persistence layer
│   ├── memory-tool/                # Memory tool backend (DynamoDB)
│   ├── models/                     # Entity definitions
│   ├── repositories/               # Data access layer
│   ├── task-session/               # Task persistence
│   └── utils/                      # Storage utilities
└── utils/                          # Shared utilities
    └── retry/                      # Retry logic with backoff
```

## README Template

Standard template for directory READMEs (markdown format):

```markdown
# [Directory Name]

## Purpose
[1-2 sentence summary: What this directory contains and why it exists]

## Contents

| Directory/File | Description |
|----------------|-------------|
| [name] | [Brief description] |
| [name] | [Brief description] |

## Where to Put New Code

[Guidelines for when to add code to this directory vs elsewhere]

**Add code here when:**
- [Criterion 1]
- [Criterion 2]

**Do NOT add code here when:**
- [Anti-pattern 1]
- [Anti-pattern 2]

## Key Patterns

[Important patterns or conventions used in this module]

## Related Documentation
- [Link to CLAUDE.md section]
- [Link to roadmap if applicable]
- [Link to parent README]
```

## Priority Order for Creation

Create READMEs top-down, starting with high-traffic directories:

### Phase 1: Top-Level Orientation (Week 1)

**Priority 1: `src/README.md`** (Critical - entry point for all navigation)
- Overview of entire source tree
- High-level architecture diagram
- Links to key subsystem READMEs
- Decision tree: "I want to work on X, where do I go?"

**Priority 2: `src/integrations/README.md`**
- Purpose of integrations layer
- Available integrations (currently: Discord)
- How to add a new integration
- Integration patterns and anti-patterns

**Priority 3: `src/integrations/discord/README.md`** (Most complex module)
- Discord bot architecture overview
- Subsystem breakdown (presence, state, inbox, etc.)
- Message flow diagram
- Event handling patterns
- Links to all submodule READMEs

### Phase 2: Core Subsystems (Week 2)

**Priority 4: `src/agent/README.md`**
- Claude Agent SDK integration architecture
- Agent configuration and context building
- MCP server setup
- Plugin system
- Perch mode and autonomous behavior

**Priority 5: `src/storage/README.md`**
- Storage architecture (DynamoDB)
- Memory tool backend
- Repository pattern
- Key patterns (branded types, retry logic)

**Priority 6: `src/config/README.md`**
- Configuration loading with Zod
- Environment variables
- SST resource integration

**Priority 7: `src/utils/README.md`**
- Shared utilities
- Retry logic
- Time utilities

### Phase 3: Discord Subsystems (Week 3)

**Priority 8: `src/integrations/discord/state/README.md`**
- Bot state machine
- State transitions
- Context builders (agent, status)
- State-dependent behavior

**Priority 9: `src/integrations/discord/presence/README.md`**
- Discord presence/status system
- Status generation (LLM vs static)
- Debouncing and rate limiting

**Priority 10: `src/integrations/discord/inbox/README.md`**
- Inbox management
- Message queuing
- Catch-up workflow

**Priority 11: `src/integrations/discord/message-history/README.md`**
- Historical message search
- Caching strategy
- Snowflake ID utilities

**Priority 12: `src/integrations/discord/channel-registry/README.md`**
- Channel discovery
- Mute/unmute management
- Channel resolution

**Priority 13: `src/integrations/discord/catchup/README.md`**
- Catch-up mode logic
- Inbox summarization
- Signal persistence

**Priority 14: `src/integrations/discord/attachments/README.md`**
- Image/file attachment handling
- Fetching and validation

### Phase 4: Storage Subsystems (Week 4)

**Priority 15: `src/storage/memory-tool/README.md`**
- Memory tool architecture
- Three-layer system (identity/state/events)
- DynamoDB key design
- Backend operations (CRUD, query, tags, versions)
- Handler implementations

**Priority 16: `src/storage/repositories/README.md`**
- Repository pattern
- Base repository
- Entity-specific repositories

**Priority 17: `src/storage/task-session/README.md`**
- Task persistence across sessions
- Task copying logic

**Priority 18: `src/storage/models/README.md`**
- Entity definitions
- Zod schemas

### Phase 5: Agent Subsystems (Week 5)

**Priority 19: `src/agent/prompts/README.md`**
- System prompt construction
- Event recording protocol
- Memory layer guidelines

**Priority 20: `src/agent/perch/README.md`**
- Autonomous perch time
- Time slot scheduling
- Interruption handling

**Priority 21: `src/agent/answer-classifier/README.md`**
- Response classification
- Answer detection

**Priority 22: `src/agent/question-registry/README.md`**
- Question tracking
- User question management

### Phase 6: Utility Subsystems (Week 6)

**Priority 23: `src/utils/retry/README.md`**
- Retry logic with exponential backoff
- Error classification
- Retry wrappers for async functions

## Maintenance Strategy

**When to Update READMEs:**
- When adding a new file/directory to a module
- When changing module responsibilities
- When adding new patterns or conventions
- During code reviews (verify README accuracy)

**Update Process:**
- Update README in the same PR that changes the code
- CI check: Verify Contents table matches actual files (future enhancement)
- Quarterly review: Check all READMEs for staleness

**Template Consistency:**
- All READMEs follow the same template structure
- Consistent heading levels and formatting
- Consistent "Where to Put New Code" format
- Consistent "Related Documentation" links

## Example README

**Example: `src/integrations/discord/state/README.md`**

```markdown
# Discord Bot State Management

## Purpose
Manages the Discord bot's operational state machine, including mode transitions (idle, processing, catching up, perching) and activity phase tracking (thinking, using tools, responding).

## Contents

| Directory/File | Description |
|----------------|-------------|
| `types.ts` | State types, mode definitions, activity phases |
| `manager.ts` | BotStateManager implementation |
| `transitions.ts` | State transition logic and validation |
| `agent-context-builder.ts` | Builds agent config based on current state |
| `status-context-builder.ts` | Builds status context for presence updates |

## Where to Put New Code

**Add code here when:**
- Adding a new bot mode (e.g., "monitoring", "searching")
- Adding a new activity phase (e.g., "planning", "evaluating")
- Changing state transition rules
- Adding mode-specific context for agent or status

**Do NOT add code here when:**
- Implementing actual agent logic (use `src/agent/`)
- Implementing presence/status generation (use `src/integrations/discord/presence/`)
- Implementing message handling (use `src/integrations/discord/handlers.ts`)
- Adding storage logic (use `src/storage/`)

## Key Patterns

**State Machine Pattern:**
- Immutable state updates via `setState()`
- Transition validation enforced by `transitions.ts`
- Mode-dependent behavior via context builders

**Context Builders:**
- `agent-context-builder.ts`: Determines MCP servers, tools, and prompts based on mode
- `status-context-builder.ts`: Provides context for status generation

**Activity Phases:**
- Tracked only during active modes (processing, catching up, perching)
- Cleared when returning to idle
- Used for dynamic status generation

## Related Documentation
- [CLAUDE.md - State/Status System](../../../.claude/CLAUDE.md#statestatus-system-overhaul-technical-debt)
- [Parent: Discord Integration](../README.md)
- [Related: Presence System](../presence/README.md)
```

## Benefits

**Faster Navigation:**
- AI agents can quickly find the right module
- Humans can orient themselves without reading code
- Clear decision trees for "where does X belong?"

**Better Code Organization:**
- Explicit guidelines prevent code in wrong places
- Anti-patterns documented to prevent mistakes
- Consistent patterns across similar modules

**Easier Onboarding:**
- New contributors can navigate the codebase independently
- README breadcrumbs provide context at every level
- Links connect related subsystems

**Reduced Duplication:**
- Easier to discover existing code before writing new code
- Clear module boundaries prevent overlap
- "Where to Put New Code" guidelines prevent confusion

## Success Criteria

- [ ] All directories with 3+ files have READMEs
- [ ] README template followed consistently
- [ ] Contents tables match actual directory contents
- [ ] "Where to Put New Code" guidelines are actionable
- [ ] All READMEs link to related documentation
- [ ] CI check verifies README/directory consistency (optional future enhancement)

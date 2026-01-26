export const COMPACTION_SUMMARY_PROMPT = `## Isambard-Specific Context

In addition to the standard summary sections above, include these Isambard-specific details:

### Memory Tool Usage
- List any memories created/updated via \`mcp__memory__*\` tools this session
- Note: These persist in DynamoDB and will be available after compaction via the memory MCP server
- Do NOT re-summarize stored memory content - just note what was stored and why

### Discord Context
- User identity (Discord user ID, any known preferences from memories)
- Channel context if relevant to the conversation
- Any Discord-specific constraints (message length limits, formatting)

### Relationship & Rapport
- User's tone and emotional state during this session
- Any commitments or promises made to the user
- Rapport-building context (inside jokes, shared references, user preferences)
- How the user prefers to communicate (formal/casual, detailed/brief)

### Session Continuity
- What the user will expect when the conversation continues
- Any context that would be confusing if lost (e.g., "we decided to call it X")
- Implicit understanding established during this session`;

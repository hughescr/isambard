/**
 * Prompt fragments that must read identically in the long-lived session prompt
 * (`./system-prompt.ts`) and the sub-agent prompt (`./subagent-prompt.ts`).
 *
 * A sub-agent is Isambard acting outward under Isambard's identity, so the rules that govern
 * how it spends the shared subscription, addresses Discord and finds durable memory have to be
 * the same rules the session itself runs under — one owner for the text, interpolated into both
 * builders, rather than two copies that drift. Deliberately NOT re-exported through
 * `./index.ts`: these are prompt internals, not part of the `@/agent` surface.
 *
 * @module agent/prompts/shared-sections
 */

/**
 * The `## Managing quota` section, heading included — rendered verbatim in both prompts.
 *
 * Carries no live numbers on purpose: the section sits inside the cached system-prompt prefix,
 * so a percentage baked in here would invalidate the prompt cache on every turn. The live
 * five-hour and weekly utilization stays in the per-turn time header, where it costs nothing.
 */
export const MANAGING_QUOTA_SECTION = `## Managing quota

Every sub-agent and workflow agent you launch draws on the shared subscription, and the model and effort you give it set the rate. Per token, Fable costs roughly twice Opus, and Opus roughly twice Sonnet; higher effort multiplies the tokens on top of that. Neither number matters on its own — what matters is the cost of finishing the task. A strong model that gets it right in one pass is often cheaper than a weak one that needs a retry, a verifier, or your own time fixing the result. It is a judgement call per task, not a rule.

Sub-agents: choose the effort by agent type — \`low\`, \`medium\`, \`high\`, \`xhigh\` — and pass \`model\` (\`sonnet\`, \`opus\`, \`fable\`) on the launch. The task goes in the prompt, and that prompt is the only instruction the sub-agent gets from you. \`low\` and \`medium\` cannot launch sub-agents or workflows of their own.

Workflows: set model and effort on every \`agent()\` call.

Rough tiers: Sonnet at medium for mechanical, bounded work with an objective check (formatting, summarising, a search, a small edit with tests); Opus at medium or high for ordinary substantive work, review and debugging; Fable only where judgement is the hard part, or after Opus has stalled. Never leave model or effort to default.

When a window is near full, prefer the lower tier and defer what can wait for the reset. When the windows are nearly empty, do not hoard: an unused window resets to nothing.`;

/**
 * The durable-memory rule, context-free so it reads the same to a session and to a sub-agent:
 * the DynamoDB layers outlive any one transcript. Each caller adds its own reason the rule
 * bites (a session is compacted; a sub-agent simply ends).
 */
export const DURABLE_MEMORY_RULE = 'Anything that must outlive this context — a finding, a decision, a fact about someone — has to be written to DynamoDB memory (the identity, state, user and event layers). Nothing else you hold is durable.';

/**
 * The Discord-tools rule: ids are always explicit, never inferred. Verbatim in both prompts;
 * each caller says separately where its own ids come from (the envelope, or the task).
 */
export const DISCORD_TOOLS_RULE = 'Discord tools take explicit `channelId` and user-id arguments — there is no ambient "current channel" or "current user" to fall back on. Never guess or invent either value.';

/** The `getServiceHealth` one-liner: which integrations are up, answerable even mid-outage. */
export const SERVICE_HEALTH_RULE = 'Call `getServiceHealth` any time to see which integrations (Discord, email, Bluesky, CalDAV, DynamoDB, etc) are currently online — it answers even during an outage.';

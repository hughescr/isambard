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

Choose the cheapest model and effort likely to finish correctly, including likely retries and review. Model and effort both affect capability and cost; there is no fixed multiplier that converts one provider's quota into another's.

For Claude-only launches, select an effort definition (\`low\`, \`medium\`, \`high\`, \`xhigh\`) and pass \`model\` (\`sonnet\`, \`opus\`, or \`fable\`). For an utraque route, select a named model-and-effort definition such as \`astra-high\`, \`luna-medium\`, \`terra-high\`, \`sol-high\`, \`deepseek-flash-low\`, \`deepseek-flash-high\`, or \`deepseek-pro-high\`, and OMIT the Agent \`model\` override: the SDK enum cannot express cross-provider IDs and would replace the definition's pinned model. Set model and effort explicitly on workflow \`agent()\` calls.

Low and medium definitions may not launch further agents or workflows. When quota affects a delegated task, include the relevant current provider reading in its launch prompt.

Use Luna or DeepSeek Flash for bounded work with an objective check. Use Terra or Sol for substantive implementation, research, and debugging. Use Astra or Fable for consequential judgement or a hard failure. DeepSeek Pro's name alone does not make it the better route; prefer observed task fit.

Claude's shared five-hour and weekly windows can each bind. Codex is a separate shared subscription: respect only the bucket scopes and reset times actually reported. DeepSeek is pay-as-you-go; its balance is money, and input, cached input, and output tokens debit a real but often tiny API cost. It can conserve scarce subscription headroom when it is capable. The per-turn \`Quota:\` JSON is keyed by provider: \`quota_lookup.status\` says whether the quota reading is known, \`observed_at\` dates provider quota values, \`quota_values\` identifies session-ledger fallback provenance and freshness, and \`resets_at\` dates a bucket reset. A quota API lookup failure does not establish whether inference is available or quota is exhausted.

Compare remaining capacity and time to reset with the reported recent pace. If a bucket is likely to run out first, choose another capable provider, lower effort or scope, or defer optional work. Use healthy subscription capacity rather than hoarding it in favour of paid API usage. Never sum quota buckets, infer your own spending from a shared jump, treat missing/expired data as free capacity, or treat benchmark/API-reference costs as quota weights. Do not spend reset credits or enable a top-up automatically.`;

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

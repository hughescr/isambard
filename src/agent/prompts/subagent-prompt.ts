/**
 * The system prompt every Isambard sub-agent runs under (see {@link buildSubagentSystemPrompt}).
 *
 * Isambard's sessions set `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and install no `SubagentStart`
 * hook, so a sub-agent's whole world is: the SDK harness text, its tool schemas, this prompt,
 * and the launch prompt the session wrote. Everything a sub-agent needs in order to act AS
 * Isambard — how to report, where durable memory lives, that Discord ids are never guessed, what
 * a launch costs, who the peers are, and who it is — has to be in here.
 *
 * What is deliberately NOT here: working memory and compaction, the envelope catalogue,
 * notifications/`TaskList`/rejected drafts, either role section, the ambient time header, and any
 * live number. A sub-agent has none of that machinery, and a live number would defeat prompt
 * caching for every launch.
 *
 * The rules a sub-agent shares with the session that launched it come from
 * `./shared-sections.ts`, interpolated verbatim, so the two prompts cannot drift.
 *
 * @module agent/prompts/subagent-prompt
 */
import { DISCORD_TOOLS_RULE, DURABLE_MEMORY_RULE, MANAGING_QUOTA_SECTION, SERVICE_HEALTH_RULE } from './shared-sections';

/** Opening: who launched this sub-agent, what it hands back, and whose identity it acts under. */
const OPENING_SECTION = `You are a sub-agent of Isambard. One of Isambard's own sessions launched you to do the task in your first message, and nobody is reading this transcript but you. Your final message is your report back to that session, which relays whatever a person should see; nothing else you write here reaches anyone. When you act outward — email, Bluesky, Discord, memory — you act as Isambard, in the identity below, not as a separate assistant with opinions of its own.`;

/** How to report: the final message is the whole deliverable. */
const REPORTING_SECTION = `## Reporting back

Your final message is the deliverable: a concise report of what you did and what you found, written for the session that launched you rather than for a person. Say what changed, what you learned, and what is still open, and cite anything specific enough to be checked. There is no need to write a summary file — the report is what gets read.`;

/** Durable memory: the shared rule, plus the reason it bites hardest for a sub-agent. */
const DURABLE_MEMORY_SECTION = `## Durable memory

${DURABLE_MEMORY_RULE} Your transcript ends when you do: a finding that only appears in your report may never be written down.`;

/** Discord ids: from the task, never guessed. */
const DISCORD_SECTION = `## Discord tools

Any channel or user you are meant to reach is named explicitly in the task you were given; if it is not there, say so in your report rather than picking one.

${DISCORD_TOOLS_RULE}`;

/** Service health, verbatim from the shared constant. */
const SERVICE_HEALTH_SECTION = `## Service health

${SERVICE_HEALTH_RULE}`;

/** The shared-subscription framing, in its sub-agent form: no time header to read it from. */
const SUBSCRIPTION_SECTION = `## Provider capacity is shared

Your launch uses the provider and model pinned by the launching session. Claude and Codex subscription buckets are shared with Craig's sessions and other Isambard work; DeepSeek debits a monetary API balance. Running longer or launching wider consumes that provider's capacity.`;

/** What the quota section cannot tell a sub-agent, and the bar for launching work of its own. */
const QUOTA_TAIL = 'You do not see the live provider snapshot. The parent passes the relevant reading when it affects your task; otherwise finish within the named route. Launch further work only when your tier permits it and the task clearly needs it.';

/** Peers: leave Craig's sessions alone, and report rather than message Isambard's own sessions. */
const PEERS_SECTION = `## Peer sessions

\`ListAgents\` lists every Claude Code session and agent running on this machine. Any entry whose name does not start with \`Izzy-\` is most likely one of Craig's own Claude Code sessions, working on his task rather than yours: leave it alone.

Do not message \`Izzy-main\` or \`Izzy-perch\` either — your report is the channel back to the session that launched you, and an unexpected message interrupts a turn that is not yours.`;

/** Inputs to {@link buildSubagentSystemPrompt}. */
export interface BuildSubagentSystemPromptOptions {
    /** The core identity text, already loaded (e.g. via `IdentityCache.get()`). */
    identity: string
}

/**
 * Builds the system prompt an Isambard sub-agent runs under: the report contract, the rules it
 * shares with the launching session, and the identity it acts as.
 *
 * The identity comes LAST on purpose — it is the section that changes least often, so keeping
 * everything above it byte-stable leaves the whole prefix cacheable across launches. Pure and
 * synchronous: the caller loads `identity` beforehand, and rebuilds this prompt when the
 * identity behind it changes.
 * @param options Pre-loaded identity text
 * @returns The sub-agent system prompt string
 */
export function buildSubagentSystemPrompt(options: BuildSubagentSystemPromptOptions): string {
    const { identity } = options;

    return [
        OPENING_SECTION,
        REPORTING_SECTION,
        DURABLE_MEMORY_SECTION,
        DISCORD_SECTION,
        SERVICE_HEALTH_SECTION,
        SUBSCRIPTION_SECTION,
        MANAGING_QUOTA_SECTION,
        QUOTA_TAIL,
        PEERS_SECTION,
        `## Identity\n${identity}`,
    ].join('\n\n');
}

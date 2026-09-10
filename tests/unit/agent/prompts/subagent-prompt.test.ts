/**
 * Contract tests for {@link buildSubagentSystemPrompt}: the system prompt every Isambard
 * sub-agent runs under.
 *
 * A sub-agent gets no CLAUDE.md, no SubagentStart hook and no boot bundle — this prompt, the
 * SDK harness text and the launch prompt are the whole of what it knows. So the tests assert
 * both halves of the contract: the rules it MUST carry (reporting, durable memory, Discord ids,
 * quota, peers, identity last), and the long-lived-session material it must NOT carry.
 */
import { describe, test, expect } from 'bun:test';
import { assertPromptHygiene } from '../../../helpers/prompt-hygiene';
import {
    DISCORD_TOOLS_RULE,
    DURABLE_MEMORY_RULE,
    MANAGING_QUOTA_SECTION,
    SERVICE_HEALTH_RULE
} from '@/agent/prompts/shared-sections';
import { buildSubagentSystemPrompt } from '@/agent/prompts/subagent-prompt';

const IDENTITY = 'I am Isambard, Craig\'s thought partner. IDENTITY-BODY';

describe.concurrent('subagent-prompt', () => {
    describe('buildSubagentSystemPrompt', () => {
        test('opens by naming the sub-agent relationship and the report contract', () => {
            const prompt = buildSubagentSystemPrompt({ identity: IDENTITY });

            expect(prompt.startsWith('You are a sub-agent of Isambard')).toBe(true);
            expect(prompt).toContain('first message');
            expect(prompt).toContain('final message is your report');
            expect(prompt).toContain('you act as Isambard');
        });

        test('renders its sections in order, with the identity last', () => {
            const prompt = buildSubagentSystemPrompt({ identity: IDENTITY });
            const headings = [...prompt.matchAll(/^## .*$/gm)].map(match => match[0]);

            expect(headings).toEqual([
                '## Reporting back',
                '## Durable memory',
                '## Discord tools',
                '## Service health',
                '## The subscription is shared',
                '## Managing quota',
                '## Peer sessions',
                '## Identity',
            ]);
            expect(prompt.trimEnd().endsWith('IDENTITY-BODY')).toBe(true);
            expect(prompt).toContain(`## Identity\n${IDENTITY}`);
        });

        test('reuses DURABLE_MEMORY_RULE verbatim, and adds the sub-agent-specific reason it matters', () => {
            const prompt = buildSubagentSystemPrompt({ identity: IDENTITY });

            expect(prompt).toContain(DURABLE_MEMORY_RULE);
            expect(prompt).toContain('a finding that only appears in your report may never be written down');
        });

        test('reuses DISCORD_TOOLS_RULE verbatim, and points at the task for the ids', () => {
            const prompt = buildSubagentSystemPrompt({ identity: IDENTITY });

            expect(prompt).toContain(DISCORD_TOOLS_RULE);
            expect(prompt).toContain('the task you were given');
        });

        test('reuses SERVICE_HEALTH_RULE verbatim', () => {
            expect(buildSubagentSystemPrompt({ identity: IDENTITY })).toContain(SERVICE_HEALTH_RULE);
        });

        test('reuses MANAGING_QUOTA_SECTION verbatim — the same rules the launching session runs under', () => {
            expect(buildSubagentSystemPrompt({ identity: IDENTITY })).toContain(MANAGING_QUOTA_SECTION);
        });

        test('says there is no live quota reading here, and that a launch of its own must be earned', () => {
            const prompt = buildSubagentSystemPrompt({ identity: IDENTITY });

            expect(prompt).toContain('You do not see a live quota reading');
            expect(prompt).toContain('states it in your prompt');
            expect(prompt).toContain('your tier allows it');
            expect(prompt).toContain('clearly needs parallel hands');
        });

        test('carries the peer rule in its sub-agent form: leave Craig\'s sessions alone, and report rather than message Izzy', () => {
            const prompt = buildSubagentSystemPrompt({ identity: IDENTITY });

            expect(prompt).toContain('`ListAgents`');
            expect(prompt).toContain('does not start with `Izzy-`');
            expect(prompt).toContain('Izzy-main');
            expect(prompt).toContain('Izzy-perch');
            expect(prompt).toContain('your report is the channel');
        });

        test('omits every long-lived-session-only section — a sub-agent has none of that machinery', () => {
            const prompt = buildSubagentSystemPrompt({ identity: IDENTITY });

            for(const absent of ['## Envelopes', '[PERCH', '[BOOT', '[NOTIFICATION', 'TaskList', 'compaction', '## This session', 'time header', 'getRejectedDrafts', 'working memory']) {
                expect(prompt).not.toContain(absent);
            }
        });

        test('carries no live utilization number', () => {
            expect(buildSubagentSystemPrompt({ identity: IDENTITY })).not.toContain('%');
        });

        test('renders the identity text exactly once', () => {
            const prompt = buildSubagentSystemPrompt({ identity: 'unique-identity-marker' });

            expect(prompt.split('unique-identity-marker')).toHaveLength(2);
        });

        test('passes prompt hygiene, and separates every section with a blank line', () => {
            const prompt = buildSubagentSystemPrompt({ identity: IDENTITY });

            assertPromptHygiene(prompt);
            for(const heading of ['## Reporting back', '## Durable memory', '## Peer sessions', '## Identity']) {
                expect(prompt).toContain(`\n\n${heading}`);
            }
        });
    });
});

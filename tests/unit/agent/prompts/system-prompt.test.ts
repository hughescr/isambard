import { describe, test, expect } from 'bun:test';
import { DISCORD_TOOLS_RULE, DURABLE_MEMORY_RULE, MANAGING_QUOTA_SECTION, SERVICE_HEALTH_RULE } from '../../../../src/agent/prompts/shared-sections';
import {
    buildSessionSystemPrompt,
    buildPeerPrompt,
    SESSION_BASE_PROMPT,
    CONVERSATION_ROLE_PROMPT,
    PERCH_ROLE_PROMPT
} from '../../../../src/agent/prompts/system-prompt';
import { SESSION_PEER_NAMES } from '../../../../src/agent/session/query-options';
import { assertPromptHygiene } from '../../../helpers/prompt-hygiene';

describe.concurrent('system-prompt', () => {
    describe('buildSessionSystemPrompt', () => {
        test('conversation role contains "shared transcript" and the identity text', () => {
            const prompt = buildSessionSystemPrompt({ role: 'conversation', identity: 'I am Isambard, Craig\'s thought partner.' });

            expect(prompt).toContain('shared transcript');
            expect(prompt).toContain('I am Isambard, Craig\'s thought partner.');
            assertPromptHygiene(prompt);
        });

        test('perch role contains "time box" and "perch channel"', () => {
            const prompt = buildSessionSystemPrompt({ role: 'perch', identity: 'I am Isambard.' });

            expect(prompt).toContain('time box');
            expect(prompt).toContain('perch channel');
            assertPromptHygiene(prompt);
        });

        test('both roles contain working memory, envelope and notification language', () => {
            const conversation = buildSessionSystemPrompt({ role: 'conversation', identity: 'id' });
            const perch = buildSessionSystemPrompt({ role: 'perch', identity: 'id' });

            for(const prompt of [conversation, perch]) {
                expect(prompt).toContain('working memory');
                expect(prompt).toContain('envelope');
                expect(prompt).toContain('notification');
            }
        });

        test('neither role mentions ephemeral, {CHANNEL_LIST}, or the one-shot channel-visibility line', () => {
            const conversation = buildSessionSystemPrompt({ role: 'conversation', identity: 'id' });
            const perch = buildSessionSystemPrompt({ role: 'perch', identity: 'id' });

            for(const prompt of [conversation, perch]) {
                expect(prompt).not.toContain('ephemeral');
                expect(prompt).not.toContain('{CHANNEL_LIST}');
                expect(prompt).not.toContain('Currently visible channels');
                expect(prompt).not.toContain('[About this user]');
                expect(prompt).not.toContain('[Recent events]');
            }
        });

        test('appends the identity text once under "## Identity", after the role section', () => {
            const prompt = buildSessionSystemPrompt({ role: 'conversation', identity: 'unique-identity-marker' });

            expect(prompt).toContain('## Identity\nunique-identity-marker');
            const identityIndex = prompt.indexOf('## Identity');
            const roleIndex = prompt.indexOf(CONVERSATION_ROLE_PROMPT);
            expect(roleIndex).toBeGreaterThan(-1);
            expect(identityIndex).toBeGreaterThan(roleIndex);
            expect(prompt.split('unique-identity-marker')).toHaveLength(2);
        });

        test('conversation role tells Izzy getRejectedDrafts is available on demand without waiting for a perch turn; perch does not have email tools and is not told about it', () => {
            const conversation = buildSessionSystemPrompt({ role: 'conversation', identity: 'id' });
            const perch = buildSessionSystemPrompt({ role: 'perch', identity: 'id' });

            expect(conversation).toContain('getRejectedDrafts');
            expect(conversation).toContain('admin-rejected');
            expect(conversation).toContain('gave-up');
            expect(conversation).toContain('perch turn');
            assertPromptHygiene(conversation);

            // The perch conductor attaches no email MCP server (see src/app/sessions.ts,
            // createPerchConductor), so perch must never be told to call an unreachable tool.
            expect(perch).not.toContain('getRejectedDrafts');
            assertPromptHygiene(perch);
        });

        test('both roles are told getServiceHealth reports which integrations are online', () => {
            const conversation = buildSessionSystemPrompt({ role: 'conversation', identity: 'id' });
            const perch = buildSessionSystemPrompt({ role: 'perch', identity: 'id' });

            for(const prompt of [conversation, perch]) {
                expect(prompt).toContain('getServiceHealth');
                assertPromptHygiene(prompt);
            }
        });

        test('SESSION_BASE_PROMPT catalogues every envelope kind a host can send, and tells Izzy a [BOOT] handshake needs no reply', () => {
            // Regression: the first perch soak (2026-09-06) had Izzy treat its own `[BOOT]` handshake
            // as a "data point" worth recording, because the prompt named no envelope kinds at all.
            for(const kind of ['[DISCORD', '[PERCH', '[WRAP-UP', '[NOTIFICATION', '[CATCH-UP', '[BOOT', '[RESUME NOTE]']) {
                expect(SESSION_BASE_PROMPT).toContain(kind);
            }
            expect(SESSION_BASE_PROMPT).toMatch(/\[BOOT[^\n]*(no reply|nothing to do|not a request)/i);
        });

        test('the boot-bundle catalogue line no longer promises identity in the bundle body — WP4a moved identity into the system prompt itself', () => {
            const catalogueLine = SESSION_BASE_PROMPT.split('\n').find(line => line.includes('[BOOT BUNDLE'));

            expect(catalogueLine).toBeDefined();
            expect(catalogueLine).toContain('re-seeds your working memory');
            expect(catalogueLine).not.toContain('identity');
        });

        test('PERCH_ROLE_PROMPT carries the perch exploration philosophy the one-shot perch prompt used to send every slot, plus the suggestion-level legend', () => {
            // Regression: the first conductor-mode perch turns ended with "light touch, ending here" —
            // the slot envelope carries only the slot name, hint, level number and context, and the
            // role prompt had none of BASE_PROMPT's exploration mandate.
            for(const marker of ['Exploration, not output', 'Good activities', 'Minimum action floor', 'Stall recovery', 'TaskList', 'Suggestion level', '3 of 3', '1 of 3']) {
                expect(PERCH_ROLE_PROMPT).toContain(marker);
            }
            expect(PERCH_ROLE_PROMPT).not.toContain('Sessions are ephemeral');
            assertPromptHygiene(PERCH_ROLE_PROMPT);
        });

        test('SESSION_BASE_PROMPT tells Izzy a background-work wake turn delivers like a normal reply, not the old "its own envelope" framing', () => {
            // R2: a finished background task now wakes the conductor into a real turn whose
            // ordinary final text is delivered to the launching channel/author, rather than
            // arriving as a separate notification envelope.
            expect(SESSION_BASE_PROMPT).toContain('When it finishes, the host wakes you with its result in a new turn; whatever you write in that turn is delivered to the channel and person the work was launched for, exactly like a normal reply — so report as you would to them, or write nothing if there is nothing worth saying.');
            expect(SESSION_BASE_PROMPT).not.toContain('its result arrives as its own envelope, a notification, rather than as a continuation of the turn that launched it.');
        });

        test.each([
            ['conversation', 'Izzy-main', 'Izzy-perch'],
            ['perch', 'Izzy-perch', 'Izzy-main'],
        ] as const)('role=%s names itself %s and its peer %s, and says SendMessage to the peer arrives as a [PEER ...] envelope', (role, self, other) => {
            const prompt = buildSessionSystemPrompt({ role, identity: 'id' });

            expect(prompt).toContain(`You are running as \`${self}\``);
            expect(prompt).toContain(`\`SendMessage\` to \`${other}\``);
            expect(prompt).toContain(`[PEER · ${self} · `);
            assertPromptHygiene(prompt);
        });

        test('the names in the prompt are the same names query-options gives the SDK, not a second hard-coded copy', () => {
            for(const role of ['conversation', 'perch'] as const) {
                expect(buildPeerPrompt(role)).toContain(SESSION_PEER_NAMES[role]);
            }
            expect(buildPeerPrompt('conversation')).toContain(SESSION_PEER_NAMES.perch);
            expect(buildPeerPrompt('perch')).toContain(SESSION_PEER_NAMES.conversation);
        });

        test('both roles carry the "no Izzy- prefix means it is probably Craig\'s own session" rule, with the caveat that messaging one can confuse its work', () => {
            for(const role of ['conversation', 'perch'] as const) {
                const prompt = buildSessionSystemPrompt({ role, identity: 'id' });
                expect(prompt).toContain('does not start with `Izzy-`');
                expect(prompt).toContain('Craig\'s own Claude Code sessions');
                expect(prompt).toContain('confuse that agent\'s own work');
                assertPromptHygiene(prompt);
            }
        });

        test('both roles carry the shared-subscription quota reminder: utilization can move without Izzy doing anything', () => {
            // Block 5's text, owned by block 1: a jump in utilization is not evidence of Izzy's own spend.
            for(const role of ['conversation', 'perch'] as const) {
                const prompt = buildSessionSystemPrompt({ role, identity: 'id' });
                expect(prompt).toContain('shared');
                expect(prompt).toContain('not evidence of your own spending');
                assertPromptHygiene(prompt);
            }
            expect(SESSION_BASE_PROMPT).toContain('utraque reading for each active provider');
        });

        test('renders MANAGING_QUOTA_SECTION verbatim, in both roles, rather than a second copy of the same advice', () => {
            for(const role of ['conversation', 'perch'] as const) {
                expect(buildSessionSystemPrompt({ role, identity: 'id' })).toContain(MANAGING_QUOTA_SECTION);
            }
            expect(SESSION_BASE_PROMPT).toContain(MANAGING_QUOTA_SECTION);
        });

        test('"## Managing quota" follows "## Provider capacity is shared" directly, with no section between them', () => {
            const sharedIndex = SESSION_BASE_PROMPT.indexOf('## Provider capacity is shared');
            const quotaIndex = SESSION_BASE_PROMPT.indexOf('## Managing quota');

            expect(sharedIndex).toBeGreaterThan(-1);
            expect(quotaIndex).toBeGreaterThan(sharedIndex);
            expect(SESSION_BASE_PROMPT.slice(sharedIndex + '## Provider capacity is shared'.length, quotaIndex)).not.toContain('\n## ');
        });

        test('the identity text still comes last, after the quota section', () => {
            const prompt = buildSessionSystemPrompt({ role: 'conversation', identity: 'unique-identity-marker' });

            expect(prompt.indexOf('## Identity')).toBeGreaterThan(prompt.indexOf('## Managing quota'));
            expect(prompt.trimEnd().endsWith('unique-identity-marker')).toBe(true);
        });

        test('renders the durable-memory, Discord-tools and service-health fragments from the same shared constants the sub-agent prompt uses', () => {
            for(const role of ['conversation', 'perch'] as const) {
                const prompt = buildSessionSystemPrompt({ role, identity: 'id' });
                expect(prompt).toContain(DURABLE_MEMORY_RULE);
                expect(prompt).toContain(DISCORD_TOOLS_RULE);
                expect(prompt).toContain(SERVICE_HEALTH_RULE);
            }
        });

        test('the peer section is appended after the role section and before the identity text', () => {
            const prompt = buildSessionSystemPrompt({ role: 'perch', identity: 'unique-identity-marker' });
            const roleIndex = prompt.indexOf(PERCH_ROLE_PROMPT);
            const peerIndex = prompt.indexOf(buildPeerPrompt('perch'));
            const identityIndex = prompt.indexOf('## Identity');

            expect(roleIndex).toBeGreaterThan(-1);
            expect(peerIndex).toBeGreaterThan(roleIndex);
            expect(identityIndex).toBeGreaterThan(peerIndex);
            // A blank line between every section — without it the markdown headings run into
            // the previous section's last sentence.
            expect(prompt).toContain(`${PERCH_ROLE_PROMPT}\n\n${buildPeerPrompt('perch')}\n\n## Identity`);
            expect(prompt).toContain(`${SESSION_BASE_PROMPT}\n\n${PERCH_ROLE_PROMPT}`);
        });

        test('SESSION_BASE_PROMPT catalogues the [PEER ...] envelope kind alongside the others', () => {
            expect(SESSION_BASE_PROMPT).toContain('[PEER ·');
        });

        test('buildPeerPrompt passes hygiene on its own for both roles', () => {
            for(const role of ['conversation', 'perch'] as const) {
                expect(buildPeerPrompt(role).length).toBeGreaterThan(0);
                assertPromptHygiene(buildPeerPrompt(role));
            }
        });

        test('SESSION_BASE_PROMPT, CONVERSATION_ROLE_PROMPT and PERCH_ROLE_PROMPT are non-empty and pass hygiene on their own', () => {
            expect(SESSION_BASE_PROMPT.length).toBeGreaterThan(0);
            expect(CONVERSATION_ROLE_PROMPT.length).toBeGreaterThan(0);
            expect(PERCH_ROLE_PROMPT.length).toBeGreaterThan(0);
            assertPromptHygiene(SESSION_BASE_PROMPT);
            assertPromptHygiene(CONVERSATION_ROLE_PROMPT);
            assertPromptHygiene(PERCH_ROLE_PROMPT);
        });
    });
});

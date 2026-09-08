import { describe, test, expect } from 'bun:test';
import {
    buildSessionSystemPrompt,
    SESSION_BASE_PROMPT,
    CONVERSATION_ROLE_PROMPT,
    PERCH_ROLE_PROMPT
} from '../../../../src/agent/prompts/system-prompt';

/**
 * Test-local prompt-hygiene check shared by every `buildSessionSystemPrompt` case: no
 * unresolved `{PLACEHOLDER}` tokens, no trailing whitespace on any line, and no duplicated
 * (back-to-back) blank lines.
 */
function assertPromptHygiene(text: string): void {
    expect(text).not.toMatch(/\{[A-Z_]+\}/);
    for(const line of text.split('\n')) {
        expect(line).not.toMatch(/\s$/);
    }
    expect(text).not.toContain('\n\n\n');
}

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

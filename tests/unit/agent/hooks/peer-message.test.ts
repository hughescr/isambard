/**
 * Behavioural tests for {@link createPeerMessageHooks} (session-peers block 2).
 *
 * The wrapper shape asserted here is the block-0 probe's verbatim capture (P2, 2026-09-09) of
 * the `UserPromptSubmit` payload the SDK delivers when another Claude Code process on this
 * machine sends a `SendMessage`. `source` was absent on every observed payload, so the parser
 * keys on the `<cross-session-message` prefix and on nothing else.
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { HookCallback, UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createPeerMessageHooks, parsePeerMessage, type CreatePeerMessageHooksParams } from '@/agent/hooks/peer-message';
import type { Envelope } from '@/agent/session';

const BASE_HOOK_FIELDS = {
    session_id:      'sess-1',
    transcript_path: '/tmp/transcript',
    cwd:             '/tmp',
};

/** The probe's verbatim P2 capture, newlines and all. */
const PROBE_PROMPT = '<cross-session-message from="uds:/tmp/cc-socks/94548.sock" from-name="Izzy-probe-A" from-mode="bypass">\nMIDTURN-PING-CHARLIE-3\n</cross-session-message>';

const TIME_HEADER = '## Current Time\n- Izzy: 2026-09-09T14:02:00 America/Los_Angeles (Wednesday afternoon)';

const makeSignal = (): AbortSignal => new AbortController().signal;

function userPromptSubmitInput(overrides: Partial<UserPromptSubmitHookInput> = {}): UserPromptSubmitHookInput {
    return {
        ...BASE_HOOK_FIELDS,
        hook_event_name: 'UserPromptSubmit',
        prompt:          PROBE_PROMPT,
        ...overrides,
    };
}

interface Harness {
    hooks:         ReturnType<typeof createPeerMessageHooks>
    adoptPeerTurn: ReturnType<typeof jest.fn>
    timeHeader:    ReturnType<typeof jest.fn>
    logger:        { warn: ReturnType<typeof jest.fn> }
    clock:         { now: ReturnType<typeof jest.fn> }
}

function build(overrides: Partial<CreatePeerMessageHooksParams> = {}): Harness {
    const adoptPeerTurn = jest.fn();
    const timeHeader = jest.fn(() => TIME_HEADER);
    const logger = { warn: jest.fn() };
    const clock = { now: jest.fn(() => Date.parse('2026-09-09T22:02:00Z')) };

    return {
        hooks: createPeerMessageHooks({
            conductor: { adoptPeerTurn }, timezone: 'America/Los_Angeles', timeHeader, clock, logger, ...overrides,
        }),
        adoptPeerTurn,
        timeHeader,
        logger,
        clock,
    };
}

function getHook(hooks: ReturnType<typeof createPeerMessageHooks>): HookCallback {
    const callback = hooks.UserPromptSubmit?.[0]?.hooks[0];
    if(!callback) {
        throw new Error('No UserPromptSubmit hook found');
    }
    return callback;
}

/** Runs the hook and asserts the invariant every call holds: the turn is never blocked. */
async function run(h: Harness, input: UserPromptSubmitHookInput = userPromptSubmitInput()): Promise<void> {
    const result = await getHook(h.hooks)(input, undefined, { signal: makeSignal() });

    expect(result).toEqual({ 'continue': true });
}

/** The single envelope `adoptPeerTurn` was called with. */
function adopted(h: Harness): Envelope {
    expect(h.adoptPeerTurn).toHaveBeenCalledTimes(1);
    return h.adoptPeerTurn.mock.calls[0][0] as Envelope;
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('parsePeerMessage', () => {
    it('parses the probe\'s verbatim cross-session wrapper into its reply address, peer name and body', () => {
        expect(parsePeerMessage(PROBE_PROMPT)).toEqual({
            from: 'uds:/tmp/cc-socks/94548.sock', fromName: 'Izzy-probe-A', text: 'MIDTURN-PING-CHARLIE-3',
        });
    });

    it('preserves a multi-line body verbatim, trimming only the newlines the wrapper itself adds', () => {
        const parsed = parsePeerMessage('<cross-session-message from="uds:/a.sock" from-name="Izzy-main" from-mode="bypass">\nline one\n\nline three\n</cross-session-message>');

        expect(parsed?.text).toBe('line one\n\nline three');
    });

    it('omits the fromName KEY entirely when the tag carries no from-name attribute — not a present-but-undefined one, which would render "undefined" as the peer\'s name', () => {
        const parsed = parsePeerMessage('<cross-session-message from="uds:/a.sock" from-mode="bypass">\nhi\n</cross-session-message>');

        expect(parsed).toEqual({ from: 'uds:/a.sock', text: 'hi' });
        expect(parsed).not.toHaveProperty('fromName');
    });

    it('omits the fromName key when the from-name attribute is present but empty', () => {
        const parsed = parsePeerMessage('<cross-session-message from="uds:/a.sock" from-name="" from-mode="bypass">\nhi\n</cross-session-message>');

        expect(parsed).toEqual({ from: 'uds:/a.sock', text: 'hi' });
        expect(parsed).not.toHaveProperty('fromName');
    });

    it('requires the wrapper at the START of the prompt: a human quoting the tag mid-message is not a peer message (an unanchored match would also mis-slice the body)', () => {
        expect(parsePeerMessage('look at what it sent me: <cross-session-message from="uds:/a.sock" from-name="Izzy-main">\nhi\n</cross-session-message>')).toBeUndefined();
    });

    it('returns undefined for a prompt that is not a cross-session message at all', () => {
        expect(parsePeerMessage('what did you make of that PR?')).toBeUndefined();
    });

    it('returns undefined for the OTHER wrapper the SDK wakes this session with — a task notification is adoptWakeTurn\'s, not this hook\'s', () => {
        expect(parsePeerMessage('<task-notification>\n<task-id>agent-X</task-id>\n<tool-use-id>tool-T</tool-use-id>\n</task-notification>')).toBeUndefined();
    });

    it('returns undefined when the wrapper carries no from attribute — `from` is the reply address, so a message without one cannot be answered', () => {
        expect(parsePeerMessage('<cross-session-message from-name="Izzy-main" from-mode="bypass">\nhi\n</cross-session-message>')).toBeUndefined();
    });

    it('returns undefined when the from attribute is present but empty', () => {
        expect(parsePeerMessage('<cross-session-message from="" from-name="Izzy-main">\nhi\n</cross-session-message>')).toBeUndefined();
    });

    it('does not mistake the from-name or from-mode attribute for the from attribute', () => {
        expect(parsePeerMessage('<cross-session-message from-mode="bypass" from-name="Izzy-main" from="uds:/a.sock">\nhi\n</cross-session-message>')).toEqual({
            from: 'uds:/a.sock', fromName: 'Izzy-main', text: 'hi',
        });
    });

    it('tolerates a truncated wrapper with no closing tag, taking the whole remainder as the body', () => {
        expect(parsePeerMessage('<cross-session-message from="uds:/a.sock">\ncut off mid')).toEqual({ from: 'uds:/a.sock', text: 'cut off mid' });
    });

    it('keeps the body when it contains the literal closing tag text, splitting on the LAST occurrence', () => {
        const parsed = parsePeerMessage('<cross-session-message from="uds:/a.sock">\nquoting </cross-session-message> inline\n</cross-session-message>');

        expect(parsed?.text).toBe('quoting </cross-session-message> inline');
    });
});

describe('createPeerMessageHooks', () => {
    it('registers exactly one UserPromptSubmit hook and nothing on any other event', () => {
        const h = build();

        expect(Object.keys(h.hooks)).toEqual(['UserPromptSubmit']);
        expect(h.hooks.UserPromptSubmit?.[0]?.hooks).toHaveLength(1);
    });

    it('adopts a peer turn carrying the rendered envelope: header, time header, the peer\'s text and the reply instruction', async () => {
        const h = build();

        await run(h);

        const envelope = adopted(h);
        expect(envelope.kind).toBe('peer');
        expect(envelope.peer).toEqual({ from: 'uds:/tmp/cc-socks/94548.sock', fromName: 'Izzy-probe-A' });
        expect(envelope.text).toBe(`[PEER · Izzy-probe-A · 2026-09-09 14:02 PT]\n\n${TIME_HEADER}\n\nMIDTURN-PING-CHARLIE-3\n\nReply with SendMessage to Izzy-probe-A.`);
    });

    it('stamps the envelope from the injected clock, never the wall clock', async () => {
        const h = build();
        h.clock.now.mockReturnValue(Date.parse('2026-09-09T23:30:00Z'));

        await run(h);

        expect(adopted(h).createdAt).toEqual(new Date('2026-09-09T23:30:00Z'));
        expect(h.clock.now).toHaveBeenCalled();
    });

    it('calls timeHeader() fresh on every message rather than capturing one at build time', async () => {
        const h = build();
        h.timeHeader.mockReturnValueOnce('## first').mockReturnValueOnce('## second');

        await run(h);
        await run(h);

        expect(h.timeHeader).toHaveBeenCalledTimes(2);
        expect((h.adoptPeerTurn.mock.calls[0][0] as Envelope).text).toContain('## first');
        expect((h.adoptPeerTurn.mock.calls[1][0] as Envelope).text).toContain('## second');
    });

    it('leaves an ordinary human prompt entirely alone', async () => {
        const h = build();

        await run(h, userPromptSubmitInput({ prompt: 'what did you make of that PR?' }));

        expect(h.adoptPeerTurn).not.toHaveBeenCalled();
        expect(h.timeHeader).not.toHaveBeenCalled();
        expect(h.logger.warn).not.toHaveBeenCalled();
    });

    it('swallows and logs a conductor failure rather than blocking the peer\'s turn', async () => {
        const h = build();
        h.adoptPeerTurn.mockImplementation(() => {
            throw new Error('conductor exploded');
        });

        await run(h);

        expect(h.logger.warn).toHaveBeenCalledWith({ error: expect.any(Error) }, 'peer-message UserPromptSubmit hook failed');
    });

    it('logs nothing on the ordinary success path — a warn means the hook swallowed a crash rather than deciding', async () => {
        const h = build();

        await run(h);

        expect(h.logger.warn).not.toHaveBeenCalled();
    });
});

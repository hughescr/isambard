/**
 * Peer-message hook (session-peers block 2, `docs/plans/session-peers-and-quota.md`).
 *
 * Every Claude Code process on this machine registers in one shared peer registry; a
 * `SendMessage` from another process is delivered to this session as a plain user prompt wrapped
 * in a `<cross-session-message>` tag. The block-0 probe (P2, 2026-09-09) captured that wrapper
 * verbatim:
 *
 * ```text
 * <cross-session-message from="uds:/tmp/cc-socks/94548.sock" from-name="Izzy-probe-A" from-mode="bypass">
 * MIDTURN-PING-CHARLIE-3
 * </cross-session-message>
 * ```
 *
 * `from` is the reply address (a `SendMessage` addressed to the raw `uds:` path succeeded in the
 * probe); `from-name` is the peer-registry name; `from-mode` is the SENDER's permission-mode
 * class and is deliberately ignored here. The payload carried no `source` field on any observed
 * prompt — peer messages and human prompts alike — so this parser keys on the tag prefix and on
 * nothing else.
 *
 * This `UserPromptSubmit` hook only RECORDS: it renders the host-side envelope
 * ({@link import('../session').buildPeerEnvelope}) and hands it to
 * {@link import('../session').Conductor.adoptPeerTurn}, which adopts the turn the SDK has
 * already started from the raw prompt. It never rewrites or blocks the prompt. A successfully
 * adopted peer turn also returns SDK-visible routing context; malformed prompts and failures
 * return only `{ continue: true }`, exactly like {@link import('./task-launch').createTaskLaunchHooks}.
 *
 * Known gap, deliberate (probe P3): a peer message that arrives while this session is already
 * mid-turn is folded into the running turn and fires NO `UserPromptSubmit` hook at all, so it
 * reaches neither this module nor the ledger. See `Conductor.adoptPeerTurn`'s own doc for why
 * that case is not reconstructed from the SDK's undeclared `command_lifecycle` frame.
 *
 * @module agent/hooks/peer-message
 */
import type { HookCallbackMatcher, HookEvent, HookJSONOutput, UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@hughescr/logger';
import { buildPeerEnvelope, type Clock, type Conductor } from '@/agent/session';

/**
 * The wrapper's opening tag plus its attribute list. The `^` anchor is load-bearing twice over:
 * a human quoting the tag mid-message must not be mistaken for a peer message, and the body is
 * taken as `prompt.slice(match[0].length)`, which is only the text after the tag when the match
 * starts at index 0.
 */
const OPEN_TAG_PATTERN = /^<cross-session-message\s([^>]*)>/;

/** The reply address attribute. `from-name`/`from-mode` cannot match: the `="` follows `from` immediately. */
const FROM_PATTERN = /\bfrom="([^"]*)"/;

/** The peer-registry name attribute. */
const FROM_NAME_PATTERN = /\bfrom-name="([^"]*)"/;

/** Closes the wrapper. Matched from the END of the body so a peer quoting this literal text keeps it. */
const CLOSE_TAG = '</cross-session-message>';

/**
 * Builds the routing fact the SDK actually shows to the model on an idle peer turn. The rendered
 * `[PEER ...]` envelope is host-only ledger/journal state; without this hook output the model sees
 * only the raw cross-session wrapper and can easily mistake its final text for an automatically
 * delivered reply.
 */
function buildPeerRoutingContext(parsed: { from: string, fromName?: string }): string {
    const name = parsed.fromName ?? parsed.from;
    return `This is an idle peer turn from ${name}; your final text is delivered nowhere. If a peer reply is needed, use SendMessage to="${parsed.from}"; do not acknowledge messages that need no response. Preserve any Discord channelId, requestingUserId/authorId, and messageId(s) in your peer reply. Carrying origin alone creates no duty to contact the user. If this result completes a Discord follow-up you already owe or promised, or the peer explicitly asks you to deliver one, call sendDiscordMessage with the exact channelId and requestingUserId/authorId; use replyToMessageId when a messageId is supplied. If channelId or user id is missing, ask the peer. Never substitute #general, a recent channel, or a guessed id.`;
}

/** Dependencies for {@link createPeerMessageHooks}. */
export interface CreatePeerMessageHooksParams {
    /** Only `adoptPeerTurn` is ever called — this hook records a turn the SDK has already started; it never submits. */
    conductor:  Pick<Conductor, 'adoptPeerTurn'>
    /** IANA timezone the envelope's stamp is rendered in (e.g. `config.session.timezone`). */
    timezone:   string
    /** `() => string`, called fresh per peer message — matching every other envelope call site, none of which precompute the header. */
    timeHeader: () => string
    /** Sources the envelope's `createdAt`/stamp, like every other session-subsystem timestamp — never the wall clock. */
    clock:      Pick<Clock, 'now'>
    /** Only `warn` is ever called — a malformed prompt or a throwing conductor degrades to a logged no-op. */
    logger:     Pick<Logger, 'warn'>
}

/**
 * Parses a `UserPromptSubmit` `prompt` for the SDK's `<cross-session-message>` wrapper (probe
 * P2, 2026-09-09).
 * @param prompt The `UserPromptSubmit` hook input's `prompt`
 * @returns `{ from, fromName?, text }`, or `undefined` when `prompt` is not a peer message or carries no `from` reply address
 */
export function parsePeerMessage(prompt: string): { from: string, fromName?: string, text: string } | undefined {
    const openTag = OPEN_TAG_PATTERN.exec(prompt);
    if(openTag === null) {
        return undefined;
    }
    const wholeTag = openTag[0];
    // OPEN_TAG_PATTERN has one mandatory capture, so a successful exec always supplies index 1.
    const attributes = openTag[1]!;
    const from = FROM_PATTERN.exec(attributes)?.[1];
    if(from === undefined || from === '') {
        return undefined;
    }
    const body = prompt.slice(wholeTag.length);
    const closeIndex = body.lastIndexOf(CLOSE_TAG);
    const text = (closeIndex === -1 ? body : body.slice(0, closeIndex)).trim();
    const fromName = FROM_NAME_PATTERN.exec(attributes)?.[1];

    return { from, ...(fromName === undefined || fromName === '' ? {} : { fromName }), text };
}

/**
 * Creates the `UserPromptSubmit` hook matcher that turns an inbound peer message into an adopted
 * `peer`-kind turn.
 * @param params See {@link CreatePeerMessageHooksParams}.
 * @returns A partial hook map with a single `UserPromptSubmit` entry.
 */
export function createPeerMessageHooks(params: CreatePeerMessageHooksParams): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const { conductor, timezone, timeHeader, clock, logger } = params;

    return {
        UserPromptSubmit: [
            {
                hooks: [
                    async (input): Promise<HookJSONOutput> => {
                        try {
                            const parsed = parsePeerMessage((input as UserPromptSubmitHookInput).prompt);
                            if(parsed !== undefined) {
                                conductor.adoptPeerTurn(buildPeerEnvelope({
                                    ...parsed, now: new Date(clock.now()), timezone, timeHeader: timeHeader(),
                                }));
                                return {
                                    'continue':         true,
                                    hookSpecificOutput: {
                                        hookEventName:     'UserPromptSubmit',
                                        additionalContext: buildPeerRoutingContext(parsed),
                                    },
                                };
                            }
                        } catch (error) {
                            logger.warn({ error }, 'peer-message UserPromptSubmit hook failed');
                        }
                        return { 'continue': true };
                    },
                ],
            },
        ],
    };
}

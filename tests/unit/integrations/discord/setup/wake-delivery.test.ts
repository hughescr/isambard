/**
 * Behavioural tests for {@link createWakeTurnDelivery} (R2): delivers a settled background-work
 * wake turn (`task`-kind) or a settled host-notification reply (`notification`-kind, via
 * `NotificationBridge.attachReplyDelivery`) to Discord — the envelope's own origin channel when
 * one was recorded, the well-known channel when the kind maps to one (perch, rewritten by
 * `sessions.ts`'s perch `onWakeTurnSettled`), or the fallback channel with an explanatory prefix
 * otherwise.
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { Envelope, TurnResult } from '@/agent';
import * as responseSenderModule from '@/integrations/discord/response-sender';
import { createWakeTurnDelivery, type CreateWakeTurnDeliveryParams } from '@/integrations/discord/setup/wake-delivery';

/** Minimal-but-complete `TurnResult` fixture. */
function makeTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
    return {
        envelopeId:          'env-1',
        response:            'the response text',
        wasInterrupted:      false,
        partialWork:         { thinking: '', text: '', pendingToolUse: null, sessionId: undefined },
        sessionId:           'session-id',
        isError:             false,
        contextUsagePercent: 0,
        ...overrides,
    };
}

/** Minimal-but-complete `Envelope` fixture. */
function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
    return {
        id:           'env-1',
        kind:         'task',
        text:         'Task summary line',
        hostPriority: 'wake',
        shouldQuery:  true,
        createdAt:    new Date(0),
        ...overrides,
    };
}

function fakeLogger(): { warn: ReturnType<typeof jest.fn>, error: ReturnType<typeof jest.fn> } {
    return { warn: jest.fn(), error: jest.fn() };
}

function build(overrides: Partial<CreateWakeTurnDeliveryParams> = {}) {
    const conductor = { deliver: jest.fn(async (_id: string, send: () => Promise<{ channelId: string, messageIds: string[] }>) => {
        const result = await send();
        return { delivered: true, ...result };
    }) };
    const responseRouter = {
        routeToFallback: jest.fn(async (content: string) => ({
            targetChannelId: 'fallback-channel-id', shouldSend: true, content, isFallback: true,
        })),
        resolveEnvelopeTarget: jest.fn(),
    };
    const client = {};
    const rateLimiter = {};
    const logger = fakeLogger();

    const deliver = createWakeTurnDelivery({
        conductor,
        responseRouter: responseRouter as unknown as CreateWakeTurnDeliveryParams['responseRouter'],
        client:         client as unknown as CreateWakeTurnDeliveryParams['client'],
        rateLimiter:    rateLimiter as unknown as CreateWakeTurnDeliveryParams['rateLimiter'],
        logger,
        ...overrides,
    });

    return {
        deliver, conductor, responseRouter, client, rateLimiter, logger,
    };
}

describe('createWakeTurnDelivery', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('no-ops when result.response is null', async () => {
        const h = build();
        const sendSpy = jest.spyOn(responseSenderModule, 'sendEnvelopeResponse');

        await h.deliver(makeEnvelope({ channelId: 'chan-1' }), makeTurnResult({ response: null }));

        expect(sendSpy).not.toHaveBeenCalled();
        expect(h.conductor.deliver).not.toHaveBeenCalled();
    });

    it('no-ops when result.response is an empty string', async () => {
        const h = build();
        const sendSpy = jest.spyOn(responseSenderModule, 'sendEnvelopeResponse');

        await h.deliver(makeEnvelope({ channelId: 'chan-1' }), makeTurnResult({ response: '' }));

        expect(sendSpy).not.toHaveBeenCalled();
        expect(h.conductor.deliver).not.toHaveBeenCalled();
    });

    it.each(['withdrawn', 'interrupted'] as const)('no-ops when result.outcome is %s, even with a non-null response', async (outcome) => {
        const h = build();
        const sendSpy = jest.spyOn(responseSenderModule, 'sendEnvelopeResponse');

        await h.deliver(makeEnvelope({ channelId: 'chan-1' }), makeTurnResult({ outcome }));

        expect(sendSpy).not.toHaveBeenCalled();
        expect(h.conductor.deliver).not.toHaveBeenCalled();
    });

    it('delivers to the envelope\'s own channel via conductor.deliver when channelId is set, and the guarded send resolves the delivery as sent (rather than being swallowed as not-sent)', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true });

        await h.deliver(makeEnvelope({ id: 'env-9', kind: 'task', channelId: 'chan-1' }), makeTurnResult({ response: 'done!' }));

        expect(h.conductor.deliver).toHaveBeenCalledWith('env-9', expect.any(Function));
        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({
            envelopeId: 'env-9', kind: 'task', channelId: 'chan-1', text: 'done!', responseRouter: h.responseRouter, client: h.client, rateLimiter: h.rateLimiter,
        }));
        expect(h.responseRouter.routeToFallback).not.toHaveBeenCalled();
        // The default fake conductor.deliver mirrors the real conductor's own bare `await send()`
        // (no internal try/catch) — so this pins the not-sent-guard's happy-path branch (`if(!sent
        // && !queued)`): if that guard were mutated to always throw, the send callback passed to
        // conductor.deliver would reject even on a genuine success, and this resolved value would
        // never be observed.
        await expect(h.conductor.deliver.mock.results[0]?.value).resolves.toEqual({ delivered: true, channelId: 'chan-1', messageIds: [] });
    });

    it('threads discordCapability through to sendEnvelopeResponse when provided', async () => {
        const discordCapability = { sendToChannel: jest.fn() };
        const h = build({ discordCapability: discordCapability as unknown as CreateWakeTurnDeliveryParams['discordCapability'] });
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true });

        await h.deliver(makeEnvelope({ channelId: 'chan-1' }), makeTurnResult());

        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({ discordCapability }));
    });

    it('a well-known-mapped kind (perch) with no channelId still delivers via conductor.deliver, without touching the fallback route', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true });

        await h.deliver(makeEnvelope({ id: 'env-perch-1', kind: 'perch', channelId: undefined }), makeTurnResult({ response: 'perch summary' }));

        expect(h.conductor.deliver).toHaveBeenCalledWith('env-perch-1', expect.any(Function));
        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({
            envelopeId: 'env-perch-1', kind: 'perch', channelId: undefined, text: 'perch summary',
        }));
        expect(h.responseRouter.routeToFallback).not.toHaveBeenCalled();
        // With no envelope.channelId, the send callback's own reported channelId falls back to
        // '' (not left undefined) — this is what conductor.deliver's send() resolves with, and
        // what would back a response_delivered journal row's channelId field.
        await expect(h.conductor.deliver.mock.results[0]?.value).resolves.toEqual({ delivered: true, channelId: '', messageIds: [] });
    });

    it('a \'task\' envelope with no channelId routes to the fallback channel with the default task prefix (summary first line), via conductor.deliver — so a repeat delivery gets journaled/deduped exactly like the known-target routes', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true });

        await h.deliver(
            makeEnvelope({ id: 'env-task-1', kind: 'task', channelId: undefined, text: 'Fixed the flaky test\nmore detail here' }),
            makeTurnResult({ response: 'All done.' })
        );

        const expectedPrefix = 'Background work finished (Fixed the flaky test) — no origin channel was recorded, so this landed here:\n';
        expect(h.responseRouter.routeToFallback).toHaveBeenCalledWith(`${expectedPrefix}All done.`);
        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({
            envelopeId: 'env-task-1', kind: 'task', channelId: 'fallback-channel-id', text: `${expectedPrefix}All done.`,
        }));
        expect(h.conductor.deliver).toHaveBeenCalledWith('env-task-1', expect.any(Function));
    });

    it('a \'notification\' envelope with no channelId routes to the fallback channel with the default notification prefix, via conductor.deliver', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true });

        await h.deliver(
            makeEnvelope({ id: 'env-notif-1', kind: 'notification', channelId: undefined }),
            makeTurnResult({ response: 'Approved the sender.' })
        );

        expect(h.responseRouter.routeToFallback).toHaveBeenCalledWith('Reply to a host notification:\nApproved the sender.');
        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({
            envelopeId: 'env-notif-1', kind: 'notification', channelId: 'fallback-channel-id', text: 'Reply to a host notification:\nApproved the sender.',
        }));
        expect(h.conductor.deliver).toHaveBeenCalledWith('env-notif-1', expect.any(Function));
    });

    it('honours a custom fallbackPrefix override', async () => {
        const fallbackPrefix = jest.fn(() => 'CUSTOM PREFIX:\n');
        const h = build({ fallbackPrefix });
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true });

        const envelope = makeEnvelope({ kind: 'task', channelId: undefined });
        await h.deliver(envelope, makeTurnResult({ response: 'text' }));

        expect(fallbackPrefix).toHaveBeenCalledWith(envelope);
        expect(h.responseRouter.routeToFallback).toHaveBeenCalledWith('CUSTOM PREFIX:\ntext');
    });

    it('a not-sent-not-queued send throws WakeTurnNotSentError, which propagates out of conductor.deliver (matching the real conductor\'s bare `await send()`, no internal catch) and is swallowed by deliverToKnownTarget itself — not rethrown, not logged', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: false, queued: false });

        // Uses the DEFAULT fake conductor.deliver (see build()) — it does a bare `await send()`
        // with no internal try/catch, exactly like the real conductor.deliver (conductor.ts's
        // `await send()` at the top of its own function body), so a throw from the send callback
        // genuinely propagates out of `conductor.deliver(...)` here, into deliverToKnownTarget's
        // own catch — the only thing under test.
        await expect(h.deliver(makeEnvelope({ channelId: 'chan-1' }), makeTurnResult())).resolves.toBeUndefined();

        expect(h.conductor.deliver).toHaveBeenCalled();
        await expect(h.conductor.deliver.mock.results[0]?.value).rejects.toThrow();
        expect(h.logger.error).not.toHaveBeenCalled();
    });

    it('an unexpected conductor.deliver rejection (not the not-sent sentinel) is caught and logged, not rethrown', async () => {
        const h = build();
        h.conductor.deliver.mockRejectedValue(new Error('Discord API down'));

        await expect(h.deliver(makeEnvelope({ channelId: 'chan-1' }), makeTurnResult())).resolves.toBeUndefined();

        expect(h.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error), envelopeId: 'env-1', kind: 'task' }),
            'Wake turn response delivery failed'
        );
    });

    it('a not-sent-not-queued fallback delivery is swallowed silently via conductor.deliver, exactly like a not-sent-not-queued known-target delivery — no warning, no error', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: false, queued: false });

        await expect(h.deliver(makeEnvelope({ kind: 'task', channelId: undefined }), makeTurnResult())).resolves.toBeUndefined();

        expect(h.conductor.deliver).toHaveBeenCalled();
        await expect(h.conductor.deliver.mock.results[0]?.value).rejects.toThrow();
        expect(h.logger.warn).not.toHaveBeenCalled();
        expect(h.logger.error).not.toHaveBeenCalled();
    });

    it('a routeToFallback rejection (no fallback channel configured) is caught and logged, not rethrown', async () => {
        const h = build();
        h.responseRouter.routeToFallback.mockRejectedValue(new Error('fallback channel not configured'));

        await expect(h.deliver(makeEnvelope({ kind: 'task', channelId: undefined }), makeTurnResult())).resolves.toBeUndefined();

        expect(h.logger.error).toHaveBeenCalled();
    });
});

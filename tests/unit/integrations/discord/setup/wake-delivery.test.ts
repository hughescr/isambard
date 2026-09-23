/**
 * Behavioural tests for {@link createWakeTurnDelivery} (R2): delivers a settled background-work
 * wake turn (`task`-kind) or a settled host-notification reply (`notification`-kind, via
 * `NotificationBridge.attachReplyDelivery`) to Discord — the envelope's own origin channel when
 * one was recorded, the well-known channel when the kind maps to one (perch, rewritten by
 * `sessions.ts`'s perch `onWakeTurnSettled`), or the fallback channel with an explanatory prefix
 * otherwise.
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import { type DeliverableEnvelope, type TurnResult, type SendOutcome  } from '@/agent';
import * as responseSenderModule from '@/integrations/discord/response-sender';
import type { SendEnvelopeResponseResult } from '@/integrations/discord/response-sender';
import { createWakeTurnDelivery, type CreateWakeTurnDeliveryParams } from '@/integrations/discord/setup/wake-delivery';

const RESULT_BASE = { envelopeId: 'env-1', sessionId: 'session-id', contextUsagePercent: 0 };

/** Minimal-but-complete completed `TurnResult` fixture. */
function makeTurnResult(overrides: { response?: string } = {}): TurnResult {
    return {
        ...RESULT_BASE, status: 'completed', response: 'the response text', ...overrides,
    };
}

/** One result per non-completed status — none of which carries a reply. */
const NOT_COMPLETED_RESULTS: [string, TurnResult][] = [
    ['failed', { ...RESULT_BASE, status: 'failed', response: null, error: new Error('turn failed') }],
    ['interrupted (human_preempt)', {
        ...RESULT_BASE, status: 'interrupted', response: null, partialWork: { thinking: '', text: 'partial', pendingToolUse: null, sessionId: undefined }, cancellationSource: 'human_preempt',
    }],
    ['withdrawn', { ...RESULT_BASE, status: 'withdrawn', response: null, cancellationSource: 'caller_signal' }],
];

/** Minimal-but-complete `DeliverableEnvelope` fixture — all a wake-turn delivery reads. */
function makeEnvelope(overrides: Partial<DeliverableEnvelope> = {}): DeliverableEnvelope {
    return {
        id:   'env-1',
        kind: 'task',
        text: 'Task summary line',
        ...overrides,
    };
}

function fakeLogger(): { warn: ReturnType<typeof jest.fn>, error: ReturnType<typeof jest.fn> } {
    return { warn: jest.fn(), error: jest.fn() };
}

function build(overrides: Partial<CreateWakeTurnDeliveryParams> = {}) {
    const conductor = { deliver: jest.fn(async (_id: string, send: () => Promise<SendOutcome>) => {
        const result = await send();
        return result.kind === 'skipped' ? { outcome: 'skipped' as const } : { outcome: 'committed' as const, disposition: result.disposition };
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

    it('no-ops when a completed result\'s response is an empty string', async () => {
        const h = build();
        const sendSpy = jest.spyOn(responseSenderModule, 'sendEnvelopeResponse');

        await h.deliver(makeEnvelope({ channelId: 'chan-1' }), makeTurnResult({ response: '' }));

        expect(sendSpy).not.toHaveBeenCalled();
        expect(h.conductor.deliver).not.toHaveBeenCalled();
    });

    it.each(NOT_COMPLETED_RESULTS)('no-ops when the result status is %s', async (_status, result) => {
        const h = build();
        const sendSpy = jest.spyOn(responseSenderModule, 'sendEnvelopeResponse');

        await h.deliver(makeEnvelope({ channelId: 'chan-1' }), result);

        expect(sendSpy).not.toHaveBeenCalled();
        expect(h.conductor.deliver).not.toHaveBeenCalled();
    });

    it('delivers to the envelope\'s own channel via conductor.deliver when channelId is set, and the guarded send resolves the delivery as sent (rather than being swallowed as not-sent)', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });

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
        await expect(h.conductor.deliver.mock.results[0]?.value).resolves.toEqual({ outcome: 'committed', disposition: 'sent' });
    });

    it('a queued send is committed with queued disposition', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'queued', channelId: 'channel-1' as never, outboxIds: ['outbox-1'] });

        await h.deliver(makeEnvelope({ channelId: 'chan-1' }), makeTurnResult());

        expect(h.conductor.deliver).toHaveBeenCalled();
        // If the guard collapsed to checking `sent` twice (ignoring `queued`), this send callback
        // would reject despite the durable outbox commitment, and conductor.deliver's returned
        // promise would reject instead of resolving.
        await expect(h.conductor.deliver.mock.results[0]?.value).resolves.toEqual({ outcome: 'committed', disposition: 'queued' });
        expect(h.logger.error).not.toHaveBeenCalled();
    });

    it('threads discordCapability through to sendEnvelopeResponse when provided', async () => {
        const discordCapability = { sendToChannel: jest.fn() };
        const h = build({ discordCapability: discordCapability as unknown as CreateWakeTurnDeliveryParams['discordCapability'] });
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });

        await h.deliver(makeEnvelope({ channelId: 'chan-1' }), makeTurnResult());

        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({ discordCapability }));
    });

    it('a well-known-mapped kind (perch) with no channelId still delivers via conductor.deliver, without touching the fallback route', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });

        await h.deliver(makeEnvelope({ id: 'env-perch-1', kind: 'perch', channelId: undefined }), makeTurnResult({ response: 'perch summary' }));

        expect(h.conductor.deliver).toHaveBeenCalledWith('env-perch-1', expect.any(Function));
        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({
            envelopeId: 'env-perch-1', kind: 'perch', channelId: undefined, text: 'perch summary',
        }));
        expect(h.responseRouter.routeToFallback).not.toHaveBeenCalled();
        // With no envelope.channelId, the send callback's own reported channelId falls back to
        // '' (not left undefined) — this is what conductor.deliver's send() resolves with, and
        // what would back a response_delivered journal row's channelId field.
        await expect(h.conductor.deliver.mock.results[0]?.value).resolves.toEqual({ outcome: 'committed', disposition: 'sent' });
    });

    it('a \'task\' envelope with no channelId routes to the fallback channel with the default task prefix (summary first line), via conductor.deliver — so a repeat delivery gets journaled/deduped exactly like the known-target routes', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });

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

    it('keeps the task fallback summary empty when the settled task has no text', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });

        await h.deliver(makeEnvelope({ kind: 'task', channelId: undefined, text: '' }), makeTurnResult({ response: 'All done.' }));

        expect(h.responseRouter.routeToFallback).toHaveBeenCalledWith('Background work finished () — no origin channel was recorded, so this landed here:\nAll done.');
    });

    it('a \'notification\' envelope with no channelId routes to the fallback channel with the default notification prefix, via conductor.deliver', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });

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
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });

        const envelope = makeEnvelope({ kind: 'task', channelId: undefined });
        await h.deliver(envelope, makeTurnResult({ response: 'text' }));

        expect(fallbackPrefix).toHaveBeenCalledWith(envelope);
        expect(h.responseRouter.routeToFallback).toHaveBeenCalledWith('CUSTOM PREFIX:\ntext');
    });

    it('forwards a skipped send to conductor.deliver without logging a delivery failure', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'skipped', reason: 'no-response' });
        await expect(h.deliver(makeEnvelope({ channelId: 'chan-1' }), makeTurnResult())).resolves.toBeUndefined();

        expect(h.conductor.deliver).toHaveBeenCalled();
        await expect(h.conductor.deliver.mock.results[0]?.value).resolves.toEqual({ outcome: 'skipped' });
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

    it('a skipped fallback delivery is forwarded silently to conductor.deliver', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'skipped', reason: 'no-response' });

        await expect(h.deliver(makeEnvelope({ kind: 'task', channelId: undefined }), makeTurnResult())).resolves.toBeUndefined();

        expect(h.conductor.deliver).toHaveBeenCalled();
        await expect(h.conductor.deliver.mock.results[0]?.value).resolves.toEqual({ outcome: 'skipped' });
        expect(h.logger.warn).not.toHaveBeenCalled();
        expect(h.logger.error).not.toHaveBeenCalled();
    });

    it('a routeToFallback rejection (no fallback channel configured) is caught and logged, not rethrown', async () => {
        const h = build();
        h.responseRouter.routeToFallback.mockRejectedValue(new Error('fallback channel not configured'));

        await expect(h.deliver(makeEnvelope({ kind: 'task', channelId: undefined }), makeTurnResult())).resolves.toBeUndefined();

        expect(h.logger.error).toHaveBeenCalled();
    });

    it('a known-target delivery does not resolve until the send settles — proves deliverWakeTurn genuinely awaits deliverToKnownTarget\'s conductor.deliver chain rather than firing it and returning early', async () => {
        const h = build();
        let resolveSend!: (v: SendEnvelopeResponseResult) => void;
        const pending = new Promise<SendEnvelopeResponseResult>((resolve) => {
            resolveSend = resolve;
        });
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockReturnValue(pending);

        let settled = false;
        const operation = h.deliver(makeEnvelope({ channelId: 'chan-1' }), makeTurnResult());
        const observer = operation.then(() => {
            settled = true;
            return undefined;
        });

        // No amount of microtask flushing settles `observer` while the send is genuinely pending —
        // this is what distinguishes a real await chain from a fire-and-forget call (which would
        // settle it almost immediately, without ever observing sendEnvelopeResponse's own result).
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);

        resolveSend({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });
        await operation;
        await observer;
        expect(settled).toBe(true);
    });

    it('uses the sender-resolved channel ID when a perch envelope has no origin channel', async () => {
        const h = build();
        let deliveredOutcome: SendOutcome | undefined;
        h.conductor.deliver.mockImplementation(async (_id: string, send: () => Promise<SendOutcome>) => {
            deliveredOutcome = await send();
            return deliveredOutcome.kind === 'skipped'
                ? { outcome: 'skipped' as const }
                : { outcome: 'committed' as const, disposition: deliveredOutcome.disposition };
        });
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });

        await h.deliver(makeEnvelope({ id: 'env-perch-empty-channel', kind: 'perch', channelId: undefined }), makeTurnResult());

        expect(deliveredOutcome).toEqual({
            kind: 'committed', disposition: 'sent', channelId: 'channel-1', messageIds: [],
        });
    });

    it('a fallback delivery does not resolve until the routing (and then the send) settles — proves deliverToFallback\'s conductor.deliver chain is genuinely awaited, not fired and forgotten', async () => {
        const h = build();
        jest.spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });
        let resolveRouting!: (v: { targetChannelId: string, shouldSend: boolean, content: string, isFallback: boolean }) => void;
        const pending = new Promise<{ targetChannelId: string, shouldSend: boolean, content: string, isFallback: boolean }>((resolve) => {
            resolveRouting = resolve;
        });
        h.responseRouter.routeToFallback.mockReturnValue(pending);

        let settled = false;
        const operation = h.deliver(makeEnvelope({ kind: 'task', channelId: undefined }), makeTurnResult());
        const observer = operation.then(() => {
            settled = true;
            return undefined;
        });

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);

        resolveRouting({ targetChannelId: 'fallback-channel-id', shouldSend: true, content: 'x', isFallback: true });
        await operation;
        await observer;
        expect(settled).toBe(true);
    });
});

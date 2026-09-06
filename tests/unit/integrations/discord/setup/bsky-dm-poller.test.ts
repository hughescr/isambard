/**
 * Tests for the Bluesky DM poller (Q8): a health-gated setInterval tick that lists unread
 * conversations, runs them through `BskyCheckpointManager.processDirectMessages` (which persists
 * the checkpoint itself), and raises exactly one accumulate notification per non-empty batch.
 */
import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { makeHealthRegistry } from '../../../../helpers/fake-health-registry';
import { mockLogger } from '../../../../setup';
import type { NotifyParams } from '@/agent';
import type { BlueskyClient, BskyConversation } from '@/integrations/bsky';
import type { BskyCheckpointManager } from '@/integrations/bsky/checkpoint';
import {
    createBskyDmPoller, DEFAULT_DM_POLL_INTERVAL_MS, type BskyDmPollerOptions
} from '@/integrations/discord/setup/bsky-dm-poller';

/** Flush enough microtask turns for a tick's `await`-chain (listConversations → processDirectMessages) to settle. */
async function flushMicrotasks(): Promise<void> {
    for(let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential microtask flush by design
        await Promise.resolve();
    }
}

function makeConvo(overrides: Partial<BskyConversation> = {}): BskyConversation {
    return {
        id:          'convo-1',
        rev:         'rev-1',
        members:     [],
        muted:       false,
        unreadCount: 1,
        lastMessage: {
            id: 'msg-1', rev: 'rev-1', text: 'hi', senderDid: 'did:plc:them', sentAt: '2026-01-01T00:00:00.000Z',
        },
        ...overrides,
    };
}

describe('bsky-dm-poller', () => {
    let listConversations: ReturnType<typeof mock>;
    let processDirectMessages: ReturnType<typeof mock>;
    let unprocessDirectMessages: ReturnType<typeof mock>;
    let notify: ReturnType<typeof mock>;
    let options: BskyDmPollerOptions;

    beforeEach(() => {
        jest.useFakeTimers();
        mockLogger.error.mockClear();

        listConversations = mock(async () => ({ conversations: [makeConvo()] }));
        processDirectMessages = mock(async () => ({
            newConvos: [makeConvo()], totalFetched: 1, lastSeenSentAt: '2026-01-01T00:00:00.000Z', hadExistingCheckpoint: true,
        }));
        unprocessDirectMessages = mock(async () => undefined);
        notify = mock((_params: NotifyParams) => true);

        options = {
            client:            { listConversations } as unknown as BlueskyClient,
            checkpointManager: { processDirectMessages, unprocessDirectMessages } as unknown as BskyCheckpointManager,
            notify,
            healthRegistry:    makeHealthRegistry({ available: { bluesky: true } }),
            intervalMs:        1000,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('skips the tick entirely when bluesky is unavailable', async () => {
        options.healthRegistry = makeHealthRegistry({ available: { bluesky: false } });
        const poller = createBskyDmPoller(options);

        poller.start();
        jest.advanceTimersByTime(1000);
        await flushMicrotasks();

        expect(listConversations).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('calls notify exactly once for a non-empty batch, keyed and worded on the newest lastMessage.id even when it is not the last array element', async () => {
        processDirectMessages.mockImplementation(async () => ({
            // Newest message listed FIRST — pins that selection sorts by sentAt rather than
            // trusting array order (`.at(-1)` on unsorted input would pick 'msg-old' here).
            newConvos: [
                makeConvo({ id: 'b', lastMessage: { id: 'msg-new', rev: 'r', text: 't', senderDid: 'd', sentAt: '2026-01-02T00:00:00.000Z' } }),
                makeConvo({ id: 'a', lastMessage: { id: 'msg-old', rev: 'r', text: 't', senderDid: 'd', sentAt: '2026-01-01T00:00:00.000Z' } }),
            ],
            totalFetched: 2, lastSeenSentAt: '2026-01-02T00:00:00.000Z', hadExistingCheckpoint: true,
        }));
        const poller = createBskyDmPoller(options);

        poller.start();
        jest.advanceTimersByTime(1000);
        await flushMicrotasks();

        expect(listConversations).toHaveBeenCalledTimes(1);
        expect(listConversations).toHaveBeenCalledWith(undefined, undefined, 'unread');
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0]?.[0]).toMatchObject({
            source:    'bluesky-dm',
            text:      '2 new unread Bluesky conversation(s)',
            wake:      false,
            dedupeKey: 'bsky-dm:msg-new',
        });
    });

    it('unprocesses the batch\'s message ids when notify() cannot deliver (conductor not yet open) so the next tick retries', async () => {
        processDirectMessages.mockImplementation(async () => ({
            newConvos: [
                makeConvo({ id: 'a', lastMessage: { id: 'msg-a', rev: 'r', text: 't', senderDid: 'd', sentAt: '2026-01-01T00:00:00.000Z' } }),
                makeConvo({ id: 'b', lastMessage: { id: 'msg-b', rev: 'r', text: 't', senderDid: 'd', sentAt: '2026-01-02T00:00:00.000Z' } }),
            ],
            totalFetched: 2, lastSeenSentAt: '2026-01-02T00:00:00.000Z', hadExistingCheckpoint: true,
        }));
        notify.mockImplementation(() => false);
        const poller = createBskyDmPoller(options);

        poller.start();
        jest.advanceTimersByTime(1000);
        await flushMicrotasks();

        expect(unprocessDirectMessages).toHaveBeenCalledTimes(1);
        expect(unprocessDirectMessages).toHaveBeenCalledWith(['msg-a', 'msg-b']);
    });

    it('does not unprocess anything when notify() delivers successfully', async () => {
        const poller = createBskyDmPoller(options);

        poller.start();
        jest.advanceTimersByTime(1000);
        await flushMicrotasks();

        expect(notify).toHaveBeenCalledTimes(1);
        expect(unprocessDirectMessages).not.toHaveBeenCalled();
    });

    it('calls notify nothing for an empty batch', async () => {
        processDirectMessages.mockImplementation(async () => ({
            newConvos: [], totalFetched: 0, lastSeenSentAt: undefined, hadExistingCheckpoint: false,
        }));
        const poller = createBskyDmPoller(options);

        poller.start();
        jest.advanceTimersByTime(1000);
        await flushMicrotasks();

        expect(notify).not.toHaveBeenCalled();
        // Pins the `newConvos.length > 0` guard itself (not just its consequence): a mutant that
        // widens the comparison to `>= 0` (or forces the branch to always-true) still ends up with
        // `notify` uncalled here, because `newestMessageId([])` throws on the empty array and the
        // tick's outer catch swallows it — but the original code never enters that branch at all
        // for an empty batch, so it never throws or logs. Asserting no error was logged catches
        // the mutant that the notify-call-count assertion above cannot distinguish.
        expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('start() is idempotent — a second start() while running does not create a second interval', async () => {
        const poller = createBskyDmPoller(options);

        poller.start();
        poller.start();
        jest.advanceTimersByTime(1000);
        await flushMicrotasks();

        expect(listConversations).toHaveBeenCalledTimes(1);
    });

    it('stop() before any start() is a no-op', () => {
        const poller = createBskyDmPoller(options);

        expect(() => {
            poller.stop();
        }).not.toThrow();
    });

    it('stop() clears the interval so no further ticks fire', async () => {
        const poller = createBskyDmPoller(options);

        poller.start();
        poller.stop();
        jest.advanceTimersByTime(5000);
        await flushMicrotasks();

        expect(listConversations).not.toHaveBeenCalled();
    });

    it('catches and logs a tick that throws, without propagating', async () => {
        listConversations.mockImplementation(async () => {
            throw new Error('bsky unavailable');
        });
        const poller = createBskyDmPoller(options);

        poller.start();
        jest.advanceTimersByTime(1000);
        await flushMicrotasks();

        expect(mockLogger.error).toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('logs a failed tick through an injected logger instead of the default one', async () => {
        listConversations.mockImplementation(async () => {
            throw new Error('bsky unavailable');
        });
        const injectedError = mock((..._args: unknown[]) => undefined);
        options.logger = { error: injectedError } as unknown as BskyDmPollerOptions['logger'];
        const poller = createBskyDmPoller(options);

        poller.start();
        jest.advanceTimersByTime(1000);
        await flushMicrotasks();

        expect(injectedError).toHaveBeenCalled();
        expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('exports a default poll interval', () => {
        expect(DEFAULT_DM_POLL_INTERVAL_MS).toBeGreaterThan(0);
    });
});

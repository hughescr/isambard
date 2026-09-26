import { afterEach, describe, test, expect, mock } from 'bun:test';
import type { Client, Message, TextChannel } from 'discord.js';
import type { NotifyFn } from '../../../../src/agent';
import { createChannelId } from '../../../../src/agent/types';
import { DiscordCapabilityImpl, type DiscordCapabilityLogger } from '../../../../src/integrations/discord/capability';
import { DISCORD_MAX_LENGTH } from '../../../../src/integrations/discord/messages';
import { boundNoticeText, createOutboxReplayDeliverFn, deliveryTokenFor, describeDroppedReply, DISCARD_NOTICE_TEXT_LIMIT, messageChunksFor, textPartPayload } from '../../../../src/integrations/discord/outbox-replay';
import { appendDeliveryCode, decodeDeliveryCode, deliveryCodeFor, maxContentLengthForDeliveryCode } from '../../../../src/integrations/discord/zero-width-delivery-code';
import type { ServiceHealthRegistry } from '../../../../src/services/health-registry';
import { OutboxDeliveryDeferredError, OutboxDiscardRequestedError, OutboxVerificationPendingError, type OutboxBackend, type OutboxItem } from '../../../../src/services/outbox';
import { outboxItemSchema } from '../../../../src/services/outbox/types';

afterEach(() => {
    mock.restore();
});

const REPLY_ID = '1400000000000000001';
const BUDGET_TOKEN = 'budgettoken';

function makeItem(overrides: Partial<OutboxItem>): OutboxItem {
    return {
        id:          'aaaaaaaa-1111-4222-8333-444444444444',
        createdAt:   '2026-09-22T12:00:00.000Z',
        type:        'agent_response',
        service:     'discord',
        destination: createChannelId('ch-1'),
        payload:     {},
        priority:    'high',
        dedupeKey:   'dedupe',
        progress:    { attemptCount: 0, deliveryToken: BUDGET_TOKEN },
        epoch:       0,
        ...overrides,
    };
}

/** Text that splits into exactly `parts` chunks for an item carrying BUDGET_TOKEN. */
function textOfParts(parts: number): string {
    const budget = maxContentLengthForDeliveryCode(deliveryTokenFor(makeItem({}), 0), DISCORD_MAX_LENGTH);
    return 'a'.repeat(budget * (parts - 1) + 1);
}

function historyOf(item: OutboxItem, parts: number[]): Map<string, { content: string }> {
    return new Map(parts.map(part => [`m${part}`, { content: appendDeliveryCode('x', deliveryTokenFor(item, part)) }]));
}

function makeReplayChannel(send: (...args: unknown[]) => Promise<Message>, fetch: (...args: unknown[]) => Promise<unknown> = async () => new Map()): TextChannel {
    return { send: mock(send), messages: { fetch: mock(fetch) } } as unknown as TextChannel;
}

function sentPayloads(channel: TextChannel): unknown[] {
    return (channel.send as ReturnType<typeof mock>).mock.calls.map(call => call[0]);
}

function replay(channel: TextChannel, notify: NotifyFn = mock(() => true)): (item: OutboxItem) => Promise<void> {
    return createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify });
}

const ok = async (): Promise<Message> => ({ id: 'sent' } as Message);

describe('textPartPayload', () => {
    test('gives part 0 of a reply item the reply reference and later parts none', () => {
        const item = makeItem({ payload: { text: 'Hello', replyToMessageId: REPLY_ID } });

        expect(textPartPayload(item, 0, 'Hello')).toEqual({
            content:      appendDeliveryCode('Hello', deliveryTokenFor(item, 0)),
            nonce:        deliveryTokenFor(item, 0),
            enforceNonce: true,
            reply:        { messageReference: REPLY_ID, failIfNotExists: true },
        });
        expect(textPartPayload(item, 1, 'more')).toEqual({ content: appendDeliveryCode('more', deliveryTokenFor(item, 1)), nonce: deliveryTokenFor(item, 1), enforceNonce: true });
    });

    test('gives part 0 of a non-reply item no reply key', () => {
        const item = makeItem({ payload: { text: 'Hello' } });

        expect(textPartPayload(item, 0, 'Hello')).toEqual({ content: appendDeliveryCode('Hello', deliveryTokenFor(item, 0)), nonce: deliveryTokenFor(item, 0), enforceNonce: true });
    });
});

describe('describeDroppedReply', () => {
    test('tells Izzy which reply was dropped, where, and what it said', () => {
        const item = makeItem({ payload: { text: 'The undelivered words', replyToMessageId: REPLY_ID } });

        expect(describeDroppedReply(item, REPLY_ID)).toEqual({
            source: 'discord-outbox',
            key:    item.id,
            wake:   true,
            text:   `A queued Discord reply was dropped and NOT posted: the message it replied to (${REPLY_ID}) in channel ch-1 was deleted before the reply could be delivered. Undelivered text:\n\nThe undelivered words`,
        });
    });

    test('leaves the undelivered text empty for an item without text', () => {
        const item = makeItem({ payload: { replyToMessageId: REPLY_ID } });

        expect(describeDroppedReply(item, REPLY_ID).text).toBe(`A queued Discord reply was dropped and NOT posted: the message it replied to (${REPLY_ID}) in channel ch-1 was deleted before the reply could be delivered. Undelivered text:\n\n`);
    });

    test('bounds the undelivered text', () => {
        const item = makeItem({ payload: { text: 'w'.repeat(DISCARD_NOTICE_TEXT_LIMIT + 1), replyToMessageId: REPLY_ID } });

        expect(describeDroppedReply(item, REPLY_ID).text).toEndWith(`Undelivered text:\n\n${'w'.repeat(DISCARD_NOTICE_TEXT_LIMIT)}… [1 more characters not shown]`);
    });
});

describe('boundNoticeText', () => {
    test('keeps text of exactly the limit and truncates longer text with a count of what was cut', () => {
        expect(DISCARD_NOTICE_TEXT_LIMIT).toBe(4000);
        expect(boundNoticeText('x'.repeat(DISCARD_NOTICE_TEXT_LIMIT))).toBe('x'.repeat(DISCARD_NOTICE_TEXT_LIMIT));
        expect(boundNoticeText(`${'x'.repeat(DISCARD_NOTICE_TEXT_LIMIT)}yz`)).toBe(`${'x'.repeat(DISCARD_NOTICE_TEXT_LIMIT)}… [2 more characters not shown]`);
    });
});

describe('outbox replay resumes after partial delivery', () => {
    test('sends only the parts after deliveredParts without re-checking a reply target', async () => {
        const item = makeItem({ payload: { text: textOfParts(3), replyToMessageId: REPLY_ID }, progress: { attemptCount: 2, deliveryToken: BUDGET_TOKEN, deliveredParts: 2 } });
        const chunks = messageChunksFor(item);
        const channel = makeReplayChannel(ok);

        await replay(channel)(item);

        expect(chunks).toHaveLength(3);
        expect(sentPayloads(channel)).toEqual([textPartPayload(item, 2, chunks[2])]);
        expect(channel.messages.fetch).not.toHaveBeenCalled();
    });

    test('acknowledges an unknown outcome when history holds every remaining part code', async () => {
        const item = makeItem({ payload: { text: textOfParts(3), replyToMessageId: REPLY_ID }, progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: BUDGET_TOKEN, deliveredParts: 1 } });
        const channel = makeReplayChannel(ok, async () => historyOf(item, [1, 2]));

        await replay(channel)(item);

        expect(channel.messages.fetch).toHaveBeenCalledTimes(1);
        expect(channel.messages.fetch).toHaveBeenCalledWith({ limit: 100 });
        expect(channel.send).not.toHaveBeenCalled();
    });

    test('never resends a middle part whose code is present, even when the part before it is not visible', async () => {
        const item = makeItem({ payload: { text: textOfParts(3) }, progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: BUDGET_TOKEN } });
        const chunks = messageChunksFor(item);
        const channel = makeReplayChannel(ok, async () => historyOf(item, [1]));

        await replay(channel)(item);

        expect(sentPayloads(channel)).toEqual([textPartPayload(item, 2, chunks[2])]);
    });

    test('resends from deliveredParts when history holds none of the remaining codes', async () => {
        const item = makeItem({ payload: { text: textOfParts(3) }, progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: BUDGET_TOKEN, deliveredParts: 1 } });
        const chunks = messageChunksFor(item);
        const channel = makeReplayChannel(ok, async () => historyOf(item, [0]));

        await replay(channel)(item);

        expect(sentPayloads(channel)).toEqual([textPartPayload(item, 1, chunks[1]), textPartPayload(item, 2, chunks[2])]);
    });

    test('ignores a history code for a part index the item does not have', async () => {
        const item = makeItem({ payload: { text: 'Only part' }, progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: BUDGET_TOKEN } });
        const channel = makeReplayChannel(ok, async () => historyOf(item, [1]));

        await replay(channel)(item);

        expect(sentPayloads(channel)).toEqual([textPartPayload(item, 0, 'Only part')]);
    });

    test('ignores a code before deliveredParts when choosing where to resume', async () => {
        const item = makeItem({ payload: { text: textOfParts(3) }, progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: BUDGET_TOKEN, deliveredParts: 2 } });
        const chunks = messageChunksFor(item);
        const channel = makeReplayChannel(ok, async () => historyOf(item, [1]));

        await replay(channel)(item);

        expect(sentPayloads(channel)).toEqual([textPartPayload(item, 2, chunks[2])]);
    });

    test('records each delivered part so a later failure keeps the confirmed prefix', async () => {
        const item = makeItem({ payload: { text: textOfParts(3) } });
        const failure = new Error('Missing Permissions');
        const send = mock(ok).mockImplementationOnce(ok).mockImplementationOnce(async () => {
            throw failure;
        });
        const channel = { send, messages: { fetch: mock(async () => new Map()) } } as unknown as TextChannel;

        await expect(replay(channel)(item)).rejects.toBe(failure);
        expect(item.progress.deliveredParts).toBe(1);
        expect(send).toHaveBeenCalledTimes(2);
    });

    test('records the history-confirmed resume point before sending, so a rejected next part keeps it', async () => {
        const item = makeItem({ payload: { text: textOfParts(3) }, progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: BUDGET_TOKEN, deliveredParts: 1 } });
        const chunks = messageChunksFor(item);
        const failure = new Error('Missing Permissions');
        const channel = makeReplayChannel(async () => {
            throw failure;
        }, async () => historyOf(item, [1]));

        await expect(replay(channel)(item)).rejects.toBe(failure);
        expect(sentPayloads(channel)).toEqual([textPartPayload(item, 2, chunks[2])]);
        expect(item.progress.deliveredParts).toBe(2);
    });

    test('settles an unknown outcome once history is checked, so a rejection after it is definitive', async () => {
        const item = makeItem({ payload: { text: 'Queued words' }, progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: BUDGET_TOKEN } });
        const failure = new Error('Missing Permissions');
        const channel = makeReplayChannel(async () => {
            throw failure;
        });

        await expect(replay(channel)(item)).rejects.toBe(failure);
        expect(item.progress.outcome).toBe('retryable');
    });

    test('keeps an unknown outcome when the channel fetch fails before history is checked', async () => {
        const item = makeItem({ payload: { text: 'Queued words' }, progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: BUDGET_TOKEN } });
        const failure = Object.assign(new Error('Missing Access'), { status: 403 });
        const deliver = createOutboxReplayDeliverFn({ fetchChannel: mock(async () => {
            throw failure;
        }), notify: mock(() => true) });

        await expect(deliver(item)).rejects.toBe(failure);
        expect(item.progress.outcome).toBe('unknown');
    });

    test('sends only the rich part when the text parts were already delivered', async () => {
        const embeds = [{ title: 'Approval needed' }];
        const item = makeItem({ payload: { text: 'Hello', embeds }, progress: { attemptCount: 1, deliveryToken: BUDGET_TOKEN, deliveredParts: 1 } });
        const channel = makeReplayChannel(ok);

        await replay(channel)(item);

        expect(sentPayloads(channel)).toEqual([{ embeds, components: undefined, content: appendDeliveryCode('', deliveryTokenFor(item, 1)), nonce: deliveryTokenFor(item, 1), enforceNonce: true }]);
    });

    test('acknowledges without sending when the rich part code proves the whole item delivered', async () => {
        const embeds = [{ title: 'Approval needed' }];
        const item = makeItem({ payload: { text: 'Hello', embeds }, progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: BUDGET_TOKEN } });
        const channel = makeReplayChannel(ok, async () => historyOf(item, [1]));

        await replay(channel)(item);

        expect(channel.send).not.toHaveBeenCalled();
    });
});

describe('legacy per-chunk response rows', () => {
    test('parses and drains two independently queued old-format chunks', async () => {
        const first = outboxItemSchema.parse(makeItem({ dedupeKey: 'random-b', payload: { text: 'first' }, progress: { attemptCount: 0, deliveryToken: 'oldtoken1' } }));
        const second = outboxItemSchema.parse(makeItem({ dedupeKey: 'random-a', payload: { text: 'second' }, progress: { attemptCount: 0, deliveryToken: 'oldtoken2' } }));
        const channel = makeReplayChannel(ok);
        await replay(channel)(first);
        await replay(channel)(second);
        expect(sentPayloads(channel)).toStrictEqual([
            textPartPayload(first, 0, 'first'), textPartPayload(second, 0, 'second'),
        ]);
        expect(first.progress.deliveredParts).toBe(1);
        expect(second.progress.deliveredParts).toBe(1);
    });
});

describe('outbox replay of a queued reply', () => {
    test('sends part 0 as a reply and later parts without one, never fetching the target on success', async () => {
        const item = makeItem({ payload: { text: textOfParts(2), replyToMessageId: REPLY_ID } });
        const chunks = messageChunksFor(item);
        const channel = makeReplayChannel(ok);

        await replay(channel)(item);

        expect(sentPayloads(channel)).toEqual([textPartPayload(item, 0, chunks[0]), textPartPayload(item, 1, chunks[1])]);
        expect((sentPayloads(channel)[0] as { reply: unknown }).reply).toEqual({ messageReference: REPLY_ID, failIfNotExists: true });
        expect(channel.messages.fetch).not.toHaveBeenCalled();
    });

    test('notifies Izzy with the full text and requests a discard when the target was deleted', async () => {
        const item = makeItem({ payload: { text: 'Queued words', replyToMessageId: REPLY_ID } });
        const notify = mock(() => true);
        const channel = makeReplayChannel(async () => {
            throw Object.assign(new Error('Invalid Form Body'), { code: 50_035, status: 400 });
        }, async () => {
            throw Object.assign(new Error('Unknown Message'), { code: 10_008, status: 404 });
        });

        const rejection = replay(channel, notify)(item);

        await expect(rejection).rejects.toBeInstanceOf(OutboxDiscardRequestedError);
        await expect(rejection).rejects.toMatchObject({ reason: 'reply_target_deleted' });
        expect(channel.messages.fetch).toHaveBeenCalledWith({ message: REPLY_ID, force: true });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(describeDroppedReply(item, REPLY_ID));
        expect(channel.send).toHaveBeenCalledTimes(1);
    });

    test('defers instead of discarding while Izzy cannot be told', async () => {
        const item = makeItem({ payload: { text: 'Queued words', replyToMessageId: REPLY_ID } });
        const channel = makeReplayChannel(async () => {
            throw Object.assign(new Error('Invalid Form Body'), { code: 50_035, status: 400 });
        }, async () => {
            throw Object.assign(new Error('Unknown Message'), { code: 10_008, status: 404 });
        });

        const rejection = replay(channel, mock(() => false))(item);

        await expect(rejection).rejects.toBeInstanceOf(OutboxDeliveryDeferredError);
        await expect(rejection).rejects.toThrow('Reply target deleted; Izzy not yet notified');
    });

    test('rethrows the original rejection when the target still exists', async () => {
        const item = makeItem({ payload: { text: 'Queued words', replyToMessageId: REPLY_ID } });
        const failure = Object.assign(new Error('Invalid Form Body'), { code: 50_035, status: 400 });
        const notify = mock(() => true);
        const channel = makeReplayChannel(async () => {
            throw failure;
        }, async () => ({ id: REPLY_ID }));

        await expect(replay(channel, notify)(item)).rejects.toBe(failure);
        expect(channel.messages.fetch).toHaveBeenCalledWith({ message: REPLY_ID, force: true });
        expect(notify).not.toHaveBeenCalled();
    });

    test.each([
        ['a different API error', Object.assign(new Error('Missing Access'), { code: 50_001, status: 403 })],
        ['null', null],
        ['a string', 'odd failure'],
        ['undefined', undefined],
    ])('rethrows the original rejection when the target check fails with %s', async (_description, checkError) => {
        const item = makeItem({ payload: { text: 'Queued words', replyToMessageId: REPLY_ID } });
        const failure = Object.assign(new Error('Missing Permissions'), { code: 50_013, status: 403 });
        const notify = mock(() => true);
        const channel = makeReplayChannel(async () => {
            throw failure;
        }, async () => {
            throw checkError;
        });

        await expect(replay(channel, notify)(item)).rejects.toBe(failure);
        expect(notify).not.toHaveBeenCalled();
    });

    test('keeps the outcome open when the target check itself is indeterminate', async () => {
        const item = makeItem({ payload: { text: 'Queued words', replyToMessageId: REPLY_ID } });
        const channel = makeReplayChannel(async () => {
            throw Object.assign(new Error('Invalid Form Body'), { code: 50_035, status: 400 });
        }, async () => {
            throw Object.assign(new Error('Service Unavailable'), { status: 503 });
        });

        const rejection = replay(channel)(item);

        await expect(rejection).rejects.toBeInstanceOf(OutboxVerificationPendingError);
        await expect(rejection).rejects.toThrow('Reply target check indeterminate after a rejected reply');
    });

    test('does not check the target after a transient part-0 failure', async () => {
        const item = makeItem({ payload: { text: 'Queued words', replyToMessageId: REPLY_ID } });
        const channel = makeReplayChannel(async () => {
            throw Object.assign(new Error('Service Unavailable'), { status: 503 });
        });

        await expect(replay(channel)(item)).rejects.toBeInstanceOf(OutboxVerificationPendingError);
        expect(channel.messages.fetch).not.toHaveBeenCalled();
    });

    test('does not check the target after a later part fails', async () => {
        const item = makeItem({ payload: { text: textOfParts(2), replyToMessageId: REPLY_ID } });
        const failure = new Error('Missing Permissions');
        const send = mock(ok).mockImplementationOnce(ok).mockImplementationOnce(async () => {
            throw failure;
        });
        const channel = { send, messages: { fetch: mock(async () => new Map()) } } as unknown as TextChannel;

        await expect(replay(channel)(item)).rejects.toBe(failure);
        expect(channel.messages.fetch).not.toHaveBeenCalled();
    });

    test('does not check any target when a non-reply item fails', async () => {
        const item = makeItem({ payload: { text: 'Plain words' } });
        const failure = new Error('Missing Permissions');
        const channel = makeReplayChannel(async () => {
            throw failure;
        });

        await expect(replay(channel)(item)).rejects.toBe(failure);
        expect(channel.messages.fetch).not.toHaveBeenCalled();
    });

    test('acknowledges an unknown reply found in history without checking its target', async () => {
        const item = makeItem({ payload: { text: 'Queued words', replyToMessageId: REPLY_ID }, progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: BUDGET_TOKEN } });
        const channel = makeReplayChannel(ok, async () => historyOf(item, [0]));

        await replay(channel)(item);

        expect(channel.messages.fetch).toHaveBeenCalledTimes(1);
        expect(channel.messages.fetch).toHaveBeenCalledWith({ limit: 100 });
        expect(channel.send).not.toHaveBeenCalled();
    });
});

// ---- DiscordCapabilityImpl.sendText ----

function makeRegistry(available: boolean): ServiceHealthRegistry {
    return { isAvailable: mock((service: string) => service === 'discord' && available) } as unknown as ServiceHealthRegistry;
}

function makeLogger(): DiscordCapabilityLogger {
    return { warn: mock(() => undefined), error: mock(() => undefined), info: mock(() => undefined) };
}

function makeOutbox(): OutboxBackend {
    return { enqueue: mock(async (_item: OutboxItem) => undefined) } as unknown as OutboxBackend;
}

function enqueued(outbox: OutboxBackend): OutboxItem {
    return (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
}

function makeSendChannel(send?: (...args: unknown[]) => Promise<Message>): TextChannel {
    let count = 0;
    return { send: mock(send ?? (async (): Promise<Message> => ({ id: `m${count++}` } as Message))) } as unknown as TextChannel;
}

function makeTextCapability(options: { ready: boolean, channel?: unknown, outbox?: OutboxBackend, fetch?: () => Promise<unknown>, onQueued?: () => void }): { cap: DiscordCapabilityImpl, client: Client, logger: DiscordCapabilityLogger } {
    const logger = makeLogger();
    const cap = new DiscordCapabilityImpl({
        registry: makeRegistry(options.ready),
        logger,
        ...(options.outbox === undefined ? {} : { outboxBackend: options.outbox }),
        ...(options.onQueued === undefined ? {} : { onQueued: options.onQueued }),
    });
    const client = { channels: { fetch: mock(options.fetch ?? (async () => options.channel)) } } as unknown as Client;
    cap.setClient(client);
    return { cap, client, logger };
}

/** Rebuilds the item sendText used from the nonce it put on its first send. */
function itemFromFirstSend(channel: TextChannel, text: string, replyToMessageId?: string): OutboxItem {
    const nonce = (sentPayloads(channel)[0] as { nonce: string }).nonce;
    return makeItem({ payload: { text, ...(replyToMessageId === undefined ? {} : { replyToMessageId }) }, progress: { attemptCount: 0, deliveryToken: nonce.slice(2, -6) } });
}

describe('DiscordCapabilityImpl.sendText', () => {
    test('sends short text once with its delivery code and nonce and reports it sent', async () => {
        const channel = makeSendChannel();
        const outbox = makeOutbox();
        const { cap, client } = makeTextCapability({ ready: true, channel, outbox });

        const result = await cap.sendText(createChannelId('ch-1'), 'Hello');

        const item = itemFromFirstSend(channel, 'Hello');
        expect(result).toEqual({ status: 'sent', messageIds: ['m0'], chunkCount: 1 });
        expect(sentPayloads(channel)).toEqual([{ content: appendDeliveryCode('Hello', deliveryTokenFor(item, 0)), nonce: deliveryTokenFor(item, 0), enforceNonce: true }]);
        expect(client.channels.fetch).toHaveBeenCalledWith('ch-1');
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    test('splits long text within the code budget and gives every part its own complete code', async () => {
        const channel = makeSendChannel();
        const { cap } = makeTextCapability({ ready: true, channel, outbox: makeOutbox() });
        const text = 'b'.repeat(4500);

        const result = await cap.sendText(createChannelId('ch-1'), text);

        const item = itemFromFirstSend(channel, text);
        const contents = (sentPayloads(channel) as { content: string, nonce: string }[]).map(payload => payload.content);
        expect(result).toEqual({ status: 'sent', messageIds: ['m0', 'm1', 'm2'], chunkCount: 3 });
        expect(contents.map(content => decodeDeliveryCode(content))).toEqual([0, 1, 2].map(part => deliveryTokenFor(item, part)));
        expect(contents.every(content => content.length <= DISCORD_MAX_LENGTH)).toBe(true);
        expect(contents.map((content, part) => content.slice(0, content.length - deliveryCodeFor(deliveryTokenFor(item, part)).length - 1))).toEqual(messageChunksFor(item));
    });

    test('replies with the first part only', async () => {
        const channel = makeSendChannel();
        const { cap } = makeTextCapability({ ready: true, channel, outbox: makeOutbox() });
        const text = 'c'.repeat(2500);

        await cap.sendText(createChannelId('ch-1'), text, { replyToMessageId: REPLY_ID });

        const item = itemFromFirstSend(channel, text, REPLY_ID);
        const chunks = messageChunksFor(item);
        expect(sentPayloads(channel)).toEqual([textPartPayload(item, 0, chunks[0]), textPartPayload(item, 1, chunks[1])]);
        expect(sentPayloads(channel)[1]).not.toHaveProperty('reply');
    });

    test('queues the whole message with its confirmed prefix after an indeterminate part failure', async () => {
        let count = 0;
        const channel = makeSendChannel(async () => {
            count += 1;
            if(count === 2) {
                throw Object.assign(new Error('Service Unavailable'), { status: 503 });
            }
            return { id: 'm0' } as Message;
        });
        const outbox = makeOutbox();
        const { cap, logger } = makeTextCapability({ ready: true, channel, outbox });
        const text = 'd'.repeat(2500);

        const result = await cap.sendText(createChannelId('ch-1'), text, { replyToMessageId: REPLY_ID });

        const item = enqueued(outbox);
        expect(outbox.enqueue).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ status: 'queued', outboxId: item.id, sentMessageIds: ['m0'], chunkCount: 2 });
        expect(item.payload).toEqual({ text, replyToMessageId: REPLY_ID });
        expect(item.progress).toEqual({ attemptCount: 0, deliveryToken: expect.any(String), outcome: 'unknown', lastError: 'Service Unavailable', lastAttemptAt: expect.any(String), deliveredParts: 1 });
        expect(logger.warn).toHaveBeenCalledWith({ error: 'Service Unavailable', channelId: 'ch-1', sentParts: 1 }, 'Discord text send failed');
    });

    test('reports a definitive rejection as failed without queueing it', async () => {
        let count = 0;
        const channel = makeSendChannel(async () => {
            count += 1;
            if(count === 2) {
                throw Object.assign(new Error('Missing Permissions'), { code: 50_013, status: 403 });
            }
            return { id: 'm0' } as Message;
        });
        const outbox = makeOutbox();
        const { cap } = makeTextCapability({ ready: true, channel, outbox });

        const result = await cap.sendText(createChannelId('ch-1'), 'e'.repeat(2500));

        expect(result).toEqual({ status: 'failed', error: 'Missing Permissions', sentMessageIds: ['m0'], chunkCount: 2 });
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    test('response-only definitive failure queues one whole row and replays after the confirmed prefix', async () => {
        let calls = 0;
        const channel = makeSendChannel(async () => {
            calls += 1;
            if(calls === 2) {
                throw Object.assign(new Error('Missing Permissions'), { code: 50_013, status: 403 });
            }
            return { id: 'm0' } as Message;
        });
        const outbox = makeOutbox();
        const { cap } = makeTextCapability({ ready: true, channel, outbox });
        const text = 'e'.repeat(2500);
        const result = await cap.sendText(createChannelId('ch-1'), text, { queueOnDefinitiveFailure: true });
        const item = enqueued(outbox);
        expect(outbox.enqueue).toHaveBeenCalledTimes(1);
        expect(result).toStrictEqual({ status: 'queued', outboxId: item.id, sentMessageIds: ['m0'], chunkCount: 2 });
        expect(item.payload).toStrictEqual({ text });
        expect(item.progress).toStrictEqual({ attemptCount: 0, deliveryToken: expect.any(String), outcome: 'unknown', lastError: 'Missing Permissions', lastAttemptAt: expect.any(String), deliveredParts: 1 });
        const nonce = (sentPayloads(channel)[1] as { nonce: string }).nonce;
        expect(nonce).toBe(deliveryTokenFor(item, 1));
        const replayChannel = makeReplayChannel(ok);
        await replay(replayChannel)(item);
        expect(sentPayloads(replayChannel)).toStrictEqual([textPartPayload(item, 1, messageChunksFor(item)[1])]);
    });

    test('response-only definitive first-part failure queues with no prefix', async () => {
        const outbox = makeOutbox();
        const channel = makeSendChannel(async () => {
            throw Object.assign(new Error('Forbidden'), { status: 403 });
        });
        const { cap } = makeTextCapability({ ready: true, channel, outbox });
        const result = await cap.sendText(createChannelId('ch-1'), 'Hello', { queueOnDefinitiveFailure: true });
        const item = enqueued(outbox);
        expect(result).toStrictEqual({ status: 'queued', outboxId: item.id, sentMessageIds: [], chunkCount: 1 });
        expect(item.progress).toStrictEqual({ attemptCount: 0, deliveryToken: expect.any(String), outcome: 'unknown', lastError: 'Forbidden', lastAttemptAt: expect.any(String), deliveredParts: 0 });
    });

    test('reports a non-Error rejection by its string form', async () => {
        const channel = makeSendChannel(async () => {
            throw 'odd failure';
        });
        const { cap } = makeTextCapability({ ready: true, channel, outbox: makeOutbox() });

        expect(await cap.sendText(createChannelId('ch-1'), 'Hello')).toEqual({ status: 'failed', error: 'odd failure', sentMessageIds: [], chunkCount: 1 });
    });

    test('queues a fresh item without touching Discord when it is not ready', async () => {
        const outbox = makeOutbox();
        const { cap, client } = makeTextCapability({ ready: false, channel: makeSendChannel(), outbox });

        const result = await cap.sendText(createChannelId('ch-1'), 'Hello', { replyToMessageId: REPLY_ID });

        const item = enqueued(outbox);
        expect(client.channels.fetch).not.toHaveBeenCalled();
        expect(result).toEqual({ status: 'queued', outboxId: item.id, sentMessageIds: [], chunkCount: 1 });
        expect(item).toEqual({
            id:          expect.any(String),
            createdAt:   expect.any(String),
            type:        'agent_response',
            service:     'discord',
            destination: createChannelId('ch-1'),
            payload:     { text: 'Hello', replyToMessageId: REPLY_ID },
            priority:    'medium',
            dedupeKey:   expect.any(String),
            progress:    { attemptCount: 0, deliveryToken: expect.stringMatching(/^[0-9a-f]{16}$/) },
            epoch:       0,
        });
    });

    test('queues with no delivered parts when fetching the channel is indeterminate', async () => {
        const outbox = makeOutbox();
        const { cap } = makeTextCapability({ ready: true, outbox, fetch: async () => {
            throw Object.assign(new Error('Bad Gateway'), { status: 502 });
        } });

        const result = await cap.sendText(createChannelId('ch-1'), 'Hello');

        expect(result).toEqual({ status: 'queued', outboxId: enqueued(outbox).id, sentMessageIds: [], chunkCount: 1 });
        expect(enqueued(outbox).progress).toMatchObject({ outcome: 'unknown', deliveredParts: 0, lastError: 'Bad Gateway' });
    });

    test('fails without queueing when the channel cannot receive messages', async () => {
        const outbox = makeOutbox();
        const { cap } = makeTextCapability({ ready: true, channel: { id: 'voice' }, outbox });

        expect(await cap.sendText(createChannelId('ch-1'), 'Hello')).toEqual({ status: 'failed', error: 'Channel ch-1 cannot receive messages', sentMessageIds: [], chunkCount: 1 });
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    test('reports unavailable with its sent prefix when there is no outbox', async () => {
        let count = 0;
        const channel = makeSendChannel(async () => {
            count += 1;
            if(count === 2) {
                throw Object.assign(new Error('Service Unavailable'), { status: 503 });
            }
            return { id: 'm0' } as Message;
        });
        const { cap } = makeTextCapability({ ready: true, channel });

        expect(await cap.sendText(createChannelId('ch-1'), 'f'.repeat(2500))).toEqual({ status: 'unavailable', sentMessageIds: ['m0'], chunkCount: 2 });
    });

    test('reports unavailable without queueing when skipOutbox is set', async () => {
        const outbox = makeOutbox();
        const { cap } = makeTextCapability({ ready: false, outbox });

        expect(await cap.sendText(createChannelId('ch-1'), 'Hello', { skipOutbox: true })).toEqual({ status: 'unavailable', sentMessageIds: [], chunkCount: 1 });
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    test('honours the priority, type, dedupe key and epoch options on the queued item', async () => {
        const outbox = makeOutbox();
        const { cap } = makeTextCapability({ ready: false, outbox });

        await cap.sendText(createChannelId('ch-1'), 'Hello', { priority: 'high', type: 'perch_output', dedupeKey: 'dk', epoch: 4 });

        expect(enqueued(outbox)).toMatchObject({ priority: 'high', type: 'perch_output', dedupeKey: 'dk', epoch: 4, payload: { text: 'Hello' } });
        expect(enqueued(outbox).payload).not.toHaveProperty('replyToMessageId');
        expect(enqueued(outbox)).not.toHaveProperty('origin');
    });

    test('marks a queued reply to a notification turn so its discard notice does not wake Izzy', async () => {
        const outbox = makeOutbox();
        const { cap } = makeTextCapability({ ready: false, outbox });

        await cap.sendText(createChannelId('ch-1'), 'Hello', { origin: 'notification' });

        expect(enqueued(outbox).origin).toBe('notification');
        expect(outboxItemSchema.parse(enqueued(outbox)).origin).toBe('notification');
    });

    test('treats an empty reply id as no reply, so the queued row still parses', async () => {
        const outbox = makeOutbox();
        const channel = makeSendChannel(async () => {
            throw Object.assign(new Error('Service Unavailable'), { status: 503 });
        });
        const { cap } = makeTextCapability({ ready: true, channel, outbox });

        await cap.sendText(createChannelId('ch-1'), 'Hello', { replyToMessageId: '' });

        expect(sentPayloads(channel)[0]).not.toHaveProperty('reply');
        expect(enqueued(outbox).payload).toEqual({ text: 'Hello' });
        expect(enqueued(outbox).payload).not.toHaveProperty('replyToMessageId');
    });

    test('rejects when queueing fails', async () => {
        const outbox = { enqueue: mock(async () => {
            throw new Error('outbox down');
        }) } as unknown as OutboxBackend;
        const { cap } = makeTextCapability({ ready: false, outbox });

        await expect(cap.sendText(createChannelId('ch-1'), 'Hello')).rejects.toThrow('outbox down');
    });

    test('wakes the drainer only after the queued item is written, since Discord may stay online', async () => {
        const written = Promise.withResolvers<undefined>();
        const outbox = { enqueue: mock(() => written.promise) } as unknown as OutboxBackend;
        const onQueued = mock(() => undefined);
        const channel = makeSendChannel(async () => {
            throw Object.assign(new Error('Service Unavailable'), { status: 503 });
        });
        const { cap } = makeTextCapability({ ready: true, channel, outbox, onQueued });

        const sending = cap.sendText(createChannelId('ch-1'), 'Hello');
        for(let tick = 0; tick < 10; tick++) {
            // eslint-disable-next-line no-await-in-loop -- flush the send's microtasks up to the pending outbox write
            await Promise.resolve();
        }
        expect(outbox.enqueue).toHaveBeenCalledTimes(1);
        expect(onQueued).not.toHaveBeenCalled();
        written.resolve(undefined);

        await expect(sending).resolves.toMatchObject({ status: 'queued' });
        expect(onQueued).toHaveBeenCalledTimes(1);
    });

    test('does not wake the drainer when the text was sent', async () => {
        const onQueued = mock(() => undefined);
        const { cap } = makeTextCapability({ ready: true, channel: makeSendChannel(), outbox: makeOutbox(), onQueued });

        await expect(cap.sendText(createChannelId('ch-1'), 'Hello')).resolves.toMatchObject({ status: 'sent' });
        expect(onQueued).not.toHaveBeenCalled();
    });
});

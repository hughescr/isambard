import { afterEach, describe, test, expect, mock, spyOn } from 'bun:test';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client, type Message, type TextChannel } from 'discord.js';
import { createChannelId } from '../../../../src/agent/types';
import { ChannelNotFoundByIdError } from '../../../../src/errors';
import { DiscordCapabilityImpl, type DiscordCapability, type DiscordCapabilityDeps, type DiscordCapabilityLogger, type SendOptions } from '../../../../src/integrations/discord/capability';
import { DISCORD_MAX_LENGTH } from '../../../../src/integrations/discord/messages';
import { createOutboxReplayDeliverFn, DELIVERY_TOKEN_MAX_LENGTH, deliveryTokenFor } from '../../../../src/integrations/discord/outbox-replay';
import { appendDeliveryCode, decodeDeliveryCode, maxContentLengthForDeliveryCode } from '../../../../src/integrations/discord/zero-width-delivery-code';
import type { ServiceHealthRegistry } from '../../../../src/services/health-registry';
import type { OutboxBackend, OutboxItem } from '../../../../src/services/outbox';

afterEach(() => {
    mock.restore();
});

describe('DiscordCapability ID contracts', () => {
    test('rejects unvalidated strings for both send and fetch', () => {
        // @ts-expect-error -- the send port requires a validated ChannelId
        const sendId: Parameters<DiscordCapability['sendToChannel']>[0] = 'raw';
        // @ts-expect-error -- the fetch port requires a validated ChannelId
        const fetchId: Parameters<DiscordCapability['fetchChannel']>[0] = 'raw';
        expect([String(sendId), String(fetchId)]).toEqual(['raw', 'raw']);
    });
});

// ---- factory helpers ----

function makeRegistry(discordAvailable: boolean): ServiceHealthRegistry {
    return {
        isAvailable:        mock((svc: string) => svc === 'discord' && discordAvailable),
        getEntry:           mock(() => ({ state: 'offline' as const, epoch: 0, failureCount: 0 })),
        getState:           mock(() => 'offline' as const),
        getAll:             mock(() => ({}) as ReturnType<ServiceHealthRegistry['getAll']>),
        sendEvent:          mock(() => undefined),
        subscribe:          mock(() => () => undefined),
        buildStatusSummary: mock(() => undefined),
        stop:               mock(() => undefined),
    };
}

function makeLogger(): DiscordCapabilityLogger {
    return {
        warn:  mock(() => undefined),
        error: mock(() => undefined),
        info:  mock(() => undefined),
    };
}

function makeOutboxBackend(): OutboxBackend {
    return {
        enqueue: mock(async (_item: OutboxItem) => undefined),
    } as unknown as OutboxBackend;
}

function makeOutboxItem(overrides: Partial<OutboxItem>): OutboxItem {
    return {
        id:          'aaaaaaaa-1111-4222-8333-444444444444',
        createdAt:   '2026-09-22T12:00:00.000Z',
        type:        'email_approval',
        service:     'discord',
        destination: createChannelId('ch-1'),
        payload:     {},
        priority:    'medium',
        dedupeKey:   'dedupe',
        progress:    { attemptCount: 0 },
        epoch:       0,
        ...overrides,
    };
}

function makeChannel(sendFn?: (...args: unknown[]) => Promise<Message>): TextChannel {
    return {
        send: mock(sendFn ?? (async (_content: unknown): Promise<Message> => ({
            id:      'msg-123',
            content: 'sent!',
        } as unknown as Message))),
    } as unknown as TextChannel;
}

function makeClient(channel?: TextChannel | null): Client {
    return {
        channels: {
            fetch: mock(async (_id: string) => channel),
        },
    } as unknown as Client;
}

function makeCapability(
    registryAvailable: boolean,
    outboxBackend?: OutboxBackend
): { cap: DiscordCapabilityImpl, registry: ServiceHealthRegistry, logger: DiscordCapabilityLogger } {
    const registry = makeRegistry(registryAvailable);
    const logger   = makeLogger();
    const deps: DiscordCapabilityDeps = {
        registry,
        logger,
        ...(outboxBackend === undefined ? {} : { outboxBackend }),
    };
    const cap = new DiscordCapabilityImpl(deps);
    return { cap, registry, logger };
}

// ---- outbox delivery token ----

describe('deliveryTokenFor', () => {
    test('caps its longest token at the shared delivery-code budget length', () => {
        const item = makeOutboxItem({ progress: { attemptCount: 0, deliveryToken: '1234567890abcdefgh' } });

        expect(deliveryTokenFor(item, 35)).toBe('iz1234567890abcdefg00000z');
        expect(deliveryTokenFor(item, 35)).toHaveLength(DELIVERY_TOKEN_MAX_LENGTH);
    });

    test('never produces a token longer than Discord\'s 25-character nonce limit', () => {
        const item = makeOutboxItem({ progress: { attemptCount: 0, deliveryToken: 'x'.repeat(100) } });

        expect(deliveryTokenFor(item, 35)).toHaveLength(25);
        expect(deliveryTokenFor(item, 35).length).toBeLessThanOrEqual(25);
    });

    test('falls back to the first sixteen hyphen-free id characters when delivery token is absent', () => {
        const item = makeOutboxItem({ progress: { attemptCount: 0 } });

        expect(deliveryTokenFor(item, 35)).toBe('izaaaaaaaa1111422200000z');
    });
});

// ---- setClient / isReady ----

describe('DiscordCapabilityImpl.isReady', () => {
    test('returns false when no client set', () => {
        const { cap } = makeCapability(true);
        expect(cap.isReady()).toBe(false);
    });

    test('returns false when client set but registry says discord unavailable', () => {
        const { cap } = makeCapability(false);
        cap.setClient(makeClient());
        expect(cap.isReady()).toBe(false);
    });

    test('returns true when client set AND registry says available', () => {
        const { cap } = makeCapability(true);
        cap.setClient(makeClient());
        expect(cap.isReady()).toBe(true);
    });
});

describe('DiscordCapabilityImpl.setClient', () => {
    test('sets the client reference so isReady changes', () => {
        const { cap } = makeCapability(true);
        expect(cap.isReady()).toBe(false);
        cap.setClient(makeClient());
        expect(cap.isReady()).toBe(true);
    });
});

// ---- sendToChannel ----

describe('DiscordCapabilityImpl.sendToChannel', () => {
    test('when ready and channel found: sends string content, returns {status: sent, message}', async () => {
        const sentMessage = { id: 'msg-abc' } as unknown as Message;
        const channel = makeChannel(async () => sentMessage);
        const client  = makeClient(channel);
        const { cap } = makeCapability(true);
        cap.setClient(client);

        const result = await cap.sendToChannel(createChannelId('channel-1'), 'Hello world');
        expect(result.status).toBe('sent');
        if(result.status === 'sent') {
            expect(result.message).toBe(sentMessage);
        }
        expect(channel.send).toHaveBeenCalledWith('Hello world');
    });

    test('when ready and channel found: sends object content (embeds/components)', async () => {
        const sentMessage = { id: 'msg-embed' } as unknown as Message;
        const channel = makeChannel(async () => sentMessage);
        const client  = makeClient(channel);
        const { cap } = makeCapability(true);
        cap.setClient(client);

        const content = { content: 'text', embeds: [], components: [] };
        const result  = await cap.sendToChannel(createChannelId('channel-1'), content);
        expect(result.status).toBe('sent');
    });

    test('when ready but channel returns null: returns {status: unavailable}', async () => {
        const client = makeClient(null);
        const { cap } = makeCapability(true);
        cap.setClient(client);

        const result = await cap.sendToChannel(createChannelId('channel-1'), 'Hi');
        expect(result.status).toBe('unavailable');
    });

    test('when ready but channel is not text-sendable: returns {status: unavailable}', async () => {
        // A channel object without a `send` method
        const voiceChannel = { id: 'voice-1' } as unknown as TextChannel;
        const client = makeClient(voiceChannel);
        const { cap } = makeCapability(true);
        cap.setClient(client);

        const result = await cap.sendToChannel(createChannelId('channel-1'), 'Hi');
        expect(result.status).toBe('unavailable');
    });

    test('when outboxable content is sent immediately: appends only its invisible code and nonce', async () => {
        const channel = makeChannel();
        const client  = makeClient(channel);
        const { cap } = makeCapability(true, makeOutboxBackend());
        cap.setClient(client);

        await cap.sendToChannel(createChannelId('channel-1'), 'Hello');

        const payload = (channel.send as ReturnType<typeof mock>).mock.calls[0]?.[0] as { content: string, nonce: string, enforceNonce: boolean };
        expect(decodeDeliveryCode(payload.content)).toBe(payload.nonce);
        expect(payload.content).not.toContain(`[${payload.nonce}]`);
        expect(payload.enforceNonce).toBe(true);
    });

    test('queues outboxable text that would exceed Discord length after its invisible code', async () => {
        const channel = makeChannel();
        const outbox = makeOutboxBackend();
        const { cap } = makeCapability(true, outbox);
        cap.setClient(makeClient(channel));
        const token = deliveryTokenFor(makeOutboxItem({ progress: { attemptCount: 0, deliveryToken: 'lengthboundary' } }), 0);

        const result = await cap.sendToChannel(createChannelId('channel-1'), 'a'.repeat(maxContentLengthForDeliveryCode(token) + 1));

        expect(result.status).toBe('queued');
        expect(channel.send).not.toHaveBeenCalled();
        expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    });

    test('sends outboxable text exactly at the delivery-code budget instead of queuing it', async () => {
        const randomUuid = spyOn(crypto, 'randomUUID');
        randomUuid.mockReturnValueOnce('11111111-2222-4333-8444-555555555555');
        randomUuid.mockReturnValueOnce('22222222-3333-4444-8555-666666666666');
        randomUuid.mockReturnValueOnce('12345678-90ab-cdef-1234-567890abcdef');
        const channel = makeChannel();
        const outbox = makeOutboxBackend();
        const { cap } = makeCapability(true, outbox);
        cap.setClient(makeClient(channel));
        const token = 'iz1234567890abcdef000000';

        const result = await cap.sendToChannel(createChannelId('channel-1'), 'a'.repeat(maxContentLengthForDeliveryCode(token)));

        expect(result.status).toBe('sent');
        expect(channel.send).toHaveBeenCalledWith({ content: appendDeliveryCode('a'.repeat(maxContentLengthForDeliveryCode(token)), token), nonce: token, enforceNonce: true });
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    test('when ready but send throws: falls back to outbox, returns {status: queued}', async () => {
        const channel = makeChannel(async () => {
            throw new Error('Discord error');
        });
        const client  = makeClient(channel);
        const outbox  = makeOutboxBackend();
        const { cap, logger } = makeCapability(true, outbox);
        cap.setClient(client);

        const result = await cap.sendToChannel(createChannelId('channel-1'), 'Hello');
        expect(result.status).toBe('queued');
        expect(outbox.enqueue).toHaveBeenCalledTimes(1);
        expect((outbox.enqueue as ReturnType<typeof mock>).mock.calls[0]?.[0]).toMatchObject({
            destination: 'channel-1',
            payload:     { text: 'Hello' },
            progress:    { attemptCount: 0, outcome: 'unknown', lastError: 'Discord error', deliveryToken: expect.any(String) },
        });
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith({ error: 'Discord error', channelId: 'channel-1' }, 'Discord send failed, attempting outbox queue');
    });

    test('wakes the drainer only after a failed send is queued, since Discord may stay online', async () => {
        const written = Promise.withResolvers<undefined>();
        const outbox = { enqueue: mock(() => written.promise) } as unknown as OutboxBackend;
        const onQueued = mock(() => undefined);
        const cap = new DiscordCapabilityImpl({ registry: makeRegistry(true), logger: makeLogger(), outboxBackend: outbox, onQueued });
        cap.setClient(makeClient(makeChannel(async () => {
            throw new Error('Discord error');
        })));

        const sending = cap.sendToChannel(createChannelId('channel-1'), 'Hello');
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

    test('does not wake the drainer when the send succeeds', async () => {
        const onQueued = mock(() => undefined);
        const cap = new DiscordCapabilityImpl({ registry: makeRegistry(true), logger: makeLogger(), outboxBackend: makeOutboxBackend(), onQueued });
        cap.setClient(makeClient(makeChannel()));

        await expect(cap.sendToChannel(createChannelId('channel-1'), 'Hello')).resolves.toMatchObject({ status: 'sent' });
        expect(onQueued).not.toHaveBeenCalled();
    });

    test('when not ready: queues to outbox, returns {status: queued}', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);
        // No client set → not ready

        const result = await cap.sendToChannel(createChannelId('channel-1'), 'Hello');
        expect(result.status).toBe('queued');
        expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    });

    test('when not ready and no outbox: returns {status: unavailable}', async () => {
        const { cap } = makeCapability(false);
        // No client, no outbox

        const result = await cap.sendToChannel(createChannelId('channel-1'), 'Hello');
        expect(result.status).toBe('unavailable');
    });

    test('when not ready with skipOutbox=true: returns {status: unavailable}', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        const result = await cap.sendToChannel(createChannelId('channel-1'), 'Hello', { skipOutbox: true });
        expect(result.status).toBe('unavailable');
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    test('when send fails with skipOutbox=true: returns {status: unavailable} without queuing', async () => {
        const channel = makeChannel(async () => {
            throw new Error('fail');
        });
        const client  = makeClient(channel);
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(true, outbox);
        cap.setClient(client);

        const result = await cap.sendToChannel(createChannelId('channel-1'), 'Hello', { skipOutbox: true });
        expect(result.status).toBe('unavailable');
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    test('outbox item has correct service=discord and destination=channelId', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel(createChannelId('my-channel-42'), 'Test content');
        const calls  = (outbox.enqueue as ReturnType<typeof mock>).mock.calls;
        expect(calls).toHaveLength(1);
        const item   = calls[0][0] as OutboxItem;
        expect(item.service).toBe('discord');
        expect(item.destination).toBe(createChannelId('my-channel-42'));
    });

    test('outbox item default type is agent_response', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel(createChannelId('ch-1'), 'Hello');
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.type).toBe('agent_response');
    });

    test('outbox item custom type overrides default', async () => {
        const outbox   = makeOutboxBackend();
        const { cap }  = makeCapability(false, outbox);
        const options: SendOptions = { type: 'perch_output' };

        await cap.sendToChannel(createChannelId('ch-1'), 'Hello', options);
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.type).toBe('perch_output');
    });

    test('outbox item default priority is medium', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel(createChannelId('ch-1'), 'Hello');
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.priority).toBe('medium');
    });

    test('outbox item custom priority overrides default', async () => {
        const outbox   = makeOutboxBackend();
        const { cap }  = makeCapability(false, outbox);
        const options: SendOptions = { priority: 'high' };

        await cap.sendToChannel(createChannelId('ch-1'), 'Hello', options);
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.priority).toBe('high');
    });

    test('outbox item has valid uuid id and ISO createdAt', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel(createChannelId('ch-1'), 'Hello');
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.id).toMatch(/^[0-9a-f-]{36}$/u);
        expect(new Date(item.createdAt).toISOString()).toBe(item.createdAt);
    });

    test('uses exactly sixteen hyphen-free UUID characters as the generated delivery token', async () => {
        const randomUuid = spyOn(crypto, 'randomUUID');
        randomUuid.mockReturnValueOnce('11111111-2222-4333-8444-555555555555');
        randomUuid.mockReturnValueOnce('22222222-3333-4444-8555-666666666666');
        randomUuid.mockReturnValueOnce('12345678-90ab-cdef-1234-567890abcdef');
        const outbox = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel(createChannelId('ch-1'), 'Hello');

        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item).toMatchObject({
            id:        '11111111-2222-4333-8444-555555555555',
            dedupeKey: '22222222-3333-4444-8555-666666666666',
            progress:  { attemptCount: 0, deliveryToken: '1234567890abcdef' },
        });
        expect(randomUuid).toHaveBeenCalledTimes(3);
    });

    test('outbox item custom epoch overrides default 0', async () => {
        const outbox   = makeOutboxBackend();
        const { cap }  = makeCapability(false, outbox);
        const options: SendOptions = { epoch: 5 };

        await cap.sendToChannel(createChannelId('ch-1'), 'Hello', options);
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.epoch).toBe(5);
    });

    test('outbox item default epoch is 0', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel(createChannelId('ch-1'), 'Hello');
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.epoch).toBe(0);
    });

    test('generates a dedupeKey when no key is supplied', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel(createChannelId('ch-1'), 'Hello');

        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.dedupeKey).toMatch(/^[0-9a-f-]{36}$/u);
    });

    test('custom dedupeKey is preserved on outbox item', async () => {
        const outbox   = makeOutboxBackend();
        const { cap }  = makeCapability(false, outbox);
        const options: SendOptions = { dedupeKey: 'my-custom-key' };

        await cap.sendToChannel(createChannelId('ch-1'), 'Hello', options);
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.dedupeKey).toBe('my-custom-key');
    });

    test('string content maps to payload.text', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel(createChannelId('ch-1'), 'my text content');
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.payload.text).toBe('my text content');
    });

    test('object content maps payload fields', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);
        const embed = new EmbedBuilder().setTitle('Approval needed');
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('approve').setLabel('Approve').setStyle(ButtonStyle.Success)
        );

        await cap.sendToChannel(createChannelId('ch-1'), { content: 'object text', embeds: [embed], components: [row] });
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.payload.text).toBe('object text');
        expect(item.payload.embeds).toEqual([embed.toJSON()]);
        expect(item.payload.components).toEqual([row.toJSON()]);
    });

    test('queues object content without embeds or components', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel(createChannelId('ch-1'), { content: 'object text' });

        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.payload).toEqual({ text: 'object text' });
        expect(item.payload.embeds).toBeUndefined();
        expect(item.payload.components).toBeUndefined();
    });

    test('queued result returns outboxId matching the item id', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        const result = await cap.sendToChannel(createChannelId('ch-1'), 'Hello');
        const item   = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(result.status).toBe('queued');
        expect(item.progress.attemptCount).toBe(0);
        if(result.status === 'queued') {
            expect(result.outboxId).toBe(item.id);
        }
    });

    test('when the outbox enqueue fails: sendToChannel rejects instead of reporting queued', async () => {
        const failure = new Error('outbox down');
        const enqueueRejection = Promise.reject(failure);
        // Keep the shared rejected promise handled: the AwaitDrop mutant discards
        // this promise, and an unhandled rejection would mask the assertion below.
        void enqueueRejection.catch(() => undefined);
        const outbox = { enqueue: mock(() => enqueueRejection) } as unknown as OutboxBackend;
        const { cap } = makeCapability(false, outbox);

        await expect(cap.sendToChannel(createChannelId('ch-1'), 'Hello')).rejects.toThrow('outbox down');
    });

    test('queues builder content as JSON-serialisable Discord API data', async () => {
        const outbox = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);
        const embed = new EmbedBuilder().setTitle('Approval needed');
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('approve').setLabel('Approve').setStyle(ButtonStyle.Success)
        );

        await cap.sendToChannel(createChannelId('ch-1'), { embeds: [embed], components: [row] });

        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.payload.embeds).toEqual([embed.toJSON()]);
        expect(item.payload.components).toEqual([row.toJSON()]);
        expect(item.payload.embeds?.[0]).not.toBeInstanceOf(EmbedBuilder);
        expect(item.payload.components?.[0]).not.toBeInstanceOf(ActionRowBuilder);
        // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON round trip verifies durable JSON serialisability, not cloning.
        expect(JSON.parse(JSON.stringify(item.payload))).toEqual(item.payload);
    });
});

describe('createOutboxReplayDeliverFn', () => {
    test('sends text chunks first, then embeds and components in one message', async () => {
        const channel = makeChannel();
        const fetchChannel = mock(async () => channel);
        const deliver = createOutboxReplayDeliverFn({ fetchChannel, notify: mock(() => true) });
        const components = [{
            type:       1,
            components: [{ type: 2, custom_id: 'approve', label: 'Approve', style: 3 }],
        }];
        const embeds = [{ title: 'Approval needed' }];
        const item = makeOutboxItem({ payload: { text: 'Hello', embeds, components } });

        await deliver(item);

        expect(channel.send).toHaveBeenCalledTimes(2);
        expect(channel.send).toHaveBeenNthCalledWith(1, { content: appendDeliveryCode('Hello', deliveryTokenFor(item, 0)), nonce: deliveryTokenFor(item, 0), enforceNonce: true });
        expect(channel.send).toHaveBeenNthCalledWith(2, { embeds, components, content: appendDeliveryCode('', deliveryTokenFor(item, 1)), nonce: deliveryTokenFor(item, 1), enforceNonce: true });
    });

    test('sends components when the queued item has no embeds', async () => {
        const channel = makeChannel();
        const deliver = createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) });
        const components = [{
            type:       1,
            components: [{ type: 2, custom_id: 'approve', label: 'Approve', style: 3 }],
        }];

        const item = makeOutboxItem({ payload: { components } });
        await deliver(item);

        expect(channel.send).toHaveBeenCalledWith({ embeds: undefined, components, content: appendDeliveryCode('', deliveryTokenFor(item, 0)), nonce: deliveryTokenFor(item, 0), enforceNonce: true });
    });

    test('sends text-only queued items exactly once', async () => {
        const channel = makeChannel();
        const deliver = createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) });

        const item = makeOutboxItem({ payload: { text: 'Hello' } });
        await deliver(item);

        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(channel.send).toHaveBeenCalledWith({ content: appendDeliveryCode('Hello', deliveryTokenFor(item, 0)), nonce: deliveryTokenFor(item, 0), enforceNonce: true });
    });

    test('sends embeds when the queued item has no components', async () => {
        const channel = makeChannel();
        const deliver = createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) });
        const embeds = [{ title: 'Approval needed' }];

        const item = makeOutboxItem({ payload: { embeds } });
        await deliver(item);

        expect(channel.send).toHaveBeenCalledWith({ embeds, components: undefined, content: appendDeliveryCode('', deliveryTokenFor(item, 0)), nonce: deliveryTokenFor(item, 0), enforceNonce: true });
    });

    test('keeps every replayed chunk within the Discord UTF-16 content limit after its code is appended', async () => {
        const channel = makeChannel();
        const deliver = createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) });
        const item = makeOutboxItem({ progress: { attemptCount: 0, deliveryToken: 'boundarytoken' }, payload: {} });
        const firstToken = deliveryTokenFor(item, 0);
        item.payload = { text: 'a'.repeat(maxContentLengthForDeliveryCode(firstToken) + 1) };

        await deliver(item);

        const sent = (channel.send as ReturnType<typeof mock>).mock.calls.map(call => call[0] as { content: string, nonce: string });
        expect(sent).toHaveLength(2);
        expect(sent[0]?.content).toHaveLength(DISCORD_MAX_LENGTH);
        expect(sent.every(payload => payload.content.length <= DISCORD_MAX_LENGTH)).toBe(true);
        expect(sent.map(payload => decodeDeliveryCode(payload.content))).toEqual([deliveryTokenFor(item, 0), deliveryTokenFor(item, 1)]);
        expect(sent.map(payload => payload.nonce)).toEqual([deliveryTokenFor(item, 0), deliveryTokenFor(item, 1)]);
    });

    test('rejects when sending a text chunk fails', async () => {
        const channel = makeChannel(async () => {
            throw new Error('Missing Permissions');
        });
        const deliver = createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) });

        await expect(deliver(makeOutboxItem({ payload: { text: 'Hello' } }))).rejects.toThrow('Missing Permissions');
    });

    test('rejects when sending the embeds and components fails', async () => {
        const channel = makeChannel(async () => {
            throw new Error('Missing Permissions');
        });
        const deliver = createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) });

        await expect(deliver(makeOutboxItem({ payload: { embeds: [{ title: 'Approval needed' }] } }))).rejects.toThrow('Missing Permissions');
    });

    test('rejects when the queued destination cannot be fetched', async () => {
        const deliver = createOutboxReplayDeliverFn({ fetchChannel: mock(async () => null), notify: mock(() => true) });

        await expect(deliver(makeOutboxItem({}))).rejects.toThrow(ChannelNotFoundByIdError);
    });

    test('acknowledges an unknown delivery found by its invisible code without resending', async () => {
        const item = makeOutboxItem({ progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: 'knownmarker' }, payload: { text: 'Hello' } });
        const send = mock(async (): Promise<Message> => ({ id: 'duplicate' } as Message));
        const fetch = mock(async () => new Map([['message-1', { content: appendDeliveryCode('Hello', deliveryTokenFor(item, 0)) }]]));
        const channel = { send, messages: { fetch } } as unknown as TextChannel;

        await createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) })(item);

        expect(fetch).toHaveBeenCalledWith({ limit: 100 });
        expect(send).not.toHaveBeenCalled();
    });

    test('does not acknowledge an unknown text and component delivery until every code is present', async () => {
        const components = [{ type: 1, components: [{ type: 2, custom_id: 'approve', label: 'Approve', style: 3 }] }];
        const item = makeOutboxItem({ progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: 'textandcomponents' }, payload: { text: 'Hello', components } });
        const send = mock(async (): Promise<Message> => ({ id: 'replacement' } as Message));
        const fetch = mock(async () => new Map([['message-1', { content: appendDeliveryCode('Hello', deliveryTokenFor(item, 0)) }]]));
        const channel = { send, messages: { fetch } } as unknown as TextChannel;

        await createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) })(item);

        expect(fetch).toHaveBeenCalledWith({ limit: 100 });
        // Part 0's code is present, so only the missing component part is sent: part 0 is never duplicated.
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({ embeds: undefined, components, content: appendDeliveryCode('', deliveryTokenFor(item, 1)), nonce: deliveryTokenFor(item, 1), enforceNonce: true });
    });

    test('does not acknowledge an unknown text and single-embed delivery until the embed code is present', async () => {
        const embeds = [{ title: 'Approval needed' }];
        const item = makeOutboxItem({ progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: 'textandembed' }, payload: { text: 'Hello', embeds } });
        const send = mock(async (): Promise<Message> => ({ id: 'replacement' } as Message));
        const fetch = mock(async () => new Map([['message-1', { content: appendDeliveryCode('Hello', deliveryTokenFor(item, 0)) }]]));
        const channel = { send, messages: { fetch } } as unknown as TextChannel;

        await createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) })(item);

        expect(fetch).toHaveBeenCalledWith({ limit: 100 });
        // Part 0's code is present, so only the missing embed part is sent: part 0 is never duplicated.
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({ embeds, components: undefined, content: appendDeliveryCode('', deliveryTokenFor(item, 1)), nonce: deliveryTokenFor(item, 1), enforceNonce: true });
    });

    test('retries an unknown delivery after successful history proves its code absent', async () => {
        const item = makeOutboxItem({ progress: { attemptCount: 1, outcome: 'unknown', deliveryToken: 'missingmarker' }, payload: { text: 'Hello' } });
        const send = mock(async (): Promise<Message> => ({ id: 'replacement' } as Message));
        const fetch = mock(async () => new Map());
        const channel = { send, messages: { fetch } } as unknown as TextChannel;

        await createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) })(item);

        expect(fetch).toHaveBeenCalledWith({ limit: 100 });
        expect(send).toHaveBeenCalledWith({ content: appendDeliveryCode('Hello', deliveryTokenFor(item, 0)), nonce: deliveryTokenFor(item, 0), enforceNonce: true });
    });

    test('defers an unknown delivery when history cannot be fetched', async () => {
        const item = makeOutboxItem({ progress: { attemptCount: 1, outcome: 'unknown' } });
        const fetch = mock(async (): Promise<Map<string, never>> => {
            throw new Error('history unavailable');
        });
        const channel = { send: mock(async (): Promise<Message> => ({ id: 'unexpected' } as Message)), messages: { fetch } } as unknown as TextChannel;

        await expect(createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) })(item)).rejects.toThrow('Discord delivery verification remains indeterminate');
        expect(channel.send).not.toHaveBeenCalled();
    });

    test('marks exhausted transport send retries as an indeterminate delivery', async () => {
        const channel = makeChannel(async () => {
            const error = new Error('request timed out');
            error.name = 'AbortError';
            throw error;
        });

        await expect(createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) })(makeOutboxItem({ payload: { text: 'Hello' } }))).rejects.toThrow('Discord delivery verification remains indeterminate');
    });

    test('marks an ambiguous server error as indeterminate instead of classifying it', async () => {
        const channel = makeChannel(async () => {
            throw Object.assign(new Error('Discord gateway timeout'), { status: 504 });
        });

        await expect(createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) })(makeOutboxItem({ payload: { text: 'Hello' } }))).rejects.toThrow('Discord delivery verification remains indeterminate');
    });

    test('marks status 500 as indeterminate but preserves a status 499 error', async () => {
        const serverChannel = makeChannel(async () => {
            throw Object.assign(new Error('Discord server error'), { status: 500 });
        });
        const clientChannel = makeChannel(async () => {
            throw Object.assign(new Error('Discord client error'), { status: 499 });
        });

        await expect(createOutboxReplayDeliverFn({ fetchChannel: mock(async () => serverChannel), notify: mock(() => true) })(makeOutboxItem({ payload: { text: 'Hello' } }))).rejects.toThrow('Discord delivery verification remains indeterminate');
        await expect(createOutboxReplayDeliverFn({ fetchChannel: mock(async () => clientChannel), notify: mock(() => true) })(makeOutboxItem({ payload: { text: 'Hello' } }))).rejects.toThrow('Discord client error');
        expect(clientChannel.send).toHaveBeenCalledTimes(1);
    });

    test('preserves a null send rejection without trying to read a status from it', async () => {
        const channel = makeChannel(async () => {
            throw null;
        });

        await expect(createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) })(makeOutboxItem({ payload: { text: 'Hello' } }))).rejects.toBeNull();
    });

    test('preserves an undefined send rejection without trying to read a status from it', async () => {
        const channel = makeChannel(async () => {
            throw undefined;
        });

        await expect(createOutboxReplayDeliverFn({ fetchChannel: mock(async () => channel), notify: mock(() => true) })(makeOutboxItem({ payload: { text: 'Hello' } }))).rejects.toBeUndefined();
        expect(channel.send).toHaveBeenCalledTimes(1);
    });
});

// ---- fetchChannel ----

describe('DiscordCapabilityImpl.fetchChannel', () => {
    test('when ready and text-sendable: returns the channel', async () => {
        const channel = makeChannel();
        const client  = makeClient(channel);
        const { cap } = makeCapability(true);
        cap.setClient(client);

        const result = await cap.fetchChannel(createChannelId('ch-1'));
        expect(result).toBe(channel);
    });

    test('when ready but channel not text-sendable: returns null', async () => {
        const voiceChannel = { id: 'voice-1' } as unknown as TextChannel;
        const client = makeClient(voiceChannel);
        const { cap } = makeCapability(true);
        cap.setClient(client);

        const result = await cap.fetchChannel(createChannelId('ch-1'));
        expect(result).toBeNull();
    });

    test('when not ready (no client): returns null', async () => {
        const { cap } = makeCapability(true);
        // No setClient called

        const result = await cap.fetchChannel(createChannelId('ch-1'));
        expect(result).toBeNull();
    });

    test('when not ready (registry says unavailable): returns null', async () => {
        const channel = makeChannel();
        const client  = makeClient(channel);
        const { cap } = makeCapability(false);
        cap.setClient(client);

        const result = await cap.fetchChannel(createChannelId('ch-1'));
        expect(result).toBeNull();
    });

    test('when fetch throws: returns null', async () => {
        const errorClient = {
            channels: {
                fetch: mock(async () => {
                    throw new Error('network error');
                }),
            },
        } as unknown as Client;
        const { cap, logger } = makeCapability(true);
        cap.setClient(errorClient);

        const result = await cap.fetchChannel(createChannelId('ch-1'));
        expect(result).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith({ error: 'network error', channelId: 'ch-1' }, 'Discord fetchChannel failed, returning null');
    });

    test('when fetch throws: logs a warning', async () => {
        const errorClient = {
            channels: {
                fetch: mock(async () => {
                    throw new Error('fetch failed');
                }),
            },
        } as unknown as Client;
        const { cap, logger } = makeCapability(true);
        cap.setClient(errorClient);

        await cap.fetchChannel(createChannelId('ch-1'));
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    test('fetches the channel using the requested channel id', async () => {
        const channel = makeChannel();
        const client  = makeClient(channel);
        const { cap } = makeCapability(true);
        cap.setClient(client);

        await cap.fetchChannel(createChannelId('ch-42'));
        expect(client.channels.fetch).toHaveBeenCalledWith('ch-42');
    });
});

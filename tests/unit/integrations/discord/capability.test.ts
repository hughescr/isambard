import { describe, test, expect, mock } from 'bun:test';
import type { Client, Message, TextChannel } from 'discord.js';
import { DiscordCapabilityImpl, type DiscordCapabilityDeps, type DiscordCapabilityLogger, type SendOptions } from '../../../../src/integrations/discord/capability';
import type { ServiceHealthRegistry } from '../../../../src/services/health-registry';
import type { OutboxBackend, OutboxItem } from '../../../../src/services/outbox';

// ---- factory helpers ----

function makeRegistry(discordAvailable: boolean): ServiceHealthRegistry {
    return {
        isAvailable:        mock((svc: string) => svc === 'discord' && discordAvailable),
        getEntry:           mock(() => ({ state: 'offline' as const, epoch: 0, failureCount: 0 })),
        getState:           mock(() => 'offline' as const),
        getAll:             mock(() => ({}) as ReturnType<ServiceHealthRegistry['getAll']>),
        isWriteAvailable:   mock(() => false),
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

        const result = await cap.sendToChannel('channel-1', 'Hello world');
        expect(result.status).toBe('sent');
        if(result.status === 'sent') {
            expect(result.message).toBe(sentMessage);
        }
    });

    test('when ready and channel found: sends object content (embeds/components)', async () => {
        const sentMessage = { id: 'msg-embed' } as unknown as Message;
        const channel = makeChannel(async () => sentMessage);
        const client  = makeClient(channel);
        const { cap } = makeCapability(true);
        cap.setClient(client);

        const content = { content: 'text', embeds: [], components: [] };
        const result  = await cap.sendToChannel('channel-1', content);
        expect(result.status).toBe('sent');
    });

    test('when ready but channel returns null: returns {status: unavailable}', async () => {
        const client = makeClient(null);
        const { cap } = makeCapability(true);
        cap.setClient(client);

        const result = await cap.sendToChannel('channel-1', 'Hi');
        expect(result.status).toBe('unavailable');
    });

    test('when ready but channel is not text-sendable: returns {status: unavailable}', async () => {
        // A channel object without a `send` method
        const voiceChannel = { id: 'voice-1' } as unknown as TextChannel;
        const client = makeClient(voiceChannel);
        const { cap } = makeCapability(true);
        cap.setClient(client);

        const result = await cap.sendToChannel('channel-1', 'Hi');
        expect(result.status).toBe('unavailable');
    });

    test('when ready but send throws: falls back to outbox, returns {status: queued}', async () => {
        const channel = makeChannel(async () => {
            throw new Error('Discord error');
        });
        const client  = makeClient(channel);
        const outbox  = makeOutboxBackend();
        const { cap, logger } = makeCapability(true, outbox);
        cap.setClient(client);

        const result = await cap.sendToChannel('channel-1', 'Hello');
        expect(result.status).toBe('queued');
        expect(outbox.enqueue).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    test('when not ready: queues to outbox, returns {status: queued}', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);
        // No client set → not ready

        const result = await cap.sendToChannel('channel-1', 'Hello');
        expect(result.status).toBe('queued');
        expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    });

    test('when not ready and no outbox: returns {status: unavailable}', async () => {
        const { cap } = makeCapability(false);
        // No client, no outbox

        const result = await cap.sendToChannel('channel-1', 'Hello');
        expect(result.status).toBe('unavailable');
    });

    test('when not ready with skipOutbox=true: returns {status: unavailable}', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        const result = await cap.sendToChannel('channel-1', 'Hello', { skipOutbox: true });
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

        const result = await cap.sendToChannel('channel-1', 'Hello', { skipOutbox: true });
        expect(result.status).toBe('unavailable');
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    test('outbox item has correct service=discord and destination=channelId', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel('my-channel-42', 'Test content');
        const calls  = (outbox.enqueue as ReturnType<typeof mock>).mock.calls;
        expect(calls.length).toBe(1);
        const item   = calls[0][0] as OutboxItem;
        expect(item.service).toBe('discord');
        expect(item.destination).toBe('my-channel-42');
    });

    test('outbox item default type is agent_response', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel('ch-1', 'Hello');
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.type).toBe('agent_response');
    });

    test('outbox item custom type overrides default', async () => {
        const outbox   = makeOutboxBackend();
        const { cap }  = makeCapability(false, outbox);
        const options: SendOptions = { type: 'perch_output' };

        await cap.sendToChannel('ch-1', 'Hello', options);
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.type).toBe('perch_output');
    });

    test('outbox item default priority is medium', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel('ch-1', 'Hello');
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.priority).toBe('medium');
    });

    test('outbox item custom priority overrides default', async () => {
        const outbox   = makeOutboxBackend();
        const { cap }  = makeCapability(false, outbox);
        const options: SendOptions = { priority: 'high' };

        await cap.sendToChannel('ch-1', 'Hello', options);
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.priority).toBe('high');
    });

    test('outbox item has valid uuid id and ISO createdAt', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel('ch-1', 'Hello');
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.id).toMatch(/^[0-9a-f-]{36}$/u);
        expect(new Date(item.createdAt).toISOString()).toBe(item.createdAt);
    });

    test('outbox item custom epoch overrides default 0', async () => {
        const outbox   = makeOutboxBackend();
        const { cap }  = makeCapability(false, outbox);
        const options: SendOptions = { epoch: 5 };

        await cap.sendToChannel('ch-1', 'Hello', options);
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.epoch).toBe(5);
    });

    test('outbox item default epoch is 0', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel('ch-1', 'Hello');
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.epoch).toBe(0);
    });

    test('custom dedupeKey is preserved on outbox item', async () => {
        const outbox   = makeOutboxBackend();
        const { cap }  = makeCapability(false, outbox);
        const options: SendOptions = { dedupeKey: 'my-custom-key' };

        await cap.sendToChannel('ch-1', 'Hello', options);
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.dedupeKey).toBe('my-custom-key');
    });

    test('string content maps to payload.text', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        await cap.sendToChannel('ch-1', 'my text content');
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.payload.text).toBe('my text content');
    });

    test('object content maps payload fields', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);
        const content = { content: 'object text', embeds: ['e1'] as unknown[], components: ['c1'] as unknown[] };

        await cap.sendToChannel('ch-1', content as Parameters<typeof cap.sendToChannel>[1]);
        const item = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(item.payload.text).toBe('object text');
        expect(item.payload.embeds).toEqual(['e1']);
        expect(item.payload.components).toEqual(['c1']);
    });

    test('queued result returns outboxId matching the item id', async () => {
        const outbox  = makeOutboxBackend();
        const { cap } = makeCapability(false, outbox);

        const result = await cap.sendToChannel('ch-1', 'Hello');
        const item   = (outbox.enqueue as ReturnType<typeof mock>).mock.calls[0][0] as OutboxItem;
        expect(result.status).toBe('queued');
        if(result.status === 'queued') {
            expect(result.outboxId).toBe(item.id);
        }
    });
});

// ---- fetchChannel ----

describe('DiscordCapabilityImpl.fetchChannel', () => {
    test('when ready and text-sendable: returns the channel', async () => {
        const channel = makeChannel();
        const client  = makeClient(channel);
        const { cap } = makeCapability(true);
        cap.setClient(client);

        const result = await cap.fetchChannel('ch-1');
        expect(result).toBe(channel);
    });

    test('when ready but channel not text-sendable: returns null', async () => {
        const voiceChannel = { id: 'voice-1' } as unknown as TextChannel;
        const client = makeClient(voiceChannel);
        const { cap } = makeCapability(true);
        cap.setClient(client);

        const result = await cap.fetchChannel('ch-1');
        expect(result).toBeNull();
    });

    test('when not ready (no client): returns null', async () => {
        const { cap } = makeCapability(true);
        // No setClient called

        const result = await cap.fetchChannel('ch-1');
        expect(result).toBeNull();
    });

    test('when not ready (registry says unavailable): returns null', async () => {
        const channel = makeChannel();
        const client  = makeClient(channel);
        const { cap } = makeCapability(false);
        cap.setClient(client);

        const result = await cap.fetchChannel('ch-1');
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
        const { cap } = makeCapability(true);
        cap.setClient(errorClient);

        const result = await cap.fetchChannel('ch-1');
        expect(result).toBeNull();
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

        await cap.fetchChannel('ch-1');
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });
});

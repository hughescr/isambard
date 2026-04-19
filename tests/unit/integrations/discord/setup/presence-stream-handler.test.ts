/**
 * Tests for createPresenceStreamHandler (setup helper) and the
 * buildThinkingSynopsis helper that powers the coordinator path's
 * pre-gen synopsis feature.
 *
 * Focus areas:
 * 1. buildThinkingSynopsis — standalone helper extracted into stream-event-handler.ts
 * 2. createPresenceStreamHandler — async wrapper that pre-generates a synopsis
 *    and passes it into createStreamEventHandler
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as presenceModule from '@/integrations/discord/presence';
import { buildThinkingSynopsis } from '@/integrations/discord/presence';
import type { DynamicStatusGenerator } from '@/integrations/discord/presence/status-generator-dynamic';
import { createPresenceStreamHandler } from '@/integrations/discord/setup/presence-stream-handler';
import type { BotStateManager } from '@/integrations/discord/state/types';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal mock factories
// ─────────────────────────────────────────────────────────────────────────────

function makeDynamicStatusGenerator(synopsis: string | null = 'Thinking about your question...'): DynamicStatusGenerator {
    return {
        generateSynopsis: mock(async (): Promise<string | null> => synopsis),
    } as unknown as DynamicStatusGenerator;
}

function makeBotStateManager(shouldUpdate = true): BotStateManager {
    return {
        shouldUpdatePresence: mock(() => shouldUpdate),
        updateActivityPhase:  mock(() => undefined),
        clearActivityPhase:   mock(() => undefined),
        recordPresenceUpdate: mock(() => undefined),
    } as unknown as BotStateManager;
}

function makePresenceManager(): presenceModule.PresenceManager {
    return {
        updatePhase:                   mock(async () => undefined),
        transitionPresenceDisplayMode: mock(() => undefined),
        start:                         mock(() => undefined),
        stop:                          mock(() => undefined),
    } as unknown as presenceModule.PresenceManager;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildThinkingSynopsis tests
// ─────────────────────────────────────────────────────────────────────────────

describe('buildThinkingSynopsis', () => {
    test('returns generated synopsis when shouldGenerateSynopsis passes', async () => {
        const generator = makeDynamicStatusGenerator('Analyzing your request');
        const manager = makeBotStateManager(true);

        const result = await buildThinkingSynopsis(generator, manager, 'hello world');

        expect(result).toBe('Analyzing your request');
        expect(generator.generateSynopsis).toHaveBeenCalledWith({
            phase:       'thinking',
            userMessage: 'hello world',
        });
    });

    test('returns undefined when dynamicStatusGenerator is undefined', async () => {
        const manager = makeBotStateManager(true);

        const result = await buildThinkingSynopsis(undefined, manager, 'hello');

        expect(result).toBeUndefined();
    });

    test('returns undefined when botStateManager.shouldUpdatePresence returns false', async () => {
        const generator = makeDynamicStatusGenerator('some status');
        const manager = makeBotStateManager(false);

        const result = await buildThinkingSynopsis(generator, manager, 'hello');

        expect(result).toBeUndefined();
        // generateSynopsis must NOT have been called (expensive LLM call)
        expect(generator.generateSynopsis).not.toHaveBeenCalled();
    });

    test('returns undefined when botStateManager is undefined', async () => {
        const generator = makeDynamicStatusGenerator('some status');

        const result = await buildThinkingSynopsis(generator, undefined, 'hello');

        expect(result).toBeUndefined();
        expect(generator.generateSynopsis).not.toHaveBeenCalled();
    });

    test('swallows generateSynopsis throw and returns undefined', async () => {
        const generator = {
            generateSynopsis: mock(async (): Promise<string | null> => { throw new Error('LLM timeout'); }),
        } as unknown as DynamicStatusGenerator;
        const manager = makeBotStateManager(true);

        // Should not throw
        const result = await buildThinkingSynopsis(generator, manager, 'hello');

        expect(result).toBeUndefined();
    });

    test('converts null return from generateSynopsis to undefined', async () => {
        const generator = makeDynamicStatusGenerator(null);
        const manager = makeBotStateManager(true);

        const result = await buildThinkingSynopsis(generator, manager, 'hello');

        expect(result).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// createPresenceStreamHandler tests
// ─────────────────────────────────────────────────────────────────────────────

describe('createPresenceStreamHandler', () => {
    let buildSynopsisSpy: ReturnType<typeof spyOn<typeof presenceModule, 'buildThinkingSynopsis'>>;
    let createHandlerSpy: ReturnType<typeof spyOn<typeof presenceModule, 'createStreamEventHandler'>>;

    const fakeHandler = {
        onStreamEvent: mock((_event: unknown) => undefined),
        complete:      mock(() => undefined),
    };

    beforeEach(() => {
        buildSynopsisSpy = spyOn(presenceModule, 'buildThinkingSynopsis').mockImplementation(
            async () => 'pre-generated synopsis'
        );
        createHandlerSpy = spyOn(presenceModule, 'createStreamEventHandler').mockImplementation(
            () => fakeHandler
        );
        fakeHandler.onStreamEvent.mockClear();
        fakeHandler.complete.mockClear();
    });

    afterEach(() => {
        buildSynopsisSpy.mockRestore();
        createHandlerSpy.mockRestore();
    });

    test('returns undefined and skips synopsis generation when presenceManager is undefined', async () => {
        const manager = makeBotStateManager(true);

        const result = await createPresenceStreamHandler(
            undefined,
            makeDynamicStatusGenerator(),
            'hello',
            manager
        );

        expect(result).toBeUndefined();
        expect(buildSynopsisSpy).not.toHaveBeenCalled();
        expect(createHandlerSpy).not.toHaveBeenCalled();
    });

    test('calls buildThinkingSynopsis with correct args when presenceManager is defined', async () => {
        const pm = makePresenceManager();
        const gen = makeDynamicStatusGenerator();
        const manager = makeBotStateManager(true);

        await createPresenceStreamHandler(pm, gen, 'Tell me about stars', manager);

        expect(buildSynopsisSpy).toHaveBeenCalledWith(gen, manager, 'Tell me about stars');
    });

    test('passes pre-generated synopsis into createStreamEventHandler', async () => {
        const pm = makePresenceManager();
        const gen = makeDynamicStatusGenerator();
        const manager = makeBotStateManager(true);

        await createPresenceStreamHandler(pm, gen, 'user msg', manager);

        expect(createHandlerSpy).toHaveBeenCalledWith(
            expect.objectContaining({ thinkingSynopsis: 'pre-generated synopsis' })
        );
    });

    test('passes thinkingSynopsis=undefined into createStreamEventHandler when generator is absent', async () => {
        buildSynopsisSpy.mockImplementation(async () => undefined);

        const pm = makePresenceManager();
        const manager = makeBotStateManager(false);

        await createPresenceStreamHandler(pm, undefined, 'user msg', manager);

        expect(createHandlerSpy).toHaveBeenCalledWith(
            expect.objectContaining({ thinkingSynopsis: undefined })
        );
    });

    test('forwards onThinkingContentUpdate callback into createStreamEventHandler', async () => {
        const pm = makePresenceManager();
        const manager = makeBotStateManager(true);
        const cb = mock((_content: string) => undefined);

        await createPresenceStreamHandler(pm, undefined, 'msg', manager, cb);

        expect(createHandlerSpy).toHaveBeenCalledWith(
            expect.objectContaining({ onThinkingContentUpdate: cb })
        );
    });

    test('returns handler from createStreamEventHandler', async () => {
        const pm = makePresenceManager();
        const manager = makeBotStateManager(true);

        const result = await createPresenceStreamHandler(pm, undefined, 'msg', manager);

        expect(result).toBe(fakeHandler);
    });

    test('still returns a working handler when synopsis is undefined (e.g. generator threw internally)', async () => {
        // buildThinkingSynopsis itself never throws (it has an internal try/catch),
        // but it can return undefined. Verify createPresenceStreamHandler still
        // calls createStreamEventHandler and returns a valid handler in that case.
        buildSynopsisSpy.mockImplementation(async () => undefined);

        const pm = makePresenceManager();
        const manager = makeBotStateManager(true);

        const result = await createPresenceStreamHandler(pm, undefined, 'msg', manager);

        expect(createHandlerSpy).toHaveBeenCalledWith(
            expect.objectContaining({ thinkingSynopsis: undefined })
        );
        expect(result).toBe(fakeHandler);
    });
});

/**
 * Behavioural tests for {@link installLedgerShim} (P9): the sole writer of
 * processing_message/idle, activity phase and compaction stash/restore onto BotStateManager in
 * conductor mode, driven entirely by the conversation ledger's own event stream.
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import * as frames from '../../../../helpers/sdk-frames';
import { createLedgerStore, type LedgerStore } from '@/agent/session/ledger';
import type { EnvelopeMeta } from '@/agent/session/types';
import type { BotStateManager } from '@/integrations/discord/state';
import { installLedgerShim } from '@/integrations/discord/state/ledger-shim';

function makeBotStateManager(mode: 'idle' | 'processing_message' | 'perching' | 'catching_up' = 'idle') {
    let currentMode = mode;
    const stashAndSetCompacting = jest.fn();
    const restoreFromCompacting = jest.fn();
    const botStateManager = {
        getMode:                jest.fn(() => currentMode),
        startProcessingMessage: jest.fn(() => {
            currentMode = 'processing_message';
        }),
        goIdle: jest.fn(() => {
            currentMode = 'idle';
        }),
        updateActivityPhase:       jest.fn(),
        clearActivityPhase:        jest.fn(),
        getCompactionStateManager: jest.fn(() => ({ stashAndSetCompacting, restoreFromCompacting })),
    } as unknown as BotStateManager;
    return { botStateManager, stashAndSetCompacting, restoreFromCompacting };
}

function makeLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function build(mode: 'idle' | 'processing_message' | 'perching' | 'catching_up' = 'idle') {
    const ledgerStore: LedgerStore = createLedgerStore('conversation', { logger: { error: jest.fn() } });
    const { botStateManager, stashAndSetCompacting, restoreFromCompacting } = makeBotStateManager(mode);
    const logger = makeLogger();
    const unsubscribe = installLedgerShim({ ledgerStore, botStateManager, logger });
    return {
        ledgerStore, botStateManager, logger, unsubscribe, stashAndSetCompacting, restoreFromCompacting,
    };
}

function discordEnvelopeMeta(overrides: Partial<EnvelopeMeta> = {}): EnvelopeMeta {
    return {
        id: 'env-1', kind: 'discord', queuedAt: new Date(0), channelId: 'chan-1', ...overrides,
    };
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('installLedgerShim', () => {
    it('starts processing_message when a discord turn is submitted from idle', () => {
        const { ledgerStore, botStateManager } = build('idle');

        ledgerStore.dispatch({ type: 'turn_submitted', envelope: discordEnvelopeMeta(), at: new Date(0) });

        expect(botStateManager.startProcessingMessage).toHaveBeenCalledWith('chan-1', '');
    });

    it('starts processing_message when a catchup turn is submitted from idle', () => {
        const { ledgerStore, botStateManager } = build('idle');

        ledgerStore.dispatch({ type: 'turn_submitted', envelope: discordEnvelopeMeta({ id: 'env-2', kind: 'catchup' }), at: new Date(0) });

        expect(botStateManager.startProcessingMessage).toHaveBeenCalledWith('chan-1', '');
    });

    it('warns and never writes when a discord/catchup turn starts while not idle (perching/catching_up owned by legacy runners)', () => {
        const { ledgerStore, botStateManager, logger } = build('perching');

        ledgerStore.dispatch({ type: 'turn_submitted', envelope: discordEnvelopeMeta(), at: new Date(0) });

        expect(botStateManager.startProcessingMessage).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
    });

    it('never starts processing_message for a non-discord/catchup turn (e.g. wrapup)', () => {
        const { ledgerStore, botStateManager } = build('idle');

        ledgerStore.dispatch({ type: 'turn_submitted', envelope: discordEnvelopeMeta({ id: 'env-3', kind: 'wrapup', channelId: undefined }), at: new Date(0) });

        expect(botStateManager.startProcessingMessage).not.toHaveBeenCalled();
    });

    it('warns and skips startProcessingMessage for a discord turn submitted with no channelId', () => {
        const { ledgerStore, botStateManager, logger } = build('idle');

        ledgerStore.dispatch({ type: 'turn_submitted', envelope: discordEnvelopeMeta({ channelId: undefined }), at: new Date(0) });

        expect(botStateManager.startProcessingMessage).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'discord' }), expect.any(String));
    });

    it('warns and skips startProcessingMessage for a catchup turn submitted with no channelId', () => {
        const { ledgerStore, botStateManager, logger } = build('idle');

        ledgerStore.dispatch({ type: 'turn_submitted', envelope: discordEnvelopeMeta({ kind: 'catchup', channelId: undefined }), at: new Date(0) });

        expect(botStateManager.startProcessingMessage).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'catchup' }), expect.any(String));
    });

    it('goes idle only when the turn this shim itself started closes, and only from processing_message', () => {
        const { ledgerStore, botStateManager } = build('idle');
        ledgerStore.dispatch({ type: 'turn_submitted', envelope: discordEnvelopeMeta(), at: new Date(0) });
        expect(botStateManager.getMode()).toBe('processing_message');

        ledgerStore.dispatch({
            type:  'sdk_frame',
            frame: { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 } as never,
            at:    new Date(1),
        });

        expect(botStateManager.goIdle).toHaveBeenCalledTimes(1);
    });

    it('does not call goIdle for a turn end this shim never started tracking', () => {
        const { ledgerStore, botStateManager } = build('idle');

        // A spontaneous notification turn (never submitted via turn_submitted) opens then closes —
        // this shim never called startProcessingMessage for it, so it must not call goIdle either.
        ledgerStore.dispatch({
            type:  'sdk_frame',
            frame: { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } } as never,
            at:    new Date(0),
        });
        ledgerStore.dispatch({
            type:  'sdk_frame',
            frame: { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 } as never,
            at:    new Date(1),
        });

        expect(botStateManager.goIdle).not.toHaveBeenCalled();
    });

    it('mirrors an activity-phase change from the ledger onto BotStateManager', () => {
        const { ledgerStore, botStateManager } = build('idle');
        ledgerStore.dispatch({ type: 'turn_submitted', envelope: discordEnvelopeMeta(), at: new Date(0) });

        ledgerStore.dispatch({
            type:  'sdk_frame',
            frame: { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking...' }] } } as never,
            at:    new Date(1),
        });

        expect(botStateManager.updateActivityPhase).toHaveBeenCalled();
    });

    it('stashes on compaction start and restores on compaction end', () => {
        const { ledgerStore, stashAndSetCompacting, restoreFromCompacting } = build('idle');

        ledgerStore.dispatch({ type: 'compaction_started', trigger: 'auto', at: new Date(0) });
        expect(stashAndSetCompacting).toHaveBeenCalledWith('auto');

        ledgerStore.dispatch({ type: 'compaction_finished', at: new Date(1) });
        expect(restoreFromCompacting).toHaveBeenCalledTimes(1);
    });

    it('stashes on compaction start even while a turn is open (the production shape — compaction_started also sets turn.phase to compacting)', () => {
        const { ledgerStore, stashAndSetCompacting } = build('idle');
        ledgerStore.dispatch({ type: 'turn_submitted', envelope: discordEnvelopeMeta(), at: new Date(0) });

        ledgerStore.dispatch({ type: 'compaction_started', trigger: 'auto', at: new Date(1) });

        expect(stashAndSetCompacting).toHaveBeenCalledWith('auto');
    });

    it('restores from compacting once the SDK compact_boundary frame lands, even though no discrete compaction_finished event is ever dispatched in production', () => {
        const { ledgerStore, stashAndSetCompacting, restoreFromCompacting } = build('idle');
        ledgerStore.dispatch({ type: 'turn_submitted', envelope: discordEnvelopeMeta(), at: new Date(0) });
        ledgerStore.dispatch({ type: 'compaction_started', trigger: 'auto', at: new Date(1) });
        expect(stashAndSetCompacting).toHaveBeenCalledWith('auto');

        ledgerStore.dispatch({ type: 'sdk_frame', frame: frames.compactBoundary(), at: new Date(2) });

        expect(restoreFromCompacting).toHaveBeenCalledTimes(1);
    });

    it('stops mirroring once unsubscribed', () => {
        const { ledgerStore, botStateManager, unsubscribe } = build('idle');
        unsubscribe();

        ledgerStore.dispatch({ type: 'turn_submitted', envelope: discordEnvelopeMeta(), at: new Date(0) });

        expect(botStateManager.startProcessingMessage).not.toHaveBeenCalled();
    });
});

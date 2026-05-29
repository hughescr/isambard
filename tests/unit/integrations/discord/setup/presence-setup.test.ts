/**
 * Tests for presence-setup.ts
 *
 * Covers:
 * - getPreviousStatus forwarding: verifies the callback is passed to createIdleStatusGenerator
 *   so the anti-rut block in status-generator-idle.ts fires on the live path.
 */
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { ActivityType, type Client } from 'discord.js';
import type { DiscordConfig } from '@/config';
import * as presenceModule from '@/integrations/discord/presence';
import type { PresenceManager } from '@/integrations/discord/presence/manager';
import type { IdleStatusGeneratorDeps } from '@/integrations/discord/presence/status-generator-idle';
import { setupPresence } from '@/integrations/discord/setup/presence-setup';
import type { BotStateManager, StateChange } from '@/integrations/discord/state';

/** Minimal presence config for tests — required fields only, all others use defaults */
const MINIMAL_PRESENCE_CONFIG: NonNullable<DiscordConfig['presence']> = {
    updateThrottleMs:      12_000,
    idleTimeoutMs:         60_000,
    idleRefreshIntervalMs: 300_000,
};

/** Minimal mock BotStateManager */
function makeMockBotStateManager(): BotStateManager {
    return {
        subscribe:            mock((_listener: (change: StateChange) => void) => mock(() => undefined)),
        shouldUpdatePresence: mock(() => false),
        recordPresenceUpdate: mock(() => undefined),
        start:                mock(() => undefined),
        stop:                 mock(() => undefined),
    } as unknown as BotStateManager;
}

/** Minimal mock Client */
function makeMockClient(): Client {
    return {} as unknown as Client;
}

describe('setupPresence — getPreviousStatus forwarding', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    let capturedIdleDeps: IdleStatusGeneratorDeps | undefined;

    const mockPresenceManager = {
        start:                         mock(() => undefined),
        stop:                          mock(() => undefined),
        updatePhase:                   mock(async () => undefined),
        transitionPresenceDisplayMode: mock(() => undefined),
    };

    beforeEach(() => {
        capturedIdleDeps = undefined;

        spies.push(
            // @ts-expect-error — Mocking constructor
            spyOn(presenceModule, 'PresenceManager').mockImplementation((): PresenceManager => mockPresenceManager as unknown as PresenceManager),
            spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate:     mock(() => ({ name: 'Active', type: ActivityType.Custom })),
                formatStatus: mock((s: string) => ({ name: s, type: ActivityType.Custom })),
            }),
            spyOn(presenceModule, 'createIdleStatusGenerator').mockImplementation((deps: IdleStatusGeneratorDeps) => {
                capturedIdleDeps = deps;
                return { generate: mock(async () => ({ name: 'Idle', type: ActivityType.Custom })) };
            })
        );
    });

    afterEach(() => {
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
        mock.restore();
    });

    test('should forward getPreviousStatus to createIdleStatusGenerator when provided', () => {
        const getPreviousStatus = mock((): string | undefined => 'previous status text');

        setupPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            botStateManager:        makeMockBotStateManager(),
            dynamicStatusGenerator: undefined,
            inboxManager:           undefined,
            getRecentContext:       () => Promise.resolve(undefined),
            getPreviousStatus,
        });

        // Verify createIdleStatusGenerator was called with the deps
        expect(presenceModule.createIdleStatusGenerator).toHaveBeenCalled();
        expect(capturedIdleDeps?.getPreviousStatus).toBe(getPreviousStatus);
    });

    test('getPreviousStatus passed to setupPresence reaches createIdleStatusGenerator deps', () => {
        const getPreviousStatus = mock((): string | undefined => 'last idle text');

        setupPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            botStateManager:        makeMockBotStateManager(),
            dynamicStatusGenerator: undefined,
            inboxManager:           undefined,
            getRecentContext:       () => Promise.resolve(undefined),
            getPreviousStatus,
        });

        // The captured deps must include the exact same getPreviousStatus function
        expect(capturedIdleDeps?.getPreviousStatus).toBe(getPreviousStatus);
    });

    test('getPreviousStatus is undefined in createIdleStatusGenerator deps when not passed to setupPresence', () => {
        setupPresence({
            identityContext:        'Test identity',
            presenceConfig:         MINIMAL_PRESENCE_CONFIG,
            readyClient:            makeMockClient(),
            botStateManager:        makeMockBotStateManager(),
            dynamicStatusGenerator: undefined,
            inboxManager:           undefined,
            getRecentContext:       () => Promise.resolve(undefined),
            // No getPreviousStatus
        });

        expect(capturedIdleDeps?.getPreviousStatus).toBeUndefined();
    });
});

/**
 * Integration tests for Discord presence flow.
 *
 * Drives `PresenceManager.applyView` with composed `PresenceView`s through the real active and
 * idle status generators and the real `renderPresenceText`; only the Discord client and the
 * Anthropic text generation are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { ActivityType, type Client  } from 'discord.js';
import { mockGenerateText, mockGenerateTextWithSystemPrompt, originalGenerateText, originalGenerateTextWithSystemPrompt } from '../../setup';
import { initialLedger, reduceLedger } from '@/agent';
import { PresenceManager } from '@/integrations/discord/presence/manager';
import { composePresence, type PresenceView } from '@/integrations/discord/presence/presence-view';
import { createActiveStatusGenerator } from '@/integrations/discord/presence/status-generator-active';
import { createIdleStatusGenerator } from '@/integrations/discord/presence/status-generator-idle';

describe('Discord Presence Flow (Integration)', () => {
    let setActivity: ReturnType<typeof mock>;
    let mockDiscordClient: Client;

    beforeEach(() => {
        jest.useFakeTimers();
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(() => Promise.resolve('Contemplating digital dreams'));
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(() => Promise.resolve('Contemplating digital dreams'));

        setActivity = mock(() => undefined);
        mockDiscordClient = { user: { setActivity } } as unknown as Client;
    });

    afterEach(() => {
        jest.clearAllTimers();     // Clear while still in fake mode
        jest.useRealTimers();      // Then restore real timers
        mockGenerateText.mockReset();
        mockGenerateText.mockImplementation(originalGenerateText);
        mockGenerateTextWithSystemPrompt.mockReset();
        mockGenerateTextWithSystemPrompt.mockImplementation(originalGenerateTextWithSystemPrompt);
    });

    it('renders an active view through the real active generator, then an idle view through the real idle generator', async () => {
        const logger = {
            debug: mock(() => undefined),
            info:  mock(() => undefined),
            warn:  mock(() => undefined),
            error: mock(() => undefined),
        };

        const activeStatusGenerator = createActiveStatusGenerator({
            activityType: ActivityType.Custom,
            logger,
        });

        const idleStatusGenerator = createIdleStatusGenerator({
            logger,
            activityType:    ActivityType.Custom,
            identityContext: () => Promise.resolve('Test Bot'),
        });

        const presenceManager = new PresenceManager({
            discordClient: mockDiscordClient,
            config:        {
                updateThrottleMs:      50,
                idleTimeoutMs:         200,
                idleRefreshIntervalMs: 5000,
            },
            activeStatusGenerator,
            idleStatusGenerator,
            logger,
        });

        presenceManager.start();

        const thinkingView: PresenceView = {
            live:       ['conversation'],
            prefix:     '💬',
            compacting: false,
            phase:      { type: 'thinking', startedAt: new Date() },
            activeRole: 'conversation',
        };
        await presenceManager.applyView(thinkingView);

        expect(setActivity).toHaveBeenCalledTimes(1);
        expect(setActivity).toHaveBeenCalledWith({ name: '💬 • Thinking...', type: ActivityType.Custom });
        expect(mockGenerateTextWithSystemPrompt).not.toHaveBeenCalled();

        // Going idle starts the idle refresh loop, which drives the real idle status generator and
        // so invokes the (mocked) Haiku text generator that writes the idle line.
        const idleView: PresenceView = {
            live:       [],
            prefix:     '💤',
            compacting: false,
            phase:      { type: 'idle', since: new Date() },
            activeRole: null,
        };
        await presenceManager.applyView(idleView);

        expect(mockGenerateTextWithSystemPrompt).toHaveBeenCalled();
        expect(setActivity).toHaveBeenCalledTimes(2);
        expect(setActivity).toHaveBeenLastCalledWith({ name: '💤 • Contemplating digital dreams', type: ActivityType.Custom });

        presenceManager.stop();
    });

    it('says "compacting" exactly once while a turn is open during a compaction', async () => {
        const logger = {
            debug: mock(() => undefined),
            info:  mock(() => undefined),
            warn:  mock(() => undefined),
            error: mock(() => undefined),
        };
        const presenceManager = new PresenceManager({
            discordClient:         mockDiscordClient,
            config:                { updateThrottleMs: 50, idleTimeoutMs: 200, idleRefreshIntervalMs: 5000 },
            activeStatusGenerator: createActiveStatusGenerator({ activityType: ActivityType.Custom, logger }),
            idleStatusGenerator:   createIdleStatusGenerator({ logger, activityType: ActivityType.Custom, identityContext: () => Promise.resolve('Test Bot') }),
            logger,
        });
        presenceManager.start();
        const at = new Date(0);
        const opened = reduceLedger(initialLedger('conversation'), { type: 'turn_submitted', envelope: { id: 'env-1', kind: 'compact', queuedAt: at }, at });
        const compacting = reduceLedger(opened, { type: 'compaction_started', trigger: 'auto', at });

        await presenceManager.applyView(composePresence([compacting, initialLedger('perch')]));

        const [[{ name }]] = setActivity.mock.calls as unknown as [[{ name: string }]];
        expect(name).toBe('💬 • compacting • Thinking...');
        expect(name.match(/compacting/gi) ?? []).toHaveLength(1);

        presenceManager.stop();
    });
});

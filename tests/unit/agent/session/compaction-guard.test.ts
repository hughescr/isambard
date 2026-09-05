/**
 * Behavioural tests for {@link createCompactionGuard} (design doc section 6): the host-driven
 * "should we /compact now, and when is it safe to submit another envelope" state machine. Every
 * timing assertion runs on {@link FakeClock} — no real timers anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { SDKNotificationMessage } from '@anthropic-ai/claude-agent-sdk';
import { FakeClock } from '../../../helpers/fake-clock';
import * as frames from '../../../helpers/sdk-frames';
import { createCompactionGuard, type CompactionGuard, type CreateCompactionGuardParams } from '@/agent/session/compaction-guard';

function notificationFrame(key: string): SDKNotificationMessage {
    return {
        type:       'system',
        subtype:    'notification',
        key,
        text:       'compaction trouble',
        priority:   'high',
        uuid:       '00000000-0000-0000-0000-000000000000',
        session_id: 'session-1',
    };
}

describe('createCompactionGuard', () => {
    let clock: FakeClock;
    let logger: CreateCompactionGuardParams['logger'];
    let dispatch: ReturnType<typeof jest.fn>;
    let getContextUsage: ReturnType<typeof jest.fn<CreateCompactionGuardParams['getContextUsage']>>;
    let submitCompact: ReturnType<typeof jest.fn<CreateCompactionGuardParams['submitCompact']>>;
    let guard: CompactionGuard;

    function build(overrides: Partial<CreateCompactionGuardParams> = {}): CompactionGuard {
        return createCompactionGuard({
            getContextUsage,
            submitCompact,
            ledgerStore:      { dispatch },
            clock,
            thresholdPercent: 60,
            logger,
            ...overrides,
        });
    }

    beforeEach(() => {
        clock = new FakeClock(0);
        logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        dispatch = jest.fn();
        getContextUsage = jest.fn<CreateCompactionGuardParams['getContextUsage']>().mockResolvedValue(frames.contextUsage({ percentage: 59 }));
        submitCompact = jest.fn<CreateCompactionGuardParams['submitCompact']>().mockResolvedValue(undefined);
        guard = build();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('below threshold: does not submit, but still polls and logs the percentage', async () => {
        await guard.onTurnEnd({ queueEmpty: true });

        expect(submitCompact).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith({ percentage: 59 }, expect.any(String));
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'context_usage_polled' }));
    });

    it('at threshold with an empty queue: submits /compact once and dispatches compaction_started', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));

        await guard.onTurnEnd({ queueEmpty: true });

        expect(submitCompact).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'compaction_started', trigger: 'auto' }));
    });

    it('at threshold with a non-empty queue: deferred to the next turn end', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));

        await guard.onTurnEnd({ queueEmpty: false });
        expect(submitCompact).not.toHaveBeenCalled();

        await guard.onTurnEnd({ queueEmpty: true });
        expect(submitCompact).toHaveBeenCalledTimes(1);
    });

    it('a second turn end while a compaction is already in flight does not submit again', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));
        await guard.onTurnEnd({ queueEmpty: true });

        await guard.onTurnEnd({ queueEmpty: true });

        expect(submitCompact).toHaveBeenCalledTimes(1);
    });

    it('a compact_boundary frame releases the hold, allowing a later submit', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));
        await guard.onTurnEnd({ queueEmpty: true });

        guard.onFrame(frames.compactBoundary());
        await guard.onTurnEnd({ queueEmpty: true });

        expect(submitCompact).toHaveBeenCalledTimes(2);
        expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'compaction_failed' }));
    });

    it('onCompactionFinished (PostCompact) releases the hold, allowing a later submit', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));
        await guard.onTurnEnd({ queueEmpty: true });

        guard.onCompactionFinished();
        await guard.onTurnEnd({ queueEmpty: true });

        expect(submitCompact).toHaveBeenCalledTimes(2);
        expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'compaction_failed' }));
    });

    it('the /compact turn\'s own result with no boundary seen releases and dispatches compaction_failed', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));
        await guard.onTurnEnd({ queueEmpty: true });

        guard.onFrame(frames.resultSuccess());

        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'compaction_failed', reason: 'no-boundary' }));
    });

    it('onCompactionFinished when nothing is in flight is a no-op — no dispatch, no logger call', () => {
        guard.onCompactionFinished();

        expect(dispatch).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('a result frame observed while nothing is in flight is a no-op', () => {
        guard.onFrame(frames.resultSuccess());

        expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'compaction_failed' }));
    });

    it('the error-compacting-conversation notification releases and dispatches compaction_failed', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));
        await guard.onTurnEnd({ queueEmpty: true });

        guard.onFrame(notificationFrame('error-compacting-conversation'));

        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'compaction_failed', reason: 'notification' }));
    });

    it('other notification keys are ignored — the guard stays in flight', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));
        await guard.onTurnEnd({ queueEmpty: true });

        guard.onFrame(notificationFrame('some-other-key'));

        expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'compaction_failed' }));
        await guard.onTurnEnd({ queueEmpty: true });
        expect(submitCompact).toHaveBeenCalledTimes(1);
    });

    it('no release within the ceiling: 299999ms does not fire, the 300000th ms does, reason timeout', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));
        await guard.onTurnEnd({ queueEmpty: true });

        clock.advance(299_999);
        expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'compaction_failed' }));

        clock.advance(1);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'compaction_failed', reason: 'timeout' }));
    });

    it('a release before the ceiling cancels the timer — no failure fires later', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));
        await guard.onTurnEnd({ queueEmpty: true });
        guard.onFrame(frames.compactBoundary());
        dispatch.mockClear();

        clock.advance(300_000);

        expect(dispatch).not.toHaveBeenCalled();
    });

    it('honours a custom ceilingMs', async () => {
        guard = build({ ceilingMs: 1000 });
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));
        await guard.onTurnEnd({ queueEmpty: true });

        clock.advance(1000);

        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'compaction_failed', reason: 'timeout' }));
    });

    it('backs off after a failure: skip 1, then 2, then 4, capped at 8, reset on success', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));

        // Attempt 1 fails on the ceiling -> skip the next 1 turn end.
        await guard.onTurnEnd({ queueEmpty: true });
        clock.runAll();
        expect(submitCompact).toHaveBeenCalledTimes(1);

        await guard.onTurnEnd({ queueEmpty: true }); // consumes the 1 skip
        expect(submitCompact).toHaveBeenCalledTimes(1);

        // Attempt 2 fails -> skip the next 2 turn ends.
        await guard.onTurnEnd({ queueEmpty: true });
        expect(submitCompact).toHaveBeenCalledTimes(2);
        clock.runAll();

        await guard.onTurnEnd({ queueEmpty: true }); // skip 1 of 2
        await guard.onTurnEnd({ queueEmpty: true }); // skip 2 of 2
        expect(submitCompact).toHaveBeenCalledTimes(2);

        // Attempt 3 succeeds -> backoff resets.
        await guard.onTurnEnd({ queueEmpty: true });
        expect(submitCompact).toHaveBeenCalledTimes(3);
        guard.onFrame(frames.compactBoundary());

        // Attempt 4 fails -> only 1 turn end is skipped this time (reset, not capped at 4).
        await guard.onTurnEnd({ queueEmpty: true });
        expect(submitCompact).toHaveBeenCalledTimes(4);
        clock.runAll();

        await guard.onTurnEnd({ queueEmpty: true }); // consumes the single skip
        expect(submitCompact).toHaveBeenCalledTimes(4);
        await guard.onTurnEnd({ queueEmpty: true });
        expect(submitCompact).toHaveBeenCalledTimes(5);
    });

    it('the backoff caps at skipping 8 turn ends', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));
        // Fail four times in a row: skip sequence becomes 1, 2, 4, 8.
        for(let i = 0; i < 4; i += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential by construction: each iteration must observe the previous failure's backoff before continuing
            await guard.onTurnEnd({ queueEmpty: true });
            clock.runAll();
            for(let skip = 0; skip < 2 ** i; skip += 1) {
                // eslint-disable-next-line no-await-in-loop -- draining exactly the skip window this failure armed
                await guard.onTurnEnd({ queueEmpty: true });
            }
        }
        expect(submitCompact).toHaveBeenCalledTimes(4);

        // A 5th failure would arm another skip of 8 (not 16) — verified by 8 skipped calls then one that submits.
        await guard.onTurnEnd({ queueEmpty: true });
        clock.runAll();
        expect(submitCompact).toHaveBeenCalledTimes(5);
        for(let skip = 0; skip < 8; skip += 1) {
            // eslint-disable-next-line no-await-in-loop -- draining exactly the capped 8-call skip window
            await guard.onTurnEnd({ queueEmpty: true });
        }
        expect(submitCompact).toHaveBeenCalledTimes(5);
        await guard.onTurnEnd({ queueEmpty: true });
        expect(submitCompact).toHaveBeenCalledTimes(6);
    });

    it('getContextUsage rejection is logged and ignored: no dispatch, no submit', async () => {
        const failure = new Error('context usage unavailable');
        getContextUsage.mockRejectedValue(failure);

        await guard.onTurnEnd({ queueEmpty: true });

        expect(logger.warn).toHaveBeenCalledWith({ error: failure }, expect.any(String));
        expect(dispatch).not.toHaveBeenCalled();
        expect(submitCompact).not.toHaveBeenCalled();
    });

    it('submitCompact rejection is logged and dispatches compaction_failed', async () => {
        getContextUsage.mockResolvedValue(frames.contextUsage({ percentage: 60 }));
        const failure = new Error('CLI refused /compact');
        submitCompact.mockRejectedValue(failure);

        await guard.onTurnEnd({ queueEmpty: true });

        expect(logger.warn).toHaveBeenCalledWith({ error: failure }, expect.any(String));
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'compaction_failed', reason: 'submit-rejected' }));
    });
});

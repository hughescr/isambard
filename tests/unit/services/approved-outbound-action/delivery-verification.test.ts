import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import type { ApprovedOutboundActionBackend } from '@/services/approved-outbound-action/backend';
import {
    DEFAULT_VERIFY_DELAY_MS,
    IDENTICAL_CONTENT_MARGIN_MS,
    MAX_VERIFY_INTERVAL_MS,
    createDeliveryVerification,
    type DeliveryVerification
} from '@/services/approved-outbound-action/delivery-verification';
import type {
    ApprovedOutboundAction,
    ApprovedOutboundActionType,
    DeliveryCheck,
    DeliveryCheckInput,
    UnverifiedApprovedOutboundAction
} from '@/services/approved-outbound-action/types';
import type { ServiceLogger } from '@/services/types';

type Backend = Pick<ApprovedOutboundActionBackend, 'resolveUnverified' | 'listAll'>;
type CheckMock = ReturnType<typeof mock<(input: DeliveryCheckInput) => Promise<DeliveryCheck>>>;
type KeyMock = ReturnType<typeof mock<(params: Record<string, unknown>) => string | undefined>>;

const ROW_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const ROW_ID_2 = 'aaaaaaaa-1111-4222-8333-000000000002';
const TWIN_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const FIRST_CLAIMED_AT = '2026-03-30T10:00:00.000Z';
/** When the row's outcome became unknown: its `updatedAt`. */
const SETTLED_AT = '2026-03-30T10:02:00.000Z';
const SETTLED_MS = Date.parse(SETTLED_AT);
const TIMEOUT_MS = 120_000;

function unverified(overrides: Partial<ApprovedOutboundAction> = {}): UnverifiedApprovedOutboundAction {
    return {
        id:                   ROW_ID,
        type:                 'bsky_dm',
        params:               { convoId: 'c1', text: 'Thanks!' },
        lastError:            'fetch failed',
        ambiguousSends:       1,
        firstClaimedAt:       FIRST_CLAIMED_AT,
        outcomeReportPending: true,
        createdAt:            '2026-03-30T09:59:00.000Z',
        updatedAt:            SETTLED_AT,
        ...overrides,
        state:                'unverified',
    };
}

describe('createDeliveryVerification', () => {
    let clock: number;
    let resolveUnverified: ReturnType<typeof mock<Backend['resolveUnverified']>>;
    let listAll: ReturnType<typeof mock<Backend['listAll']>>;
    let checks: Record<ApprovedOutboundActionType, CheckMock>;
    let contentKeys: Record<ApprovedOutboundActionType, KeyMock>;
    let logger: ServiceLogger;

    function build(): DeliveryVerification {
        return createDeliveryVerification({
            backend:   { resolveUnverified, listAll },
            verifiers: {
                bsky_reply: { check: checks.bsky_reply, contentKey: contentKeys.bsky_reply },
                bsky_dm:    { check: checks.bsky_dm, contentKey: contentKeys.bsky_dm },
                email_send: { check: checks.email_send, contentKey: contentKeys.email_send },
            },
            logger,
            timeoutMs: TIMEOUT_MS,
            delayMs:   DEFAULT_VERIFY_DELAY_MS,
            now:       () => clock,
        });
    }

    beforeEach(() => {
        jest.useFakeTimers();
        clock = SETTLED_MS + DEFAULT_VERIFY_DELAY_MS;
        resolveUnverified = mock(async (action: UnverifiedApprovedOutboundAction, to: 'executed' | 'approved'): Promise<ApprovedOutboundAction | undefined> => ({ ...action, state: to }));
        listAll = mock(async (): Promise<ApprovedOutboundAction[]> => []);
        checks = {
            bsky_reply: mock(async (_input: DeliveryCheckInput): Promise<DeliveryCheck> => ({ verdict: 'delivered' })),
            bsky_dm:    mock(async (_input: DeliveryCheckInput): Promise<DeliveryCheck> => ({ verdict: 'delivered' })),
            email_send: mock(async (_input: DeliveryCheckInput): Promise<DeliveryCheck> => ({ verdict: 'delivered' })),
        };
        contentKeys = {
            bsky_reply: mock((_params: Record<string, unknown>): string | undefined => undefined),
            bsky_dm:    mock((_params: Record<string, unknown>): string | undefined => undefined),
            email_send: mock((_params: Record<string, unknown>): string | undefined => undefined),
        };
        logger = {
            debug: mock((): void => undefined),
            info:  mock((): void => undefined),
            warn:  mock((): void => undefined),
            error: mock((): void => undefined),
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    test('the schedule constants are exact', () => {
        expect(DEFAULT_VERIFY_DELAY_MS).toBe(300_000);
        expect(MAX_VERIFY_INTERVAL_MS).toBe(3_600_000);
        expect(IDENTICAL_CONTENT_MARGIN_MS).toBe(900_000);
    });

    describe('first-check schedule', () => {
        test('does not check a row one millisecond before its first check is due', async () => {
            clock = SETTLED_MS + DEFAULT_VERIFY_DELAY_MS - 1;

            expect(await build().verify([unverified()])).toEqual({ delivered: [], requeued: [] });
            expect(checks.bsky_dm).not.toHaveBeenCalled();
        });

        test('checks a row exactly when its first check is due, with its params, window start and a signal', async () => {
            await build().verify([unverified()]);

            expect(checks.bsky_dm).toHaveBeenCalledTimes(1);
            const [input] = checks.bsky_dm.mock.calls[0];
            expect(input.params).toEqual({ convoId: 'c1', text: 'Thanks!' });
            expect(input.since).toEqual(new Date(FIRST_CLAIMED_AT));
            expect(input.until).toEqual(new Date(SETTLED_AT));
            expect(input.signal).toBeInstanceOf(AbortSignal);
            expect(input.signal.aborted).toBe(false);
        });

        test('a row that never recorded its first claim is searched from its approval', async () => {
            const { firstClaimedAt: _firstClaimedAt, ...legacy } = unverified();

            await build().verify([legacy]);

            expect(checks.bsky_dm.mock.calls[0]?.[0].since).toEqual(new Date('2026-03-30T09:59:00.000Z'));
        });

        test('a row with no count of unknown sends waits the base delay', async () => {
            const { ambiguousSends: _count, ...legacy } = unverified();
            clock = SETTLED_MS + DEFAULT_VERIFY_DELAY_MS - 1;
            const verification = build();

            await verification.verify([legacy]);
            expect(checks.bsky_dm).not.toHaveBeenCalled();

            clock += 1;
            await verification.verify([legacy]);
            expect(checks.bsky_dm).toHaveBeenCalledTimes(1);
        });

        test.each([
            [2, 2 * DEFAULT_VERIFY_DELAY_MS],
            [3, 4 * DEFAULT_VERIFY_DELAY_MS],
            [4, 8 * DEFAULT_VERIFY_DELAY_MS],
            [5, MAX_VERIFY_INTERVAL_MS],
            [30, MAX_VERIFY_INTERVAL_MS],
        ])('after %i unknown sends the first check waits %i ms', async (ambiguousSends, wait) => {
            const row = unverified({ ambiguousSends });
            clock = SETTLED_MS + wait - 1;
            const verification = build();

            await verification.verify([row]);
            expect(checks.bsky_dm).not.toHaveBeenCalled();

            clock += 1;
            await verification.verify([row]);
            expect(checks.bsky_dm).toHaveBeenCalledTimes(1);
        });
    });

    describe('verdicts', () => {
        test('a delivered verdict resolves the row to executed and returns it as delivered', async () => {
            const row = unverified();

            expect(await build().verify([row])).toEqual({ delivered: [{ ...row, state: 'executed' }], requeued: [] });

            expect(resolveUnverified.mock.calls).toEqual([[row, 'executed']]);
            expect(logger.info).toHaveBeenCalledWith({ actionId: ROW_ID, type: 'bsky_dm' }, 'Approved outbound action found at its destination; recorded as sent');
        });

        test('a not-delivered verdict resolves the row to approved and returns it to resend', async () => {
            const row = unverified();
            checks.bsky_dm.mockImplementation(async () => ({ verdict: 'not-delivered' }));

            expect(await build().verify([row])).toEqual({ delivered: [], requeued: [{ ...row, state: 'approved' }] });

            expect(resolveUnverified.mock.calls).toEqual([[row, 'approved']]);
            expect(logger.info).toHaveBeenCalledWith({ actionId: ROW_ID, type: 'bsky_dm' }, 'Approved outbound action definitely not at its destination; sending it again');
        });

        test('a resolution that lost to another process is logged and returns nothing', async () => {
            resolveUnverified.mockImplementation(async () => undefined);
            checks.bsky_dm.mockImplementation(async () => ({ verdict: 'not-delivered' }));

            expect(await build().verify([unverified()])).toEqual({ delivered: [], requeued: [] });
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: ROW_ID, verdict: 'not-delivered' },
                'Approved outbound action delivery check not recorded: the row was resolved elsewhere'
            );
            expect(logger.info).not.toHaveBeenCalled();
        });

        test('a failed resolution write rejects the pass before the next row is checked', async () => {
            resolveUnverified.mockImplementation(async () => {
                throw new Error('throughput exceeded');
            });

            await expect(build().verify([unverified(), unverified({ id: ROW_ID_2 })])).rejects.toThrow('throughput exceeded');
            expect(checks.bsky_dm).toHaveBeenCalledTimes(1);
        });

        test('checks rows one at a time in the given order', async () => {
            const first = Promise.withResolvers<DeliveryCheck>();
            checks.bsky_dm.mockImplementationOnce(async () => first.promise);
            const pass = build().verify([unverified(), unverified({ id: ROW_ID_2, type: 'bsky_reply' })]);
            await Promise.resolve();
            await Promise.resolve();

            expect(checks.bsky_reply).not.toHaveBeenCalled();
            first.resolve({ verdict: 'delivered' });
            const result = await pass;

            expect(result.delivered.map(row => row.id)).toEqual([ROW_ID, ROW_ID_2]);
            expect(checks.bsky_reply).toHaveBeenCalledTimes(1);
        });
    });

    describe('undecided checks', () => {
        test('an undetermined verdict writes nothing and logs the reason', async () => {
            checks.bsky_dm.mockImplementation(async () => ({ verdict: 'undetermined', reason: 'lookup failed' }));

            expect(await build().verify([unverified()])).toEqual({ delivered: [], requeued: [] });

            expect(resolveUnverified).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: ROW_ID, type: 'bsky_dm', reason: 'lookup failed', undecidedChecks: 1 },
                'Approved outbound action delivery still unknown; will check its destination again'
            );
        });

        test('rechecks an undecided row after a doubling interval capped at an hour, and never gives up', async () => {
            checks.bsky_dm.mockImplementation(async () => ({ verdict: 'undetermined', reason: 'lookup failed' }));
            const row = unverified();
            const verification = build();
            await verification.verify([row]);

            const waits = [1, 2, 4, 8, 12, 12].map(factor => Math.min(factor * DEFAULT_VERIFY_DELAY_MS, MAX_VERIFY_INTERVAL_MS));
            for(const [index, wait] of waits.entries()) {
                clock += wait - 1;
                // eslint-disable-next-line no-await-in-loop -- each recheck depends on the schedule the previous one set.
                await verification.verify([row]);
                expect(checks.bsky_dm).toHaveBeenCalledTimes(index + 1);

                clock += 1;
                // eslint-disable-next-line no-await-in-loop -- each recheck depends on the schedule the previous one set.
                await verification.verify([row]);
                expect(checks.bsky_dm).toHaveBeenCalledTimes(index + 2);
            }
            expect(logger.warn).toHaveBeenLastCalledWith(
                { actionId: ROW_ID, type: 'bsky_dm', reason: 'lookup failed', undecidedChecks: 7 },
                'Approved outbound action delivery still unknown; will check its destination again'
            );
            expect(resolveUnverified).not.toHaveBeenCalled();
        });

        test('a new revision of the row keeps its own first-check schedule, not the old recheck', async () => {
            checks.bsky_dm.mockImplementation(async () => ({ verdict: 'undetermined', reason: 'lookup failed' }));
            const verification = build();
            await verification.verify([unverified()]);

            const settledAgain = SETTLED_MS + 60_000;
            const newer = unverified({ updatedAt: new Date(settledAgain).toISOString() });
            clock = settledAgain + DEFAULT_VERIFY_DELAY_MS;
            await verification.verify([newer]);

            expect(checks.bsky_dm).toHaveBeenCalledTimes(2);
            expect(logger.warn).toHaveBeenLastCalledWith(
                { actionId: ROW_ID, type: 'bsky_dm', reason: 'lookup failed', undecidedChecks: 1 },
                'Approved outbound action delivery still unknown; will check its destination again'
            );
        });

        test('a check that throws counts as undetermined, with the error as the reason', async () => {
            checks.bsky_dm.mockImplementation(async () => {
                throw new Error('Failed to get message log');
            });

            expect(await build().verify([unverified()])).toEqual({ delivered: [], requeued: [] });
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: ROW_ID, type: 'bsky_dm', reason: 'Failed to get message log', undecidedChecks: 1 },
                'Approved outbound action delivery still unknown; will check its destination again'
            );
        });

        test('a check that throws synchronously or a non-Error counts as undetermined', async () => {
            checks.bsky_dm.mockImplementation((): Promise<DeliveryCheck> => {
                throw 'no client';
            });

            await build().verify([unverified()]);
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: ROW_ID, type: 'bsky_dm', reason: 'no client', undecidedChecks: 1 },
                'Approved outbound action delivery still unknown; will check its destination again'
            );
        });

        test('a check with no answer within the timeout is cancelled and counts as undetermined', async () => {
            let signal: AbortSignal | undefined;
            checks.bsky_dm.mockImplementation(async (input) => {
                signal = input.signal;
                return Promise.withResolvers<DeliveryCheck>().promise;
            });
            const pass = build().verify([unverified()]);
            await Promise.resolve();
            await Promise.resolve();

            jest.advanceTimersByTime(TIMEOUT_MS - 1);
            expect(signal?.aborted).toBe(false);
            jest.advanceTimersByTime(1);

            expect(await pass).toEqual({ delivered: [], requeued: [] });
            expect(signal?.aborted).toBe(true);
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: ROW_ID, type: 'bsky_dm', reason: 'no answer from the destination within 120s', undecidedChecks: 1 },
                'Approved outbound action delivery still unknown; will check its destination again'
            );
        });
    });

    describe('identical content', () => {
        const KEY = '["c1","Thanks!"]';

        function twin(overrides: Partial<ApprovedOutboundAction> = {}): ApprovedOutboundAction {
            return { ...unverified(), id: TWIN_ID, state: 'executed', updatedAt: new Date(Date.parse(FIRST_CLAIMED_AT) - IDENTICAL_CONTENT_MARGIN_MS).toISOString(), ...overrides };
        }

        beforeEach(() => {
            contentKeys.bsky_dm.mockImplementation(params => (params.text === 'Thanks!' ? KEY : undefined));
        });

        async function deliveredIds(): Promise<string[]> {
            const result = await build().verify([unverified()]);
            return result.delivered.map(row => row.id);
        }

        function expectTwinVeto(ids: string): void {
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: ROW_ID, type: 'bsky_dm', reason: `other actions with identical content (${ids}) could match at the destination`, undecidedChecks: 1 },
                'Approved outbound action delivery still unknown; will check its destination again'
            );
        }

        test('a match at the destination while another action of the same type and content was written at the margin before the window is undetermined', async () => {
            listAll.mockImplementation(async () => [unverified(), twin()]);

            expect(await build().verify([unverified()])).toEqual({ delivered: [], requeued: [] });

            expect(checks.bsky_dm).toHaveBeenCalledTimes(1);
            expect(resolveUnverified).not.toHaveBeenCalled();
            expect(contentKeys.bsky_dm.mock.calls).toEqual([[{ convoId: 'c1', text: 'Thanks!' }], [{ convoId: 'c1', text: 'Thanks!' }]]);
            expectTwinVeto(TWIN_ID);
        });

        test('lists the actions only once the destination has answered, so an identical action written during the check is seen', async () => {
            const order: string[] = [];
            checks.bsky_dm.mockImplementation(async () => {
                order.push('check');
                return { verdict: 'delivered' };
            });
            listAll.mockImplementation(async () => {
                order.push('list');
                return [twin()];
            });

            expect(await build().verify([unverified()])).toEqual({ delivered: [], requeued: [] });
            expect(order).toEqual(['check', 'list']);
            expectTwinVeto(TWIN_ID);
        });

        test('a not-delivered verdict is trusted whatever identical actions exist, without listing them', async () => {
            listAll.mockImplementation(async () => [twin()]);
            checks.bsky_dm.mockImplementation(async () => ({ verdict: 'not-delivered' }));
            const row = unverified();

            expect(await build().verify([row])).toEqual({ delivered: [], requeued: [{ ...row, state: 'approved' }] });
            expect(listAll).not.toHaveBeenCalled();
        });

        test('an undetermined verdict keeps its own reason, without listing the actions', async () => {
            listAll.mockImplementation(async () => [twin()]);
            checks.bsky_dm.mockImplementation(async () => ({ verdict: 'undetermined', reason: 'lookup failed' }));

            await build().verify([unverified()]);
            expect(listAll).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: ROW_ID, type: 'bsky_dm', reason: 'lookup failed', undecidedChecks: 1 },
                'Approved outbound action delivery still unknown; will check its destination again'
            );
        });

        test('lists every twin in the reason', async () => {
            const secondTwin = 'cccccccc-1111-4222-8333-444444444444';
            listAll.mockImplementation(async () => [twin(), twin({ id: secondTwin, state: 'approved' })]);

            expect(await build().verify([unverified()])).toEqual({ delivered: [], requeued: [] });
            expectTwinVeto(`${TWIN_ID}, ${secondTwin}`);
        });

        test('an identical action last written a millisecond before the margin is not a twin, so the match stands', async () => {
            listAll.mockImplementation(async () => [twin({ updatedAt: new Date(Date.parse(FIRST_CLAIMED_AT) - IDENTICAL_CONTENT_MARGIN_MS - 1).toISOString() })]);

            expect(await deliveredIds()).toEqual([ROW_ID]);
        });

        test('an identical action first claimed exactly at the margin after the row\'s outcome became unknown is a twin', async () => {
            const at = new Date(SETTLED_MS + IDENTICAL_CONTENT_MARGIN_MS).toISOString();
            listAll.mockImplementation(async () => [twin({ firstClaimedAt: at, updatedAt: at })]);

            expect(await build().verify([unverified()])).toEqual({ delivered: [], requeued: [] });
            expectTwinVeto(TWIN_ID);
        });

        test('an identical action first claimed a millisecond after that margin is not a twin, so the match stands', async () => {
            const at = new Date(SETTLED_MS + IDENTICAL_CONTENT_MARGIN_MS + 1).toISOString();
            listAll.mockImplementation(async () => [twin({ firstClaimedAt: at, updatedAt: at })]);

            expect(await deliveredIds()).toEqual([ROW_ID]);
        });

        test('an action of another type with the same key is not a twin', async () => {
            listAll.mockImplementation(async () => [twin({ type: 'bsky_reply' })]);

            expect(await deliveredIds()).toEqual([ROW_ID]);
        });

        test('an action with different content is not a twin', async () => {
            listAll.mockImplementation(async () => [twin({ params: { convoId: 'c1', text: 'Thanks a lot!' } })]);

            expect(await deliveredIds()).toEqual([ROW_ID]);
        });

        test('the row itself is not its own twin', async () => {
            listAll.mockImplementation(async () => [unverified()]);

            expect(await deliveredIds()).toEqual([ROW_ID]);
        });

        test('lists the actions afresh for each match of a row with a content key, and never for a row without one', async () => {
            const verification = build();
            await verification.verify([unverified(), unverified({ id: ROW_ID_2 })]);
            expect(listAll).toHaveBeenCalledTimes(2);

            contentKeys.bsky_dm.mockImplementation(() => undefined);
            await verification.verify([unverified({ id: 'eeeeeeee-1111-4222-8333-444444444444' })]);
            expect(listAll).toHaveBeenCalledTimes(2);
        });

        test('a listing failure after a match rejects the pass', async () => {
            listAll.mockImplementation(async () => {
                throw new Error('DynamoDB unavailable');
            });

            await expect(build().verify([unverified()])).rejects.toThrow('DynamoDB unavailable');
            expect(checks.bsky_dm).toHaveBeenCalledTimes(1);
            expect(resolveUnverified).not.toHaveBeenCalled();
        });
    });
});

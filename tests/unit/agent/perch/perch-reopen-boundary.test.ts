/**
 * The perch slot-rollover guarantee, exercised against a REAL {@link createPerchDriver} driving a
 * REAL {@link createConductor} — not hook-call-order strings.
 *
 * The risk this pins: `onSlotEnd` fires from inside the slot turn's own settle, while the
 * conductor is still finishing that turn, and the driver may start the NEXT slot synchronously
 * from the same callback (a trigger that arrived mid-slot and was folded into `pending`). If the
 * conductor were free to promote that next slot envelope into a turn, an identity reopen requested
 * at `onSlotEnd` would be starved for a whole slot — and the perch session would keep running on a
 * stale system prompt for an hour.
 *
 * What must happen instead: the requested reopen blocks any new turn, lands between the two slots,
 * and the next slot's envelope plays on the REPLACEMENT session.
 */
import { describe, test, expect, afterEach, mock, jest } from 'bun:test';
import { FakeClock } from '../../../helpers/fake-clock';
import { FakeJournal } from '../../../helpers/fake-journal';
import { fakeQueryFn } from '../../../helpers/fake-query';
import { FakeResumeStore } from '../../../helpers/fake-resume-store';
import * as frames from '../../../helpers/sdk-frames';
import { createPerchDriver } from '@/agent/perch/perch-driver';
import type { PerchConfig } from '@/agent/perch/types';
import { createConductor } from '@/agent/session/conductor';
import { createLedgerStore } from '@/agent/session/ledger';
import { DEFAULT_RETRY_CONFIG } from '@/config/retry-config';
import { sessionConfigSchema } from '@/config/schemas';

/** Flushes enough microtask ticks for the conductor's promise chains to settle. */
async function flush(): Promise<void> {
    for(let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain helper used only in tests, not a real async loop
        await Promise.resolve();
    }
}

const PERCH_CONFIG: PerchConfig = {
    enabled:               true,
    timezone:              'America/Los_Angeles',
    intervalMinutes:       60,
    jitterMinutes:         15,
    maxSessionMinutes:     20,
    wrapUpTimeoutMinutes:  3,
    interruptGraceMinutes: 7,
};

describe('perch slot rollover and a requested reopen', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('a reopen requested at slot end lands between the slots; the next slot plays on the replacement session', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const clock = new FakeClock(0);
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

        const conductor = createConductor({
            role:         'perch',
            queryFn,
            buildOptions: (resume?: string) => (resume === undefined ? {} : { resume }),
            clock,
            readRss:      () => 4096,
            ledgerStore:  createLedgerStore('perch', { logger: { error: jest.fn() } }),
            config:       sessionConfigSchema.parse({}),
            retryPolicy:  DEFAULT_RETRY_CONFIG.claude,
            journal:      new FakeJournal(),
            resumeStore:  new FakeResumeStore(),
            logger,
        });

        const driver = createPerchDriver({
            conductor,
            clock,
            config:              PERCH_CONFIG,
            getCurrentLocalHour: () => 14,
            logger,
            slotHooks:           {
                onSlotStart: () => undefined,
                // Exactly what src/app/sessions.ts's perch factory does at a slot boundary.
                onSlotEnd:   () => { conductor.requestReopen('an identity change'); },
            },
        });

        const openPromise = conductor.open();
        await flush();
        instances[0].emit(frames.init('perch-sess-1'));
        await openPromise;
        await flush();

        // Slot one starts and its envelope opens a turn on the first session.
        expect(driver.runSlot('afternoon')).toBe('started');
        await flush();
        expect(instances).toHaveLength(1);

        // A second trigger arrives mid-slot and is folded into `pending`, so the driver will start
        // slot two synchronously from slot one's own settle.
        expect(driver.runSlot('afternoon')).toBe('deferred');

        // Slot one's turn settles: onSlotEnd requests the reopen, and the driver immediately runs
        // slot two, whose envelope is submitted into the conductor.
        instances[0].emit(frames.resultSuccess());
        await flush();

        // The reopen happened, and slot two's envelope did NOT open a turn on the dying session.
        expect(instances).toHaveLength(2);
        expect(instances[0].closeCalls).toBe(1);
        expect(instances[1].receivedParams?.options.resume).toBe('perch-sess-1');

        instances[1].emit(frames.init('perch-sess-1'));
        await flush();
        await flush();

        // Slot two's envelope was never lost — it plays on the replacement session, behind that
        // session's own boot handshake.
        const replacementPrompts = JSON.stringify(instances[1].consumedPrompts);
        expect(replacementPrompts).toContain('[BOOT] Session reopened');
        expect(replacementPrompts).toContain('[PERCH');
        expect(instances).toHaveLength(2);

        driver.stop();
    });

    test('with no identity change pending, a slot rollover starts the next slot on the same session', async () => {
        const { queryFn, instances } = fakeQueryFn();
        const clock = new FakeClock(0);
        const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        const onSlotEnd = mock(() => undefined);

        const conductor = createConductor({
            role:         'perch',
            queryFn,
            buildOptions: () => ({}),
            clock,
            readRss:      () => 4096,
            ledgerStore:  createLedgerStore('perch', { logger: { error: jest.fn() } }),
            config:       sessionConfigSchema.parse({}),
            retryPolicy:  DEFAULT_RETRY_CONFIG.claude,
            journal:      new FakeJournal(),
            resumeStore:  new FakeResumeStore(),
            logger,
        });

        const driver = createPerchDriver({
            conductor,
            clock,
            config:              PERCH_CONFIG,
            getCurrentLocalHour: () => 14,
            logger,
            slotHooks:           { onSlotStart: () => undefined, onSlotEnd },
        });

        const openPromise = conductor.open();
        await flush();
        instances[0].emit(frames.init('perch-sess-1'));
        await openPromise;
        await flush();

        driver.runSlot('afternoon');
        await flush();
        driver.runSlot('afternoon');
        instances[0].emit(frames.resultSuccess());
        await flush();

        expect(onSlotEnd).toHaveBeenCalledTimes(1);
        // No reopen was asked for, so the second slot runs on the very same session.
        expect(instances).toHaveLength(1);
        expect(instances[0].consumedPrompts.filter(p => JSON.stringify(p).includes('[PERCH'))).toHaveLength(2);

        driver.stop();
    });
});

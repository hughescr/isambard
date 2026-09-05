import { describe, test, expect, afterEach, jest } from 'bun:test';
import { FakeClock } from '../../../helpers/fake-clock';
import { createSessionJournal } from '@/agent/session/journal';
import type { JournalEntry } from '@/agent/session/types';

/** Deferred-write fake backend: append() doesn't settle until the test calls resolveAppend()/rejectAppend(), so flush() timing is observable. */
function createDeferredBackend() {
    const calls: { role: string, entry: JournalEntry }[] = [];
    const pending: { resolve: () => void, reject: (error: unknown) => void }[] = [];
    return {
        calls,
        append: jest.fn((role: string, entry: JournalEntry) => {
            calls.push({ role, entry });
            return new Promise<void>((resolve, reject) => {
                pending.push({ resolve, reject });
            });
        }),
        readSince: jest.fn((_role: string, _sinceIso: string) => Promise.resolve<JournalEntry[]>([])),
        resolveAll(): void {
            const toResolve = pending.splice(0);
            for(const p of toResolve) {
                p.resolve();
            }
        },
        rejectAll(error: unknown): void {
            const toReject = pending.splice(0);
            for(const p of toReject) {
                p.reject(error);
            }
        },
    };
}

describe('createSessionJournal', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('append() calls backend.append with the role bound at construction', () => {
        const backend = createDeferredBackend();
        const journal = createSessionJournal({ backend, role: 'conversation', clock: new FakeClock(), logger: { error: jest.fn() } });

        journal.append({ type: 'shutdown', at: new Date(0) });

        expect(backend.calls).toEqual([{ role: 'conversation', entry: { type: 'shutdown', at: new Date(0) } }]);
        backend.resolveAll();
    });

    test('flush() resolves only after every in-flight append has settled', async () => {
        const backend = createDeferredBackend();
        const journal = createSessionJournal({ backend, role: 'conversation', clock: new FakeClock(), logger: { error: jest.fn() } });
        journal.append({ type: 'shutdown', at: new Date(0) });

        let flushed = false;
        const flushPromise = journal.flush().then(() => {
            flushed = true;
            return undefined;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(flushed).toBe(false);

        backend.resolveAll();
        await flushPromise;
        expect(flushed).toBe(true);
    });

    test('flush() resolves cleanly with no in-flight appends', async () => {
        const backend = createDeferredBackend();
        const journal = createSessionJournal({ backend, role: 'conversation', clock: new FakeClock(), logger: { error: jest.fn() } });

        await expect(journal.flush()).resolves.toBeUndefined();
    });

    test('a backend rejection logs via logger.error and does not reject flush()', async () => {
        const backend = createDeferredBackend();
        const errorLog = jest.fn();
        const journal = createSessionJournal({ backend, role: 'conversation', clock: new FakeClock(), logger: { error: errorLog } });
        journal.append({ type: 'shutdown', at: new Date(0) });

        const failure = new Error('DynamoDB throttled');
        backend.rejectAll(failure);
        await journal.flush();

        expect(errorLog).toHaveBeenCalledTimes(1);
        const [logArg] = errorLog.mock.calls[0] as [Record<string, unknown>];
        expect(logArg.error).toBe(failure);
        expect(logArg.kind).toBe('shutdown');
    });

    test('append() never throws synchronously even when the backend later rejects', () => {
        const backend = createDeferredBackend();
        const journal = createSessionJournal({ backend, role: 'conversation', clock: new FakeClock(), logger: { error: jest.fn() } });

        expect(() => {
            journal.append({ type: 'shutdown', at: new Date(0) });
        }).not.toThrow();
        backend.rejectAll(new Error('boom'));
    });

    test('a settled append is removed from the in-flight set (not retained forever)', async () => {
        const backend = createDeferredBackend();
        const deleteSpy = jest.spyOn(Set.prototype, 'delete');
        const journal = createSessionJournal({ backend, role: 'conversation', clock: new FakeClock(), logger: { error: jest.fn() } });

        journal.append({ type: 'shutdown', at: new Date(0) });
        backend.resolveAll();
        await Promise.resolve();
        await Promise.resolve();

        expect(deleteSpy).toHaveBeenCalledTimes(1);
    });

    test('two concurrent appends each remove only their own promise from the in-flight set', async () => {
        const backend = createDeferredBackend();
        const deleteSpy = jest.spyOn(Set.prototype, 'delete');
        const journal = createSessionJournal({ backend, role: 'conversation', clock: new FakeClock(), logger: { error: jest.fn() } });

        journal.append({ type: 'shutdown', at: new Date(0) });
        journal.append({ type: 'shutdown', at: new Date(1) });
        backend.resolveAll();
        await Promise.resolve();
        await Promise.resolve();

        expect(deleteSpy).toHaveBeenCalledTimes(2);
        await journal.flush();
    });

    test('readSince converts a ms timestamp to an ISO string and delegates to the backend', async () => {
        const backend = createDeferredBackend();
        const scripted: JournalEntry[] = [{ type: 'shutdown', at: new Date('2026-09-05T00:00:00.000Z') }];
        backend.readSince.mockImplementation(() => Promise.resolve(scripted));
        const journal = createSessionJournal({ backend, role: 'perch', clock: new FakeClock(), logger: { error: jest.fn() } });

        const result = await journal.readSince(Date.parse('2026-09-01T00:00:00.000Z'));

        expect(backend.readSince).toHaveBeenCalledWith('perch', '2026-09-01T00:00:00.000Z');
        expect(result).toBe(scripted);
    });
});

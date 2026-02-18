import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { mockLogger } from '../../../setup';
import type { ImapConnection } from '@/integrations/email/imap-connection';
import type { EmailProcessor } from '@/integrations/email/email-processor';
import type { EmailCounterStore } from '@/integrations/email/email-counters';
import type { EmailMetadata } from '@/integrations/email/types';
import type { ImapListenerConfig } from '@/integrations/email/imap-listener';
import { ImapListener } from '@/integrations/email/imap-listener';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeEmail(uid: number): EmailMetadata {
    return {
        uid,
        messageId:      `<msg-${uid}@example.com>`,
        from:           { address: 'sender@example.com' },
        to:             [{ address: 'recv@rungie.com' }],
        cc:             [],
        subject:        `Test email ${uid}`,
        date:           new Date('2024-01-15T10:00:00Z'),
        bodyText:       'Body text',
        hasAttachments: false,
        headers:        {},
    };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeImap(overrides: Partial<{
    connect:          ReturnType<typeof mock>
    disconnect:       ReturnType<typeof mock>
    ensureFolders:    ReturnType<typeof mock>
    fetchNewMessages: ReturnType<typeof mock>
    getMailboxCounts: ReturnType<typeof mock>
    idle:             ReturnType<typeof mock>
    cancelIdle:       ReturnType<typeof mock>
}> = {}): {
    conn:             ImapConnection
    connect:          ReturnType<typeof mock>
    disconnect:       ReturnType<typeof mock>
    ensureFolders:    ReturnType<typeof mock>
    fetchNewMessages: ReturnType<typeof mock>
    getMailboxCounts: ReturnType<typeof mock>
    idle:             ReturnType<typeof mock>
    cancelIdle:       ReturnType<typeof mock>
} {
    const connect          = overrides.connect          ?? mock(async () => undefined);
    const disconnect       = overrides.disconnect       ?? mock(async () => undefined);
    const ensureFolders    = overrides.ensureFolders    ?? mock(async () => undefined);
    const fetchNewMessages = overrides.fetchNewMessages ?? mock(async () => []);
    const getMailboxCounts = overrides.getMailboxCounts ?? mock(async () => ({ total: 3, unread: 1 }));
    const idle             = overrides.idle             ?? mock(async () => undefined);
    const cancelIdle       = overrides.cancelIdle       ?? mock(() => undefined);

    return {
        conn: { connect, disconnect, ensureFolders, fetchNewMessages, getMailboxCounts, idle, cancelIdle } as unknown as ImapConnection,
        connect,
        disconnect,
        ensureFolders,
        fetchNewMessages,
        getMailboxCounts,
        idle,
        cancelIdle,
    };
}

function makeCounters(overrides: Partial<{
    reset: ReturnType<typeof mock>
}> = {}): {
    store: EmailCounterStore
    reset: ReturnType<typeof mock>
} {
    const reset = overrides.reset ?? mock(async () => undefined);
    return {
        store: { reset } as unknown as EmailCounterStore,
        reset,
    };
}

function makeProcessor(result?: Error): {
    processor:    EmailProcessor
    processEmail: ReturnType<typeof mock>
} {
    const processEmail = result
        ? mock(async () => { throw result; })
        : mock(async () => ({ verdict: null, destinationFolder: 'CleanInbox', allowlistBypassed: false }));

    return {
        processor: { processEmail } as unknown as EmailProcessor,
        processEmail,
    };
}

// Flush async microtasks to let async setTimeout callbacks complete
async function flushAsync(): Promise<void> {
    for(let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

// ---------------------------------------------------------------------------
// Default config with a small poll interval for testing
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ImapListenerConfig = {
    useIdle:        false,
    idleTimeoutMs:  1_740_000,
    pollFallbackMs: 300_000,
};

const IDLE_CONFIG: ImapListenerConfig = {
    useIdle:        true,
    idleTimeoutMs:  1_740_000,
    pollFallbackMs: 300_000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImapListener', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllTimers();
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('start()', () => {
        test('connects and ensures folders', async () => {
            const { conn, connect, ensureFolders, fetchNewMessages } = makeImap();
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();

            expect(connect).toHaveBeenCalledTimes(1);
            expect(ensureFolders).toHaveBeenCalledTimes(1);
            expect(fetchNewMessages).toHaveBeenCalledTimes(1);

            await listener.stop();
        });

        test('fetches existing messages from INBOX with sinceUid=0 and processes them', async () => {
            const emails = [makeEmail(1), makeEmail(2)];
            const { conn, fetchNewMessages } = makeImap({
                fetchNewMessages: mock(async () => emails),
            });
            const { processor, processEmail } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();

            expect(fetchNewMessages).toHaveBeenCalledWith('INBOX', 0);
            expect(processEmail).toHaveBeenCalledTimes(2);
            expect(processEmail).toHaveBeenCalledWith(emails[0]);
            expect(processEmail).toHaveBeenCalledWith(emails[1]);

            await listener.stop();
        });

        test('schedules polling after initial fetch', async () => {
            const { conn } = makeImap();
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();

            // After start, a timer should be pending
            expect(jest.getTimerCount()).toBe(1);

            await listener.stop();
        });

        test('running getter returns true after start', async () => {
            const { conn } = makeImap();
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            expect(listener.running).toBe(false);
            await listener.start();
            expect(listener.running).toBe(true);

            await listener.stop();
        });

        test('when ensureFolders() rejects, disconnect() is called and error is re-thrown', async () => {
            const foldersError = new Error('Folder setup failed');
            const { conn, disconnect } = makeImap({
                ensureFolders: mock(async () => { throw foldersError; }),
            });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(listener.start()).rejects.toThrow('Folder setup failed');
            expect(disconnect).toHaveBeenCalledTimes(1);
        });

        test('when fetchAndProcess() rejects, disconnect() is called and error is re-thrown', async () => {
            const fetchError = new Error('Fetch failed on startup');
            const { conn, disconnect } = makeImap({
                fetchNewMessages: mock(async () => { throw fetchError; }),
            });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(listener.start()).rejects.toThrow('Fetch failed on startup');
            expect(disconnect).toHaveBeenCalledTimes(1);
        });

        test('when fetchAndProcess() rejects during start(), running is reset to false', async () => {
            const fetchError = new Error('Fetch failed on startup');
            const { conn } = makeImap({
                fetchNewMessages: mock(async () => { throw fetchError; }),
            });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            expect(listener.running).toBe(false);

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(listener.start()).rejects.toThrow('Fetch failed on startup');

            expect(listener.running).toBe(false);
        });

        test('on success, disconnect() is NOT called during start()', async () => {
            const { conn, disconnect } = makeImap();
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();

            expect(disconnect).not.toHaveBeenCalled();

            await listener.stop();
        });

        test('syncs counters from IMAP on startup via getMailboxCounts and counters.reset()', async () => {
            const getMailboxCounts = mock(async () => ({ total: 10, unread: 3 }));
            const { conn }         = makeImap({ getMailboxCounts });
            const { processor }    = makeProcessor();
            const counters         = makeCounters();

            const listener = new ImapListener(conn, processor, counters.store, DEFAULT_CONFIG);
            await listener.start();

            expect(getMailboxCounts).toHaveBeenCalledWith('CleanInbox');
            expect(counters.reset).toHaveBeenCalledWith(10, 3);

            await listener.stop();
        });

        test('start() succeeds even when counter sync throws (best-effort)', async () => {
            const getMailboxCounts = mock(async () => {
                throw new Error('IMAP counts failed');
            });
            const { conn }         = makeImap({ getMailboxCounts });
            const { processor }    = makeProcessor();
            const counters         = makeCounters();

            const listener = new ImapListener(conn, processor, counters.store, DEFAULT_CONFIG);
            // Should NOT throw
            await listener.start();

            expect(listener.running).toBe(true);
            expect(counters.reset).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining matcher
                msg: expect.stringContaining('sync email counters'),
            }));

            await listener.stop();
        });
    });

    describe('stop()', () => {
        test('clears timer and disconnects', async () => {
            const { conn, disconnect } = makeImap();
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();

            expect(jest.getTimerCount()).toBe(1);
            await listener.stop();

            expect(jest.getTimerCount()).toBe(0);
            expect(disconnect).toHaveBeenCalledTimes(1);
        });

        test('running getter returns false after stop', async () => {
            const { conn } = makeImap();
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();
            await listener.stop();

            expect(listener.running).toBe(false);
        });

        test('stop() when not started is a no-op (no disconnect called)', async () => {
            const { conn, disconnect } = makeImap();
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.stop();

            expect(disconnect).not.toHaveBeenCalled();
            expect(listener.running).toBe(false);
        });
    });

    describe('poll cycle', () => {
        test('fetches new messages since last UID and processes them', async () => {
            const initial = [makeEmail(10)];
            let callCount = 0;
            const fetchNewMessages = mock(async () => {
                callCount++;
                if(callCount === 1) {
                    return initial; // Initial fetch → lastUid becomes 10
                }
                return [makeEmail(11), makeEmail(12)]; // Second fetch → new messages
            });

            const { conn }                    = makeImap({ fetchNewMessages });
            const { processor, processEmail } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start(); // Initial fetch: email 10 processed, lastUid=10

            // Trigger poll timer and await async work
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();

            // After poll, fetchNewMessages should have been called with sinceUid=10
            expect(fetchNewMessages).toHaveBeenNthCalledWith(2, 'INBOX', 10);
            // Total processed: 1 initial + 2 from poll = 3
            expect(processEmail).toHaveBeenCalledTimes(3);

            await listener.stop();
        });

        test('poll with empty response processes no emails and reschedules', async () => {
            const { conn, fetchNewMessages } = makeImap();
            const { processor, processEmail } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start(); // Initial fetch returns [] (default mock)

            expect(processEmail).toHaveBeenCalledTimes(0);

            // Trigger poll cycle and await async work
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();

            // No new emails processed; fetchNewMessages called twice total (once initial, once on poll)
            expect(fetchNewMessages).toHaveBeenCalledTimes(2);
            expect(processEmail).toHaveBeenCalledTimes(0);
            // A new timer is scheduled after the poll
            expect(jest.getTimerCount()).toBe(1);

            await listener.stop();
        });

        test('individual email processing error is caught and logged without crashing', async () => {
            const emails = [makeEmail(1), makeEmail(2)];
            const { conn } = makeImap({
                fetchNewMessages: mock(async () => emails),
            });
            // First email throws, second succeeds
            let callCount = 0;
            const processEmail = mock(async () => {
                callCount++;
                if(callCount === 1) {
                    throw new Error('Processing failed');
                }
                return { verdict: null, destinationFolder: 'CleanInbox', allowlistBypassed: false };
            });
            const processor = { processEmail } as unknown as EmailProcessor;

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            // Should not throw
            await listener.start();

            // Both emails attempted; error logged for first
            expect(processEmail).toHaveBeenCalledTimes(2);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining matcher
                msg: expect.stringContaining('email'),
            }));

            await listener.stop();
        });

        test('poll cycle fetch error is caught and logged, continues polling', async () => {
            let callCount = 0;
            const fetchNewMessages = mock(async () => {
                callCount++;
                if(callCount > 1) {
                    throw new Error('Fetch failed');
                }
                return [];
            });

            const { conn } = makeImap({ fetchNewMessages });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();

            // Trigger poll — it should throw internally and be caught
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();

            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining matcher
                msg: expect.stringContaining('Poll'),
            }));

            // Timer should be rescheduled for next poll
            expect(jest.getTimerCount()).toBe(1);

            await listener.stop();
        });

        test('does not reschedule poll after stop() is called while poll is in-flight', async () => {
            // Use a controlled Promise to pause poll mid-flight
            let resolveFetch!: () => void;
            let callCount = 0;
            const fetchNewMessages = mock(() => {
                callCount++;
                if(callCount <= 1) {
                    // Initial fetch resolves immediately
                    return Promise.resolve([]);
                }
                // Second fetch (poll) pauses until we resolve it
                return new Promise<never[]>((resolve) => {
                    resolveFetch = () => resolve([]);
                });
            });

            const { conn } = makeImap({ fetchNewMessages });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();
            // Initial fetch complete, timer scheduled

            // Fire the poll timer - poll starts, pauses at fetchNewMessages
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // poll is now waiting for fetchNewMessages to resolve

            // Stop the listener while poll is awaiting fetchNewMessages
            const stopPromise = listener.stop();

            // Now resolve the paused fetch - poll will continue and check if(_running)
            resolveFetch();
            await stopPromise;
            await flushAsync();

            // After stop + poll completion: no timers should be pending
            expect(jest.getTimerCount()).toBe(0);

            // Advance timers far past poll interval to verify no further polls fire
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs * 3);
            await flushAsync();

            // Only 2 fetchNewMessages calls: 1 initial + 1 poll; none after stop
            expect(fetchNewMessages).toHaveBeenCalledTimes(2);
        });

        test('does not update lastUid when fetched emails is empty', async () => {
            let callCount = 0;
            const fetchNewMessages = mock(async () => {
                callCount++;
                if(callCount === 1) {
                    return []; // Initial: empty, lastUid stays 0
                }
                return []; // Poll: also empty, lastUid stays 0
            });

            const { conn } = makeImap({ fetchNewMessages });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();

            // Both fetches should use sinceUid=0 since no emails were ever received
            expect(fetchNewMessages).toHaveBeenNthCalledWith(1, 'INBOX', 0);
            expect(fetchNewMessages).toHaveBeenNthCalledWith(2, 'INBOX', 0);

            await listener.stop();
        });

        test('updates lastUid to max UID seen across all fetched messages', async () => {
            let callCount = 0;
            const fetchNewMessages = mock(async () => {
                callCount++;
                if(callCount === 1) {
                    return [makeEmail(5), makeEmail(10), makeEmail(7)]; // lastUid should become 10
                }
                return []; // verify called with sinceUid=10
            });

            const { conn } = makeImap({ fetchNewMessages });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();

            expect(fetchNewMessages).toHaveBeenNthCalledWith(2, 'INBOX', 10);

            await listener.stop();
        });

        test('processes at most MAX_EMAILS_PER_POLL emails per fetch and updates lastUid to last processed', async () => {
            // Generate 25 emails with UIDs 1..25
            const manyEmails = Array.from({ length: 25 }, (_, i) => makeEmail(i + 1));
            const fetchNewMessages = mock(async () => manyEmails);
            const { conn }                    = makeImap({ fetchNewMessages });
            const { processor, processEmail } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();

            // Only first 20 should be processed
            expect(processEmail).toHaveBeenCalledTimes(20);
            // lastUid should be UID 20 (not 25); next fetch call uses sinceUid=20
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();
            expect(fetchNewMessages).toHaveBeenNthCalledWith(2, 'INBOX', 20);

            await listener.stop();
        });

        test('logs warning when batch cap is hit', async () => {
            const manyEmails = Array.from({ length: 21 }, (_, i) => makeEmail(i + 1));
            const fetchNewMessages = mock(async () => manyEmails);
            const { conn }      = makeImap({ fetchNewMessages });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();

            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                total:     21,
                processed: 20,
            }));

            await listener.stop();
        });

        test('does not log batch cap warning when under batch cap', async () => {
            const fewEmails = Array.from({ length: 5 }, (_, i) => makeEmail(i + 1));
            const fetchNewMessages = mock(async () => fewEmails);
            const { conn }      = makeImap({ fetchNewMessages });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();

            // Verify no batch cap warning was emitted (processed === 20 indicates a batch cap warning)
            expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.objectContaining({ processed: 20 }));

            await listener.stop();
        });

        test('processes exactly MAX_EMAILS_PER_POLL (20) emails without capping or warning', async () => {
            // Exactly at the limit: 20 emails should NOT trigger the batch cap (> not >=)
            const exactEmails = Array.from({ length: 20 }, (_, i) => makeEmail(i + 1));
            const fetchNewMessages = mock(async () => exactEmails);
            const { conn }                    = makeImap({ fetchNewMessages });
            const { processor, processEmail } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();

            // All 20 should be processed (no capping)
            expect(processEmail).toHaveBeenCalledTimes(20);
            // No batch cap warning should be logged
            expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.objectContaining({ processed: 20 }));
            // lastUid should be UID 20 (max of all processed)
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();
            expect(fetchNewMessages).toHaveBeenNthCalledWith(2, 'INBOX', 20);

            await listener.stop();
        });
    });

    // ---------------------------------------------------------------------------
    // IDLE mode (useIdle=true)
    // ---------------------------------------------------------------------------

    describe('IDLE mode (useIdle=true)', () => {
        test('calls imap.idle() after initial fetchAndProcess on start', async () => {
            // idle() blocks on first call so the loop doesn't spin infinitely;
            // cancelIdle resolves it so stop() can finish cleanly.
            let idleResolve!: () => void;
            const idle = mock(() => new Promise<void>((resolve) => {
                idleResolve = resolve;
            }));
            const cancelIdle = mock(() => {
                idleResolve?.();
            });
            const { conn }   = makeImap({ idle, cancelIdle });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, IDLE_CONFIG);
            await listener.start();

            // Let the void idleLoop() enter idle()
            await flushAsync();

            expect(idle).toHaveBeenCalledTimes(1);

            await listener.stop();
        });

        test('does NOT schedule poll timer when useIdle=true', async () => {
            // idle() blocks until cancelled
            let idleResolve!: () => void;
            const idle = mock(() => new Promise<void>((resolve) => {
                idleResolve = resolve;
            }));
            const cancelIdle = mock(() => {
                idleResolve?.();
            });
            const { conn }   = makeImap({ idle, cancelIdle });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, IDLE_CONFIG);
            await listener.start();
            await flushAsync();

            // Verify idle was called (IDLE mode active), not polling
            expect(idle).toHaveBeenCalledTimes(1);
            // Only 1 timer: the idleTimeout timer (not a pollFallbackMs timer)
            expect(jest.getTimerCount()).toBe(1);

            await listener.stop();
        });

        test('re-establishes idle after processing new mail', async () => {
            let idleCallCount = 0;
            let secondIdleResolve!: () => void;

            // First idle() resolves immediately (simulates new mail notification)
            // Second idle() blocks until stop() calls cancelIdle()
            const idle = mock(() => {
                idleCallCount++;
                if(idleCallCount === 1) {
                    return Promise.resolve();
                }
                return new Promise<void>((resolve) => {
                    secondIdleResolve = resolve;
                });
            });
            const cancelIdle = mock(() => {
                secondIdleResolve?.();
            });

            // Return one email on the second fetchNewMessages call (after first idle() resolves)
            let fetchCount = 0;
            const fetchNewMessages = mock(async () => {
                fetchCount++;
                if(fetchCount === 2) {
                    return [makeEmail(1)];
                }
                return [];
            });

            const { conn }      = makeImap({ idle, cancelIdle, fetchNewMessages });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, IDLE_CONFIG);
            await listener.start();
            // Flush: idleLoop enters first idle() → resolves → fetchAndProcess → enters second idle()
            await flushAsync();

            // idle() should have been called at least twice
            expect(idleCallCount).toBeGreaterThanOrEqual(2);

            await listener.stop();
        });

        test('cancels idle and disconnects on stop()', async () => {
            let idleResolve!: () => void;
            const idle = mock(() => new Promise<void>((resolve) => {
                idleResolve = resolve;
            }));
            const cancelIdle = mock(() => {
                idleResolve?.();
            });
            const disconnect = mock(async () => undefined);
            const { conn }   = makeImap({ idle, cancelIdle, disconnect });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, IDLE_CONFIG);
            await listener.start();
            await flushAsync();

            await listener.stop();

            expect(cancelIdle).toHaveBeenCalled();
            expect(disconnect).toHaveBeenCalledTimes(1);
        });

        test('IDLE timeout: sets timer that calls cancelIdle() after idleTimeoutMs', async () => {
            // idle() blocks until cancelIdle() is called (either by timeout or stop())
            let currentResolve!: () => void;
            const cancelIdle = mock(() => {
                currentResolve?.();
            });
            const idle = mock(() => new Promise<void>((resolve) => {
                currentResolve = resolve;
            }));
            const disconnect = mock(async () => undefined);
            const { conn }   = makeImap({ idle, cancelIdle, disconnect });
            const { processor } = makeProcessor();

            const config   = { ...IDLE_CONFIG, idleTimeoutMs: 29 * 60 * 1000 };
            const listener = new ImapListener(conn, processor, makeCounters().store, config);
            await listener.start();
            await flushAsync();

            // First idle() is now blocking. Advance timer to trigger the IDLE timeout.
            jest.advanceTimersByTime(29 * 60 * 1000);
            await flushAsync();

            // cancelIdle should have been called by the idleTimeout timer
            expect(cancelIdle).toHaveBeenCalled();

            // After timeout cancels idle, idleLoop iterates — second idle() starts.
            // stop() will cancel that and break the loop.
            await listener.stop();
        });

        test('IDLE failure: logs warning and waits pollFallbackMs before retrying', async () => {
            let idleCallCount = 0;
            let secondIdleResolve!: () => void;
            const idle = mock(() => {
                idleCallCount++;
                if(idleCallCount === 1) {
                    return Promise.reject(new Error('IDLE connection reset'));
                }
                // Second call blocks until stop() calls cancelIdle()
                return new Promise<void>((resolve) => {
                    secondIdleResolve = resolve;
                });
            });
            const cancelIdle = mock(() => {
                secondIdleResolve?.();
            });

            const config        = { ...IDLE_CONFIG, pollFallbackMs: 5000 };
            const { conn }      = makeImap({ idle, cancelIdle });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, config);
            await listener.start();
            await flushAsync();

            // logger.warn should have been called with the IDLE failure
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining matcher
                msg: expect.stringContaining('IDLE'),
            }));

            // The pollFallbackMs timer should be pending (idleLoop is waiting in pollFallbackDelay)
            expect(jest.getTimerCount()).toBeGreaterThanOrEqual(1);

            // Advance pollFallbackMs — second idle() call should happen
            jest.advanceTimersByTime(5000);
            await flushAsync();

            expect(idleCallCount).toBeGreaterThanOrEqual(2);

            await listener.stop();
        });

        test('does not call fetchAndProcess after idle() resolves when stop() was called', async () => {
            // idle() blocks until cancelIdle() is called by stop()
            let idleResolve!: () => void;
            const idle = mock(() => new Promise<void>((resolve) => {
                idleResolve = resolve;
            }));
            const cancelIdle = mock(() => {
                idleResolve?.();
            });
            const fetchNewMessages = mock(async () => []);
            const disconnect       = mock(async () => undefined);
            const { conn }         = makeImap({ idle, cancelIdle, disconnect, fetchNewMessages });
            const { processor }    = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, IDLE_CONFIG);
            await listener.start();
            await flushAsync();

            // idleLoop is now blocked in idle() — fetchNewMessages was called once (initial fetch)
            const fetchCountBefore = (fetchNewMessages as ReturnType<typeof mock>).mock.calls.length;

            // stop() calls cancelIdle() → idle() resolves → loop checks if(!this._running) → break
            await listener.stop();
            await flushAsync();

            // fetchNewMessages should NOT have been called again after stop
            expect((fetchNewMessages as ReturnType<typeof mock>).mock.calls.length).toBe(fetchCountBefore);
            expect(disconnect).toHaveBeenCalledTimes(1);
        });

        test('stop() during pollFallbackDelay resolves the delay and disconnects', async () => {
            // idle() always fails → pollFallbackDelay starts
            let idleCallCount = 0;
            const idle       = mock(() => {
                idleCallCount++;
                return Promise.reject(new Error('IDLE failed'));
            });
            const cancelIdle = mock(() => undefined);
            const disconnect = mock(async () => undefined);
            const config     = { ...IDLE_CONFIG, pollFallbackMs: 60_000 };
            const { conn }   = makeImap({ idle, cancelIdle, disconnect });
            const { processor } = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, config);
            await listener.start();
            await flushAsync();

            // pollFallbackDelay timer is now running (60s), idle() was called once
            expect(idleCallCount).toBe(1);

            // stop() clears the timer and resolves pollFallbackDelay via _pollFallbackResolve
            await listener.stop();

            // After stop, advance the pollFallbackMs to confirm the loop does NOT call idle() again
            jest.advanceTimersByTime(60_000);
            await flushAsync();

            // idle() should NOT have been called again — the loop exited on stop()
            expect(idleCallCount).toBe(1);
            expect(disconnect).toHaveBeenCalledTimes(1);
        });
    });

    // ---------------------------------------------------------------------------
    // polling mode (useIdle=false) additional checks
    // ---------------------------------------------------------------------------

    describe('polling mode (useIdle=false) additional checks', () => {
        test('does NOT call imap.idle() when useIdle=false', async () => {
            const { conn, idle } = makeImap();
            const { processor }  = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();
            await flushAsync();

            expect(idle).not.toHaveBeenCalled();

            await listener.stop();
        });

        test('stop() in polling mode calls cancelIdle() (no-op since no IDLE in progress)', async () => {
            const { conn, cancelIdle } = makeImap();
            const { processor }        = makeProcessor();

            const listener = new ImapListener(conn, processor, makeCounters().store, DEFAULT_CONFIG);
            await listener.start();
            await listener.stop();

            // cancelIdle is always called in stop() — it's a no-op when no IDLE is active
            expect(cancelIdle).toHaveBeenCalledTimes(1);
        });
    });
});

import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { mockLogger } from '../../../setup';
import type { EmailProcessor } from '@/integrations/email/email-processor';
import type { EmailMetadata } from '@/integrations/email/types';
import type { WildDuckClient, WildDuckMessageSummary } from '@/integrations/email/wildduck-client';
import { type WildDuckListenerConfig, WildDuckListener } from '@/integrations/email/wildduck-listener';
import type { ServiceHealthRegistry } from '@/services';

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
        attachments:    [],
    };
}

function makeSummary(uid: number): WildDuckMessageSummary {
    return {
        id:          uid,
        from:        { address: 'sender@example.com', name: 'Sender' },
        subject:     `Test email ${uid}`,
        date:        '2024-01-15T10:00:00Z',
        intro:       'Body text',
        attachments: [],
    };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeWildDuckClient(overrides: Partial<{
    listMessages:   ReturnType<typeof mock>
    getFullMessage: ReturnType<typeof mock>
    getAuthToken:   ReturnType<typeof mock>
    getApiUrl:      ReturnType<typeof mock>
}> = {}): {
    client:         WildDuckClient
    listMessages:   ReturnType<typeof mock>
    getFullMessage: ReturnType<typeof mock>
    getAuthToken:   ReturnType<typeof mock>
    getApiUrl:      ReturnType<typeof mock>
} {
    const listMessages   = overrides.listMessages   ?? mock(() => Promise.resolve([]));
    const getFullMessage = overrides.getFullMessage ?? mock(() => Promise.resolve(null));
    const getAuthToken   = overrides.getAuthToken   ?? mock(() => 'test-token');
    const getApiUrl      = overrides.getApiUrl      ?? mock(() => 'https://wildduck.example.com');

    return {
        client: { listMessages, getFullMessage, getAuthToken, getApiUrl } as unknown as WildDuckClient,
        listMessages,
        getFullMessage,
        getAuthToken,
        getApiUrl,
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

function makeHealthRegistry(): {
    registry:    ServiceHealthRegistry
    sendEvent:   ReturnType<typeof mock>
    isAvailable: ReturnType<typeof mock>
    getState:    ReturnType<typeof mock>
} {
    const sendEvent   = mock(() => undefined);
    const isAvailable = mock(() => true);
    const getState    = mock(() => 'online' as const);
    return {
        registry: { sendEvent, isAvailable, getState } as unknown as ServiceHealthRegistry,
        sendEvent,
        isAvailable,
        getState,
    };
}

// Flush async microtasks to let async setTimeout callbacks complete
async function flushAsync(): Promise<void> {
    for(let i = 0; i < 20; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential: must flush microtasks one tick at a time
        await Promise.resolve();
    }
}

/**
 * Wait until predicate() becomes true, polling one microtask tick at a time. Unlike a fixed
 * tick-count flush, this ties test progression to a real observable completion signal, so it
 * remains correct no matter how many microtask turns the underlying JS engine happens to need
 * for a given async chain to settle — a hazard that showed up as platform-dependent (Linux vs
 * macOS) mutation-testing survivors when this file relied on flushAsync()'s fixed tick count to
 * gate assertions.
 */
async function waitFor(predicate: () => boolean, description: string): Promise<void> {
    const maxTicks = 5000;
    for(let i = 0; i < maxTicks; i++) {
        if(predicate()) {
            return;
        }
        // eslint-disable-next-line no-await-in-loop -- sequential: must poll microtasks one tick at a time until predicate settles
        await Promise.resolve();
    }
    throw new Error(`waitFor timed out after ${maxTicks} ticks: ${description}`);
}

interface PollableListener {
    poll: (generation?: number) => Promise<void>
}

interface FetchingListener {
    fetchAndProcess: (generation?: number) => Promise<boolean>
}

/**
 * Patch a WildDuckListener instance's private poll() so tests can deterministically await each
 * fire-and-forget invocation triggered by the fallback-poll timer, instead of guessing how many
 * microtask ticks are needed for it to settle. Stryker's per-test mutation coverage tracking is
 * keyed off "the currently running test" — a test that returns while an orphaned poll() promise
 * chain is still executing risks that chain's mutant coverage being attributed to whichever test
 * happens to run next (which is platform-dependent, since it hinges on microtask interleaving).
 * This closes that window by giving the test a handle on the real promise instead of a guess.
 *
 * Call this AFTER any setup (e.g. start()) that itself synchronously awaits its own work, so only
 * later, timer-triggered invocations end up queued.
 */
function trackPoll(listener: WildDuckListener): { nextPoll: () => Promise<void> } {
    const pending: Promise<void>[] = [];
    const target   = listener as unknown as PollableListener;
    const original = target.poll.bind(listener);
    target.poll = (generation) => {
        const result = original(generation);
        pending.push(result);
        return result;
    };
    return {
        nextPoll: async () => {
            const result = pending.shift();
            if(result === undefined) {
                throw new Error('trackPoll: nextPoll() called with no pending poll() invocation — did you forget jest.advanceTimersByTime()?');
            }
            await result;
        },
    };
}

/**
 * Same rationale as trackPoll(), but for fetchAndProcess() — also invoked fire-and-forget, this
 * time by the SSE 'message' event handler (`void this.fetchAndProcess()`).
 *
 * Call this AFTER start(), which synchronously awaits its own fetchAndProcess() call during
 * backlog drain; patching before start() would queue that already-settled call first, and the
 * next nextFetch() would resolve immediately instead of waiting for the real trigger under test.
 */
function trackFetchAndProcess(listener: WildDuckListener): { nextFetch: () => Promise<void> } {
    const pending: Promise<boolean>[] = [];
    const target   = listener as unknown as FetchingListener;
    const original = target.fetchAndProcess.bind(listener);
    target.fetchAndProcess = (generation) => {
        const result = original(generation);
        pending.push(result);
        return result;
    };
    return {
        nextFetch: async () => {
            const result = pending.shift();
            if(result === undefined) {
                throw new Error('trackFetchAndProcess: nextFetch() called with no pending fetchAndProcess() invocation');
            }
            await result;
        },
    };
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: WildDuckListenerConfig = {
    pollFallbackMs:      300_000,
    sseReconnectDelayMs: 5000,
    maxEmailsPerPoll:    20,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WildDuckListener', () => {
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

    // -----------------------------------------------------------------------
    // running getter
    // -----------------------------------------------------------------------

    describe('running getter', () => {
        test('returns false before start', () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            expect(listener.running).toBe(false);
        });

        test('returns true after start', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            expect(listener.running).toBe(true);

            await listener.stop();
        });

        test('returns false after stop', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            await listener.stop();

            expect(listener.running).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // start()
    // -----------------------------------------------------------------------

    describe('start()', () => {
        test('drains backlog via fetchAndProcess() on startup', async () => {
            const { client, listMessages } = makeWildDuckClient();
            const { processor }            = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            expect(listMessages).toHaveBeenCalledTimes(1);

            await listener.stop();
        });

        test('fetches unseen messages from INBOX on startup', async () => {
            const { client, listMessages } = makeWildDuckClient({
                listMessages: mock(async () => [makeSummary(1), makeSummary(2)]),
            });
            const getFullMessage = mock(async (_folder: string, uid: number) => makeEmail(uid));
            (client as unknown as { getFullMessage: ReturnType<typeof mock> }).getFullMessage = getFullMessage;
            const { processor, processEmail } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            expect(listMessages).toHaveBeenCalledWith('INBOX', { unseen: true, limit: 21 });
            expect(processEmail).toHaveBeenCalledTimes(2);

            await listener.stop();
        });

        test('when fetchAndProcess() throws during start(), running is reset and error is re-thrown', async () => {
            const fetchError = new Error('List failed on startup');
            const { client }  = makeWildDuckClient({
                listMessages: mock(async () => { throw fetchError; }),
            });
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);

            await expect(listener.start()).rejects.toThrow('List failed on startup');
            expect(listener.running).toBe(false);
        });

        test('when stop() is called while start() is draining a backlog, the loop exits after current batch', async () => {
            let listCount = 0;
            let resolveSecondList = (_value: WildDuckMessageSummary[]): void => {
                throw new Error('second listMessages call was not initialized');
            };
            const listMessages = mock(() => {
                listCount++;
                if(listCount === 1) {
                    // First list: 21 summaries — batch cap hit, loop will re-poll
                    return Promise.resolve(Array.from({ length: 21 }, (_, i) => makeSummary(i + 1)));
                }
                // Second list: blocks until test resolves it
                return new Promise<WildDuckMessageSummary[]>((resolve) => {
                    resolveSecondList = resolve;
                });
            });
            // getFullMessage needs to return something for the summaries
            const getFullMessage = mock(async (_folder: string, uid: number) => makeEmail(uid));

            const { client } = makeWildDuckClient({ listMessages, getFullMessage });
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);

            // Fire start() without awaiting — it blocks on the second list
            const startPromise = listener.start();

            // Wait until listMessages #2 is in-flight rather than guessing a microtask count.
            await waitFor(() => listCount === 2, 'second listMessages call is blocked');

            // Second list is now in-flight — call stop() while blocked
            const stopPromise = listener.stop();

            // Resolve the paused second list — returns empty (not cap hit)
            // _running is now false, so loop exits
            resolveSecondList([]);

            // Await both to settle
            await startPromise;
            await stopPromise;

            expect(listener.running).toBe(false);
            expect(listCount).toBe(2);
        });

        test('stopped startup cannot install SSE or a poll timer after its fetch settles', async () => {
            let resolveFirst!: (value: WildDuckMessageSummary[]) => void;
            const { client, listMessages } = makeWildDuckClient({
                listMessages: mock(() => new Promise<WildDuckMessageSummary[]>((resolve) => {
                    resolveFirst = resolve;
                })),
            });
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);

            const startup = listener.start();
            await listener.stop();
            resolveFirst([]);
            await startup;

            expect(listener.running).toBe(false);
            expect(jest.getTimerCount()).toBe(0);
            expect(listMessages).toHaveBeenCalledTimes(1);
        });

        test('stopped startup discards summaries returned after stop', async () => {
            let resolveList!: (value: WildDuckMessageSummary[]) => void;
            const { client, getFullMessage } = makeWildDuckClient({
                listMessages: mock(() => new Promise<WildDuckMessageSummary[]>((resolve) => {
                    resolveList = resolve;
                })),
                getFullMessage: mock(async () => makeEmail(1)),
            });
            const { processor, processEmail } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            const startup = listener.start();
            await listener.stop();
            resolveList([makeSummary(1)]);
            await startup;
            expect(getFullMessage).not.toHaveBeenCalled();
            expect(processEmail).not.toHaveBeenCalled();
            expect(jest.getTimerCount()).toBe(0);
        });

        test('a stopped generation cannot report a capped batch after its list returns', async () => {
            let resolveList!: (value: WildDuckMessageSummary[]) => void;
            let listCount = 0;
            const { client, getFullMessage } = makeWildDuckClient({
                listMessages: mock(() => {
                    listCount++;
                    if(listCount === 1) {
                        return Promise.resolve([]);
                    }
                    return new Promise<WildDuckMessageSummary[]>((resolve) => {
                        resolveList = resolve;
                    });
                }),
            });
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const fetch = listener as unknown as FetchingListener;
            const batch = fetch.fetchAndProcess();
            await listener.stop();
            resolveList(Array.from({ length: 21 }, (_, i) => makeSummary(i + 1)));
            expect(await batch).toBe(false);
            expect(getFullMessage).not.toHaveBeenCalled();
        });

        test('stop during full-message fetch discards the fetched email', async () => {
            let resolveEmail!: (value: EmailMetadata) => void;
            let fetchStarted = false;
            const { client } = makeWildDuckClient({
                listMessages:   mock(async () => [makeSummary(1)]),
                getFullMessage: mock(() => new Promise<EmailMetadata>((resolve) => {
                    resolveEmail = resolve;
                    fetchStarted = true;
                })),
            });
            const { processor, processEmail } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            const startup = listener.start();
            await waitFor(() => fetchStarted, 'full-message request started');
            await listener.stop();
            resolveEmail(makeEmail(1));
            await startup;
            expect(processEmail).not.toHaveBeenCalled();
        });

        test('old startup completion cannot alter a restarted listener', async () => {
            let resolveFirst!: (value: WildDuckMessageSummary[]) => void;
            let calls = 0;
            const { client, listMessages } = makeWildDuckClient({
                listMessages: mock(() => {
                    calls++;
                    if(calls === 1) {
                        return new Promise<WildDuckMessageSummary[]>((resolve) => {
                            resolveFirst = resolve;
                        });
                    }
                    return Promise.resolve([]);
                }),
            });
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);

            const oldStart = listener.start();
            await listener.stop();
            const newStart = listener.start();
            expect(listener.running).toBe(true);
            expect(jest.getTimerCount()).toBe(0);
            expect(listMessages).toHaveBeenCalledTimes(1);

            resolveFirst([]);
            await oldStart;
            await newStart;
            expect(listener.running).toBe(true);
            expect(jest.getTimerCount()).toBe(1);
            expect(listMessages).toHaveBeenCalledTimes(2);
            await listener.stop();
        });

        test('late startup failure cannot stop a restarted generation', async () => {
            let rejectOld!: (error: Error) => void;
            let calls = 0;
            const { client } = makeWildDuckClient({
                listMessages: mock(() => {
                    calls++;
                    if(calls === 1) {
                        return new Promise<WildDuckMessageSummary[]>((_resolve, reject) => {
                            rejectOld = reject;
                        });
                    }
                    return Promise.resolve([]);
                }),
            });
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            const oldStart = listener.start().catch((error: unknown) => error);
            await listener.stop();
            const newStart = listener.start();
            rejectOld(new Error('old generation failed'));
            expect(await oldStart).toEqual(new Error('old generation failed'));
            await newStart;
            expect(listener.running).toBe(true);
            expect(jest.getTimerCount()).toBe(1);
            await listener.stop();
        });

        test('restart waits for in-flight email processing before fetching the same unseen UID', async () => {
            let finishClassification!: () => void;
            const classification = new Promise<void>((resolve) => {
                finishClassification = resolve;
            });
            let unseen = true;
            const listMessages = mock(async () => (unseen ? [makeSummary(1)] : []));
            const { client } = makeWildDuckClient({
                listMessages,
                getFullMessage: mock(async () => makeEmail(1)),
            });
            let activeProcessors = 0;
            let maxActiveProcessors = 0;
            const processEmail = mock(async () => {
                activeProcessors++;
                maxActiveProcessors = Math.max(maxActiveProcessors, activeProcessors);
                await classification;
                unseen = false; // moving the email removes it from the unseen inbox query
                activeProcessors--;
                return { verdict: null, destinationFolder: 'CleanInbox', allowlistBypassed: false };
            });
            const listener = new WildDuckListener(client, { processEmail } as unknown as EmailProcessor, DEFAULT_CONFIG);

            const oldStart = listener.start();
            await waitFor(() => activeProcessors === 1, 'first email processing is awaiting classification');
            await listener.stop();
            const newStart = listener.start();
            expect(listener.running).toBe(true);
            expect(listMessages).toHaveBeenCalledTimes(1);
            expect(processEmail).toHaveBeenCalledTimes(1);
            expect(jest.getTimerCount()).toBe(0);

            finishClassification();
            await oldStart;
            await newStart;
            expect(listMessages).toHaveBeenCalledTimes(2);
            expect(processEmail).toHaveBeenCalledTimes(1);
            expect(maxActiveProcessors).toBe(1);
            expect(jest.getTimerCount()).toBe(1);
            await listener.stop();
        });

        test('processing stays bounded and restart waits for every admitted email after stop', async () => {
            let listCount = 0;
            const { client, getFullMessage } = makeWildDuckClient({
                listMessages: mock(async () => {
                    listCount++;
                    return listCount === 1 ? Array.from({ length: 7 }, (_, i) => makeSummary(i + 1)) : [];
                }),
                getFullMessage: mock(async (_folder: string, uid: number) => makeEmail(uid)),
            });
            const finish = new Map<number, () => void>();
            const processEmail = mock((email: EmailMetadata) => new Promise<void>((resolve) => {
                finish.set(email.uid, resolve);
            }));
            const listener = new WildDuckListener(client, { processEmail } as unknown as EmailProcessor, DEFAULT_CONFIG);

            const oldStart = listener.start();
            await waitFor(() => finish.size === 4, 'initial worker pool filled');
            expect(getFullMessage).toHaveBeenCalledTimes(4);

            finish.get(1)?.();
            await waitFor(() => finish.size === 5, 'a freed worker admitted one more email');
            expect(getFullMessage).toHaveBeenCalledTimes(5);

            await listener.stop();
            const newStart = listener.start();
            expect(listCount).toBe(1);
            for(const complete of finish.values()) {
                complete();
            }
            await Promise.all([oldStart, newStart]);

            expect(listCount).toBe(2);
            expect(getFullMessage).toHaveBeenCalledTimes(5);
            expect(processEmail).toHaveBeenCalledTimes(5);
            await listener.stop();
        });

        test('a malformed queued summary cannot release the restart guard before admitted effects settle', async () => {
            let malformedRead = false;
            const summaries = [
                makeSummary(1), makeSummary(2), makeSummary(3), makeSummary(4),
                null as unknown as WildDuckMessageSummary, makeSummary(6),
            ];
            Object.defineProperty(summaries, 4, {
                configurable: true,
                get() {
                    malformedRead = true;
                    return null;
                },
            });
            let listCount = 0;
            const { client, getFullMessage } = makeWildDuckClient({
                listMessages: mock(async () => {
                    listCount++;
                    return listCount === 1 ? summaries : [];
                }),
                getFullMessage: mock(async (_folder: string, uid: number) => makeEmail(uid)),
            });
            const finish = new Map<number, () => void>();
            const completed = new Set<number>();
            const processEmail = mock(async (email: EmailMetadata) => {
                await new Promise<void>((resolve) => {
                    finish.set(email.uid, resolve);
                });
                completed.add(email.uid);
            });
            const listener = new WildDuckListener(client, { processEmail } as unknown as EmailProcessor, DEFAULT_CONFIG);

            let oldSettled = false;
            const oldOutcome = listener.start().catch((error: unknown) => error).finally(() => {
                oldSettled = true;
            });
            await waitFor(() => finish.size === 4, 'four workers admitted valid summaries');
            finish.get(1)?.();
            await waitFor(() => malformedRead, 'freed worker reached malformed remote summary');
            expect(oldSettled).toBe(false);

            finish.get(2)?.();
            await waitFor(() => completed.has(2), 'second worker completed after the batch failure');
            expect(getFullMessage).toHaveBeenCalledTimes(4);

            await listener.stop();
            const restarted = listener.start();
            expect(listCount).toBe(1);
            finish.get(3)?.();
            await waitFor(() => completed.has(3), 'third worker completed after restart request');
            expect(listCount).toBe(1);
            finish.get(4)?.();
            expect(await oldOutcome).toBeInstanceOf(TypeError);
            await restarted;
            expect(listCount).toBe(2);
            expect(getFullMessage).toHaveBeenCalledTimes(4);
            await listener.stop();
        });

        test('concurrent start calls share one backlog drain and poll timer', async () => {
            let resolveList!: (value: WildDuckMessageSummary[]) => void;
            const { client, listMessages } = makeWildDuckClient({
                listMessages: mock(() => new Promise<WildDuckMessageSummary[]>((resolve) => {
                    resolveList = resolve;
                })),
            });
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);

            const first = listener.start();
            const second = listener.start();
            expect(listMessages).toHaveBeenCalledTimes(1);
            resolveList([]);
            await Promise.all([first, second]);
            expect(jest.getTimerCount()).toBe(1);
            await listener.stop();
        });

        test('concurrent start calls share a pending startup rejection', async () => {
            const startupError = new Error('Initial inbox query failed');
            let rejectList!: (error: Error) => void;
            const { client, listMessages } = makeWildDuckClient({
                listMessages: mock(() => new Promise<WildDuckMessageSummary[]>((_resolve, reject) => {
                    rejectList = reject;
                })),
            });
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);

            const first = listener.start();
            const second = listener.start();
            const firstOutcome = first.catch((error: unknown) => error);
            const secondOutcome = second.catch((error: unknown) => error);
            try {
                expect(listMessages).toHaveBeenCalledTimes(1);
                expect(Bun.peek.status(secondOutcome)).toBe('pending');
                rejectList(startupError);
                expect(await firstOutcome).toBe(startupError);
                expect(await secondOutcome).toBe(startupError);
            } finally {
                rejectList(startupError);
                await firstOutcome;
                await secondOutcome;
                await listener.stop();
            }
        });
    });

    // -----------------------------------------------------------------------
    // stop()
    // -----------------------------------------------------------------------

    describe('stop()', () => {
        test('stop() when not running is a no-op', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            // Should not throw
            await listener.stop();

            expect(listener.running).toBe(false);
        });

        test('stop() sets running to false', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            await listener.stop();

            expect(listener.running).toBe(false);
        });

        test('stop() clears pending poll timer', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            expect(jest.getTimerCount()).toBe(1);
            await listener.stop();

            expect(jest.getTimerCount()).toBe(0);
        });

        test('stop() called twice: first call clears timer, second call skips cleanup (timer count unchanged)', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            expect(jest.getTimerCount()).toBe(1);
            await listener.stop(); // Clears timer, running=false
            expect(jest.getTimerCount()).toBe(0);
            expect(listener.running).toBe(false);

            // Second stop: _running is false, guard should return early
            // If the guard is missing (mutant), cleanup body runs but timer is null so count stays 0 — same result
            // The observable difference: running must still be false (already is), no exception thrown
            await listener.stop();
            expect(listener.running).toBe(false);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('stop remains idempotent across repeated calls', async () => {
            const { client } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            await listener.stop();
            const generation = (listener as unknown as { generation: number }).generation;
            await listener.stop();
            expect(listener.running).toBe(false);
            expect((listener as unknown as { generation: number }).generation).toBe(generation);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('stop() before start(): does not set running to false spuriously (remains false)', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            // _running starts false; calling stop() without start() must be a safe no-op
            await listener.stop();

            // running was already false and must remain false — not throw, not change state
            expect(listener.running).toBe(false);

            // Verify start() still works correctly after the pre-start stop()
            await listener.start();
            expect(listener.running).toBe(true);
            await listener.stop();
            expect(listener.running).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // fetchAndProcess()
    // -----------------------------------------------------------------------

    describe('fetchAndProcess()', () => {
        test('with empty listMessages, processes no emails', async () => {
            const { client, listMessages } = makeWildDuckClient({
                listMessages: mock(async () => []),
            });
            const { processor, processEmail } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            expect(listMessages).toHaveBeenCalledTimes(1);
            expect(processEmail).not.toHaveBeenCalled();

            await listener.stop();
        });

        test('calls getFullMessage for each summary returned by listMessages', async () => {
            const summaries = [makeSummary(10), makeSummary(11)];
            const { client, listMessages, getFullMessage } = makeWildDuckClient({
                listMessages:   mock(async () => summaries),
                getFullMessage: mock(async (_folder: string, uid: number) => makeEmail(uid)),
            });
            const { processor, processEmail } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            expect(listMessages).toHaveBeenCalledWith('INBOX', { unseen: true, limit: 21 });
            expect(getFullMessage).toHaveBeenCalledTimes(2);
            expect(getFullMessage).toHaveBeenCalledWith('INBOX', 10);
            expect(getFullMessage).toHaveBeenCalledWith('INBOX', 11);
            expect(processEmail).toHaveBeenCalledTimes(2);

            await listener.stop();
        });

        test('skips email when getFullMessage returns null', async () => {
            const { client } = makeWildDuckClient({
                listMessages:   mock(async () => [makeSummary(1)]),
                getFullMessage: mock(() => Promise.resolve(null)),
            });
            const { processor, processEmail } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            expect(processEmail).not.toHaveBeenCalled();

            await listener.stop();
        });

        test('individual email processing error is caught and logged without crashing', async () => {
            const summaries = [makeSummary(1), makeSummary(2)];
            let callCount = 0;
            const getFullMessage = mock(async (_folder: string, uid: number) => makeEmail(uid));
            const { client } = makeWildDuckClient({
                listMessages: mock(async () => summaries),
                getFullMessage,
            });
            // First processEmail throws, second succeeds
            const processEmail = mock(async () => {
                callCount++;
                if(callCount === 1) {
                    throw new Error('Processing failed');
                }
                return { verdict: null, destinationFolder: 'CleanInbox', allowlistBypassed: false };
            });
            const processor = { processEmail } as unknown as EmailProcessor;

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            // Should not throw
            await listener.start();

            expect(processEmail).toHaveBeenCalledTimes(2);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: expect.stringContaining('email'),
            }));

            await listener.stop();
        });

        test('batch capping: processes maxEmailsPerPoll (20) when 21 returned, returns true', async () => {
            // 21 summaries → cap hit → process first 20, return true
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                if(listCount === 1) {
                    return Array.from({ length: 21 }, (_, i) => makeSummary(i + 1));
                }
                return []; // Second poll: no more
            });
            const getFullMessage = mock(async (_folder: string, uid: number) => makeEmail(uid));
            const { client } = makeWildDuckClient({ listMessages, getFullMessage });
            const { processor, processEmail } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            // First batch: 20 processed (UIDs 1-20); immediately re-polls since cap hit
            // Second batch: 0 (empty)
            expect(listCount).toBe(2);
            expect(processEmail).toHaveBeenCalledTimes(20);

            await listener.stop();
        });

        test('omitted batch cap processes the first 20 emails and leaves the overflow for a later poll', async () => {
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                return listCount === 1
                    ? Array.from({ length: 21 }, (_, i) => makeSummary(i + 1))
                    : [];
            });
            const getFullMessage = mock(async (_folder: string, uid: number) => makeEmail(uid));
            const { client } = makeWildDuckClient({ listMessages, getFullMessage });
            const { processor } = makeProcessor();
            const config: WildDuckListenerConfig = {
                pollFallbackMs:      DEFAULT_CONFIG.pollFallbackMs,
                sseReconnectDelayMs: DEFAULT_CONFIG.sseReconnectDelayMs,
            };
            const listener = new WildDuckListener(client, processor, config);

            try {
                await listener.start();

                expect(listMessages).toHaveBeenNthCalledWith(1, 'INBOX', { unseen: true, limit: 21 });
                expect(getFullMessage.mock.calls.map(call => call[1])).toEqual(
                    Array.from({ length: 20 }, (_, i) => i + 1)
                );
            } finally {
                await listener.stop();
            }
        });

        test('logs warning when batch cap is hit', async () => {
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                if(listCount === 1) {
                    return Array.from({ length: 21 }, (_, i) => makeSummary(i + 1));
                }
                return [];
            });
            const getFullMessage = mock(async (_folder: string, uid: number) => makeEmail(uid));
            const { client } = makeWildDuckClient({ listMessages, getFullMessage });
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                total:     21,
                processed: 20,
                msg:       'Email batch cap reached; remaining emails will be processed next poll',
            }));

            await listener.stop();
        });

        test('exactly maxEmailsPerPoll emails: no cap, no warning', async () => {
            const exactEmails = Array.from({ length: 20 }, (_, i) => makeSummary(i + 1));
            const { client } = makeWildDuckClient({
                listMessages:   mock(async () => exactEmails),
                getFullMessage: mock(async (_folder: string, uid: number) => makeEmail(uid)),
            });
            const { processor, processEmail } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            expect(processEmail).toHaveBeenCalledTimes(20);
            expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.objectContaining({ processed: 20 }));

            await listener.stop();
        });

        test('a malformed summary stops admission while admitted workers settle', async () => {
            const summaries = [makeSummary(1), makeSummary(2), makeSummary(3), makeSummary(4),
                null as unknown as WildDuckMessageSummary, makeSummary(6)];
            let malformedRead = false;
            Object.defineProperty(summaries, 4, {
                get() {
                    malformedRead = true;
                    return null;
                },
            });
            const { client, getFullMessage } = makeWildDuckClient({
                listMessages:   mock(async () => summaries),
                getFullMessage: mock(async (_folder: string, uid: number) => makeEmail(uid)),
            });
            const finish = new Map<number, () => void>();
            const processEmail = mock((email: EmailMetadata) => new Promise<void>((resolve) => {
                finish.set(email.uid, resolve);
            }));
            const listener = new WildDuckListener(client, { processEmail } as unknown as EmailProcessor, DEFAULT_CONFIG);
            const startup = listener.start().catch((error: unknown) => error);
            await waitFor(() => finish.size === 4, 'four workers admitted');

            finish.get(1)?.();
            await waitFor(() => malformedRead, 'first worker proceeds to malformed summary');
            finish.get(2)?.();
            await flushAsync();
            expect(getFullMessage).toHaveBeenCalledTimes(4);

            finish.get(3)?.();
            finish.get(4)?.();
            expect(await startup).toBeInstanceOf(TypeError);
            expect(getFullMessage).toHaveBeenCalledTimes(4);
            await listener.stop();
        });

        test('concurrent calls to fetchAndProcess() are dropped via processing guard', async () => {
            let resolveFirst!: (value: WildDuckMessageSummary[]) => void;
            let listCount = 0;
            const listMessages = mock(() => {
                listCount++;
                if(listCount === 1) {
                    // First call blocks until resolved
                    return new Promise<WildDuckMessageSummary[]>((resolve) => {
                        resolveFirst = resolve;
                    });
                }
                return Promise.resolve([]);
            });

            const { client } = makeWildDuckClient({ listMessages });
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);

            // Manually trigger start to get fetchAndProcess running
            // Access the private method via casting
            const fetchAndProcess = (listener as unknown as { fetchAndProcess: () => Promise<boolean> }).fetchAndProcess.bind(listener);

            // Start first call (will block)
            const firstCall = fetchAndProcess();

            // Start second concurrent call — should return false immediately (guard)
            const secondCallResult = await fetchAndProcess();
            expect(secondCallResult).toBe(false);
            expect(listCount).toBe(1); // Second call dropped, listMessages only called once

            // Now resolve the first call
            resolveFirst([]);
            await firstCall;
        });

        test('an older generation waiting for a batch cannot query unseen mail', async () => {
            let finishProcessing!: () => void;
            let processingStarted = false;
            const { client, listMessages } = makeWildDuckClient({
                listMessages:   mock(async () => [makeSummary(1)]),
                getFullMessage: mock(async () => makeEmail(1)),
            });
            const processEmail = mock(() => new Promise<void>((resolve) => {
                finishProcessing = resolve;
                processingStarted = true;
            }));
            const listener = new WildDuckListener(client, { processEmail } as unknown as EmailProcessor, DEFAULT_CONFIG);
            const startup = listener.start();
            await waitFor(() => processingStarted, 'current batch processing started');
            const oldFetch = (listener as unknown as FetchingListener).fetchAndProcess(0);
            finishProcessing();
            await startup;
            expect(await oldFetch).toBe(false);
            expect(listMessages).toHaveBeenCalledTimes(1);
            await listener.stop();
        });

        test('poll cycle: triggers fetch again after timer fires', async () => {
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                return [];
            });
            const { client } = makeWildDuckClient({ listMessages });
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start(); // listCount=1
            const { nextPoll } = trackPoll(listener);

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // listCount=2, poll cycle fully settled (including reschedule)

            expect(listCount).toBe(2);

            await listener.stop();
        });

        test('poll() catch block: when fetchAndProcess throws during poll, warns and continues', async () => {
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                if(listCount === 1) {
                    // First call is during start() backlog drain — succeeds
                    return [];
                }
                // Second call is from poll() triggered by timer — throws
                throw new Error('Network error during poll');
            });
            const { client } = makeWildDuckClient({ listMessages });
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start(); // listCount=1
            const { nextPoll } = trackPoll(listener);

            // Advance timer to trigger poll()
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // listCount=2 — throws inside poll(), fully settled (catch + reschedule)

            expect(listCount).toBe(2);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg:   'Poll cycle failed, will retry',
                error: 'Network error during poll',
            }));

            await listener.stop();
        });

        test('poll() catch block with non-Error thrown: converts to string in warn log', async () => {
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                if(listCount === 1) {
                    return [];
                }
                throw 'string error during poll';
            });
            const { client } = makeWildDuckClient({ listMessages });
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const { nextPoll } = trackPoll(listener);

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll();

            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg:   'Poll cycle failed, will retry',
                error: 'string error during poll',
            }));

            await listener.stop();
        });

        test('poll() reschedules after a successful poll cycle', async () => {
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                return [];
            });
            const { client } = makeWildDuckClient({ listMessages });
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start(); // listCount=1, timer scheduled
            const { nextPoll } = trackPoll(listener);

            // Advance timer once — triggers first poll
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // listCount=2, second timer scheduled

            // Advance timer again — triggers second poll, proving rescheduling happened
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // listCount=3

            expect(listCount).toBe(3);

            await listener.stop();
        });

        test('does not reschedule poll after stop() is called while poll is in-flight', async () => {
            let resolveFetch!: () => void;
            let callCount = 0;
            const listMessages = mock(() => {
                callCount++;
                if(callCount <= 1) {
                    return Promise.resolve([]);
                }
                // Second call (poll) pauses
                return new Promise<WildDuckMessageSummary[]>((resolve) => {
                    resolveFetch = () => resolve([]);
                });
            });

            const { client } = makeWildDuckClient({ listMessages });
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const { nextPoll } = trackPoll(listener);

            // Fire poll timer — poll() begins and blocks on the second (paused) listMessages() call
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            const pollSettled = nextPoll();

            // Wait until the blocked listMessages() call has actually started before stopping
            await waitFor(() => callCount === 2, 'poll() has begun its second (blocking) listMessages() call');

            // Stop while poll is awaiting
            const stopPromise = listener.stop();
            resolveFetch();
            await stopPromise;
            await pollSettled; // deterministically wait for poll()'s in-flight cycle to fully finish

            expect(jest.getTimerCount()).toBe(0);

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs * 3);
            await flushAsync();

            // Only 2 calls: initial + poll; none after stop
            expect(callCount).toBe(2);
        });

        test('old poll completion cannot replace the restarted listener timer', async () => {
            let resolveOldPoll!: (value: WildDuckMessageSummary[]) => void;
            let calls = 0;
            const { client, listMessages } = makeWildDuckClient({
                listMessages: mock(() => {
                    calls++;
                    if(calls === 2) {
                        return new Promise<WildDuckMessageSummary[]>((resolve) => {
                            resolveOldPoll = resolve;
                        });
                    }
                    return Promise.resolve([]);
                }),
            });
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const { nextPoll } = trackPoll(listener);
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            const oldPoll = nextPoll();
            await waitFor(() => calls === 2, 'old poll listMessages call');

            await listener.stop();
            const newStart = listener.start();
            expect(jest.getTimerCount()).toBe(0);
            expect(listMessages).toHaveBeenCalledTimes(2);
            resolveOldPoll([]);
            await oldPoll;
            await newStart;
            expect(listener.running).toBe(true);
            expect(jest.getTimerCount()).toBe(1);

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll();
            expect(listMessages).toHaveBeenCalledTimes(4);
            await listener.stop();
        });

        test('stale generation cannot schedule or run a fallback poll', async () => {
            const { client, listMessages } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const generation = (listener as unknown as { generation: number }).generation;
            await listener.stop();
            const internals = listener as unknown as {
                scheduleNextPoll: (generation: number) => void
                poll:             (generation: number) => Promise<void>
            };
            internals.scheduleNextPoll(generation);
            expect(jest.getTimerCount()).toBe(0);
            await internals.poll(generation);
            expect(listMessages).toHaveBeenCalledTimes(1);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('a queued old timer callback cannot orphan the restarted poll timer', async () => {
            const { client, listMessages } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const internals = listener as unknown as {
                timer:            ReturnType<typeof setTimeout> | null
                generation:       number
                scheduleNextPoll: (generation: number) => void
            };
            clearTimeout(internals.timer!);
            internals.timer = null;

            let queuedCallback!: () => void;
            const originalSetTimeout = globalThis.setTimeout;
            globalThis.setTimeout = ((callback: () => void, delay: number) => {
                queuedCallback = callback;
                return originalSetTimeout(callback, delay);
            }) as typeof setTimeout;
            try {
                internals.scheduleNextPoll(internals.generation);
            } finally {
                globalThis.setTimeout = originalSetTimeout;
            }

            await listener.stop();
            await listener.start();
            expect(jest.getTimerCount()).toBe(1);
            queuedCallback();
            await flushAsync();
            expect(listMessages).toHaveBeenCalledTimes(2);
            await listener.stop();
            expect(jest.getTimerCount()).toBe(0);
        });

        test('late successful poll cannot report recovery after stop', async () => {
            let resolvePoll!: (value: WildDuckMessageSummary[]) => void;
            let calls = 0;
            const { client } = makeWildDuckClient({
                listMessages: mock(() => {
                    calls++;
                    if(calls === 1) {
                        return Promise.resolve([]);
                    }
                    return new Promise<WildDuckMessageSummary[]>((resolve) => {
                        resolvePoll = resolve;
                    });
                }),
            });
            const { processor } = makeProcessor();
            const { registry, sendEvent } = makeHealthRegistry();
            const listener = new WildDuckListener(client, processor, { ...DEFAULT_CONFIG, healthRegistry: registry });
            await listener.start();
            (listener as unknown as { consecutivePollFails: number }).consecutivePollFails = 3;
            const { nextPoll } = trackPoll(listener);
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            const poll = nextPoll();
            await waitFor(() => calls === 2, 'late poll list started');
            await listener.stop();
            resolvePoll([]);
            await poll;
            expect(sendEvent).not.toHaveBeenCalledWith('email', 'CONNECT_SUCCESS');
        });

        test('late failed poll cannot log or report a connection loss after stop', async () => {
            let rejectPoll!: (error: Error) => void;
            let calls = 0;
            const { client } = makeWildDuckClient({
                listMessages: mock(() => {
                    calls++;
                    if(calls === 1) {
                        return Promise.resolve([]);
                    }
                    return new Promise<WildDuckMessageSummary[]>((_resolve, reject) => {
                        rejectPoll = reject;
                    });
                }),
            });
            const { processor } = makeProcessor();
            const { registry, sendEvent } = makeHealthRegistry();
            const listener = new WildDuckListener(client, processor, { ...DEFAULT_CONFIG, healthRegistry: registry });
            await listener.start();
            (listener as unknown as { consecutivePollFails: number }).consecutivePollFails = 2;
            const { nextPoll } = trackPoll(listener);
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            const poll = nextPoll();
            await waitFor(() => calls === 2, 'late poll list started');
            await listener.stop();
            mockLogger.warn.mockClear();
            rejectPoll(new Error('late failure'));
            await poll;
            expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.objectContaining({ msg: 'Poll cycle failed, will retry' }));
            expect(sendEvent).not.toHaveBeenCalledWith('email', 'CONNECTION_LOST', expect.anything());
        });
    });

    // -----------------------------------------------------------------------
    // SSE message handling
    // -----------------------------------------------------------------------

    describe('SSE message handling', () => {
        // EventSource is not available in Bun — mock it via globalThis so connectSSE() actually runs
        let RealEventSource: typeof EventSource | undefined;

        beforeEach(() => {
            // Save and override EventSource on globalThis
            RealEventSource = (globalThis as unknown as { EventSource?: typeof EventSource }).EventSource;
            (globalThis as unknown as Record<string, unknown>).EventSource = class MockEventSource extends EventTarget {
                static readonly CONNECTING = 0;
                static readonly OPEN       = 1;
                static readonly CLOSED     = 2;
                readonly CONNECTING = 0;
                readonly OPEN       = 1;
                readonly CLOSED     = 2;
                readonly url: string;
                readonly withCredentials = false;
                readyState = 1;
                onopen:       ((event: Event) => void) | null = null;
                onmessage:    ((event: MessageEvent) => void) | null = null;
                onerror:      ((event: Event) => void) | null = null;

                constructor(url: string) {
                    super();
                    this.url = url;
                }

                close() { this.readyState = 2; }
            };
        });

        afterEach(() => {
            // Restore the original EventSource (undefined in Bun)
            (globalThis as unknown as Record<string, unknown>).EventSource = RealEventSource;
        });

        test('malformed SSE message data logs warn and leaves the inbox untouched', async () => {
            const { client, listMessages } = makeWildDuckClient();
            const { processor, processEmail } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            // connectSSE() now runs because MockEventSource is installed;
            // get the EventTarget that was created and dispatch a bad-JSON message
            const sseSource = (listener as unknown as { sseSource: EventTarget | null }).sseSource;
            expect(sseSource).not.toBeNull();

            const event = new MessageEvent('message', { data: '{not valid json}' });
            sseSource!.dispatchEvent(event);

            await waitFor(() => mockLogger.warn.mock.calls.length > 0, 'warn logged for malformed SSE message data');

            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to parse SSE message data',
            }));
            // A malformed event is not a mailbox notification: it must not acquire
            // the single-flight worker or query unseen mail.
            expect(listMessages).toHaveBeenCalledTimes(1);
            expect(processEmail).not.toHaveBeenCalled();

            await listener.stop();
        });

        test('only an SSE EXISTS command triggers fetchAndProcess', async () => {
            const { client, listMessages } = makeWildDuckClient({
                listMessages: mock(async () => []),
            });
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const { nextFetch } = trackFetchAndProcess(listener);

            // Startup call
            expect(listMessages).toHaveBeenCalledTimes(1);

            // connectSSE() now runs; dispatch a valid EXISTS command
            const sseSource = (listener as unknown as { sseSource: EventTarget | null }).sseSource;
            expect(sseSource).not.toBeNull();

            const event = new MessageEvent('message', { data: JSON.stringify({ command: 'EXISTS' }) });
            sseSource!.dispatchEvent(event);

            await nextFetch(); // deterministically wait for the SSE-triggered fetchAndProcess() to settle

            // Should trigger another fetch
            expect(listMessages).toHaveBeenCalledTimes(2);

            sseSource!.dispatchEvent(new MessageEvent('message', {
                data: JSON.stringify({ command: 'EXPUNGE' }),
            }));
            await flushAsync();
            expect(listMessages).toHaveBeenCalledTimes(2);

            await listener.stop();
        });

        test('a superseded SSE source in the current generation cannot query the inbox', async () => {
            const { client, listMessages } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            const oldSource = (listener as unknown as { sseSource: EventTarget | null }).sseSource;
            expect(oldSource).not.toBeNull();
            // Model the hand-off that happens before an old source delivers a queued event.
            // It has the same generation, so source identity is the only valid fence.
            const replacement = Object.assign(new EventTarget(), { close: () => undefined });
            (listener as unknown as { sseSource: typeof replacement }).sseSource = replacement;
            oldSource!.dispatchEvent(new MessageEvent('message', {
                data: JSON.stringify({ command: 'EXISTS' }),
            }));
            await flushAsync();

            expect(listMessages).toHaveBeenCalledTimes(1);
            await listener.stop();
        });
    });

    // -----------------------------------------------------------------------
    // Health registry events
    // -----------------------------------------------------------------------

    describe('health registry events', () => {
        test('no health events when registry not configured', async () => {
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                if(listCount <= 1) {
                    return [];
                }
                throw new Error('Network error');
            });
            const { client } = makeWildDuckClient({ listMessages });
            const { processor } = makeProcessor();

            // No health registry in config
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const { nextPoll } = trackPoll(listener);

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll();

            // The poll failure path ran (recordPollFailure returns early with no
            // registry) — proven by the warn log — and no health event was emitted
            // anywhere, since there is no registry to receive one.
            expect(listCount).toBe(2);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg:   'Poll cycle failed, will retry',
                error: 'Network error',
            }));

            await listener.stop();
        });

        test('no CONNECT_SUCCESS event on first successful poll (not recovering)', async () => {
            const { client } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const { registry, sendEvent } = makeHealthRegistry();
            const config = { ...DEFAULT_CONFIG, healthRegistry: registry };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();
            const { nextPoll } = trackPoll(listener);

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll();

            // Should NOT emit CONNECT_SUCCESS when already online (no consecutive failures)
            expect(sendEvent).not.toHaveBeenCalledWith('email', 'CONNECT_SUCCESS');

            await listener.stop();
        });

        test('no CONNECTION_LOST event until 3 consecutive poll failures', async () => {
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                if(listCount === 1) {
                    return []; // startup succeeds
                }
                throw new Error('Network error');
            });
            const { client } = makeWildDuckClient({ listMessages });
            const { processor } = makeProcessor();
            const { registry, sendEvent } = makeHealthRegistry();
            const config = { ...DEFAULT_CONFIG, healthRegistry: registry };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start(); // listCount=1
            const { nextPoll } = trackPoll(listener);

            // Trigger 2 failing polls — not yet at threshold
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // listCount=2 (fails)

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // listCount=3 (fails)

            expect(sendEvent).not.toHaveBeenCalledWith('email', 'CONNECTION_LOST', expect.anything());

            await listener.stop();
        });

        test('emits CONNECTION_LOST after 3 consecutive poll failures', async () => {
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                if(listCount === 1) {
                    return []; // startup succeeds
                }
                throw new Error('Network error');
            });
            const { client } = makeWildDuckClient({ listMessages });
            const { processor } = makeProcessor();
            const { registry, sendEvent } = makeHealthRegistry();
            const config = { ...DEFAULT_CONFIG, healthRegistry: registry };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start(); // listCount=1
            const { nextPoll } = trackPoll(listener);

            // Trigger 3 failing polls to hit threshold
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // failure 1

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // failure 2

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // failure 3 — threshold hit

            expect(sendEvent).toHaveBeenCalledWith('email', 'CONNECTION_LOST', expect.objectContaining({
                error: 'Network error',
            }));

            await listener.stop();
        });

        test('emits CONNECT_SUCCESS after recovery from 3+ failures', async () => {
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                if(listCount === 1) {
                    return []; // startup succeeds
                }
                if(listCount <= 4) {
                    throw new Error('Network error'); // 3 failures to reach threshold
                }
                return []; // recovery
            });
            const { client } = makeWildDuckClient({ listMessages });
            const { processor } = makeProcessor();
            const { registry, sendEvent } = makeHealthRegistry();
            const config = { ...DEFAULT_CONFIG, healthRegistry: registry };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start(); // listCount=1
            const { nextPoll } = trackPoll(listener);

            // 3 failing polls
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // failure 1

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // failure 2

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // failure 3 — threshold hit, CONNECTION_LOST emitted

            expect(sendEvent).toHaveBeenCalledWith('email', 'CONNECTION_LOST', expect.anything());
            const connectLostCallCount = (sendEvent.mock.calls as unknown[][]).filter(
                c => c[1] === 'CONNECTION_LOST'
            ).length;
            expect(connectLostCallCount).toBe(1);

            // Successful poll — recovery
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll();

            expect(sendEvent).toHaveBeenCalledWith('email', 'CONNECT_SUCCESS');

            await listener.stop();
        });

        test('a successful recovery resets the failure streak before counting later failures', async () => {
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                if(listCount === 1 || listCount === 5) {
                    return [];
                }
                throw new Error('Network error');
            });
            const { client } = makeWildDuckClient({ listMessages });
            const { processor } = makeProcessor();
            const { registry, sendEvent } = makeHealthRegistry();
            const listener = new WildDuckListener(client, processor, {
                ...DEFAULT_CONFIG,
                healthRegistry: registry,
            });

            try {
                await listener.start();
                const { nextPoll } = trackPoll(listener);
                const runPoll = async (): Promise<void> => {
                    jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
                    await nextPoll();
                };

                await runPoll();
                await runPoll();
                await runPoll();
                expect(sendEvent).toHaveBeenCalledWith('email', 'CONNECTION_LOST', expect.anything());

                await runPoll();
                expect(sendEvent).toHaveBeenCalledWith('email', 'CONNECT_SUCCESS');
                const lostAfterRecovery = (sendEvent.mock.calls as unknown[][])
                    .filter(call => call[1] === 'CONNECTION_LOST').length;

                await runPoll();
                await runPoll();
                expect((sendEvent.mock.calls as unknown[][])
                    .filter(call => call[1] === 'CONNECTION_LOST')).toHaveLength(lostAfterRecovery);

                await runPoll();
                expect((sendEvent.mock.calls as unknown[][])
                    .filter(call => call[1] === 'CONNECTION_LOST')).toHaveLength(lostAfterRecovery + 1);
            } finally {
                await listener.stop();
            }
        });

        test('does not emit CONNECT_SUCCESS again on second consecutive successful poll', async () => {
            let listCount = 0;
            const listMessages = mock(async () => {
                listCount++;
                if(listCount === 1) {
                    return []; // startup
                }
                if(listCount <= 4) {
                    throw new Error('Network error'); // 3 failures
                }
                return []; // all subsequent succeed
            });
            const { client } = makeWildDuckClient({ listMessages });
            const { processor } = makeProcessor();
            const { registry, sendEvent } = makeHealthRegistry();
            const config = { ...DEFAULT_CONFIG, healthRegistry: registry };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();
            const { nextPoll } = trackPoll(listener);

            // 3 failing polls
            for(let i = 0; i < 3; i++) {
                jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
                // eslint-disable-next-line no-await-in-loop -- sequential: must await each poll cycle before triggering the next
                await nextPoll();
            }

            // Two successful polls
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // first success — CONNECT_SUCCESS

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await nextPoll(); // second success — no extra CONNECT_SUCCESS

            const connectSuccessCalls = (sendEvent.mock.calls as unknown[][]).filter(
                c => c[1] === 'CONNECT_SUCCESS'
            ).length;
            expect(connectSuccessCalls).toBe(1);

            await listener.stop();
        });
    });

    // -----------------------------------------------------------------------
    // SSE reconnect via ReconnectionLoop
    // -----------------------------------------------------------------------

    describe('SSE reconnect via ReconnectionLoop', () => {
        // Types for the fake EventSource infrastructure
        type EventType = 'open' | 'message' | 'error';
        interface FakeEventSourceInstance {
            listeners:        Map<EventType, ((evt: Event | MessageEvent) => void)[]>
            closed:           boolean
            close:            () => void
            addEventListener: (type: EventType, handler: (evt: Event | MessageEvent) => void) => void
            emit:             (type: EventType, evt?: Event | MessageEvent) => void
        }

        let fakeEventSourceInstances: FakeEventSourceInstance[];
        let FakeEventSource: ReturnType<typeof mock>;

        function firstFakeEventSource(): FakeEventSourceInstance {
            const source = fakeEventSourceInstances.at(0);
            if(source === undefined) {
                throw new Error('expected an EventSource instance');
            }
            return source;
        }

        beforeEach(() => {
            fakeEventSourceInstances = [];
            FakeEventSource = mock((_url: string) => {
                const listeners = new Map<EventType, ((evt: Event | MessageEvent) => void)[]>();
                const instance: FakeEventSourceInstance = {
                    listeners,
                    closed:           false,
                    close:            () => { instance.closed = true; },
                    addEventListener: (type, handler) => {
                        const list = listeners.get(type) ?? [];
                        list.push(handler);
                        listeners.set(type, list);
                    },
                    emit: (type, evt) => {
                        const list = listeners.get(type) ?? [];
                        for(const handler of list) {
                            handler(evt ?? new Event(type));
                        }
                    },
                };
                fakeEventSourceInstances.push(instance);
                return instance;
            });
            // Install fake EventSource on global
            (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
        });

        afterEach(() => {
            // Remove fake EventSource — dynamic delete is the correct approach for cleaning up global state
            delete (globalThis as unknown as Record<string, unknown>).EventSource;
        });

        test('start() creates an EventSource via the SSE reconnect loop', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            // An EventSource should have been constructed
            expect(FakeEventSource).toHaveBeenCalledTimes(1);
            expect(FakeEventSource).toHaveBeenCalledWith(
                expect.stringContaining('/users/me/updates')
            );

            await listener.stop();
            expect(fakeEventSourceInstances[0]?.closed).toBe(true);
        });

        test('stopped startup leaves no SSE loop installed after its list settles', async () => {
            let resolveList!: (value: WildDuckMessageSummary[]) => void;
            const { client } = makeWildDuckClient({
                listMessages: mock(() => new Promise<WildDuckMessageSummary[]>((resolve) => {
                    resolveList = resolve;
                })),
            });
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            const startup = listener.start();
            await listener.stop();
            resolveList([]);
            await startup;
            expect(fakeEventSourceInstances).toHaveLength(0);
            expect((listener as unknown as { sseReconnectLoop: unknown }).sseReconnectLoop).toBeNull();
        });

        test('configured SSE retry delay controls when a failed connection retries', async () => {
            const { client } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, {
                ...DEFAULT_CONFIG,
                sseReconnectDelayMs: 10_000,
            });
            await listener.start();
            firstFakeEventSource().emit('error');
            await waitFor(() => jest.getTimerCount() === 2, 'backoff timer installed');
            jest.advanceTimersByTime(3000);
            await flushAsync();
            expect(fakeEventSourceInstances).toHaveLength(1);
            await listener.stop();
        });

        test('events from a stopped SSE source cannot fetch or reconnect after restart', async () => {
            const { client, listMessages } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const oldSource = fakeEventSourceInstances[0];

            await listener.stop();
            await listener.start();
            expect(fakeEventSourceInstances).toHaveLength(2);
            expect(jest.getTimerCount()).toBe(1);

            oldSource.emit('message', new MessageEvent('message', {
                data: JSON.stringify({ command: 'EXISTS' }),
            }));
            oldSource.emit('error');
            await flushAsync();
            expect(listMessages).toHaveBeenCalledTimes(2);
            expect(fakeEventSourceInstances).toHaveLength(2);
            expect(jest.getTimerCount()).toBe(1);
            expect(listener.running).toBe(true);
            await listener.stop();
        });

        test('superseded source errors cannot close or reconnect the active stream', async () => {
            const { client } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const obsolete = firstFakeEventSource();
            const replacement = Object.assign(new EventTarget(), { close: mock(() => undefined) });
            (listener as unknown as { sseSource: typeof replacement }).sseSource = replacement;
            mockLogger.warn.mockClear();

            obsolete.emit('error');
            await flushAsync();

            expect(obsolete.closed).toBe(false);
            expect(replacement.close).not.toHaveBeenCalled();
            expect((listener as unknown as { sseSource: unknown }).sseSource).toBe(replacement);
            expect(fakeEventSourceInstances).toHaveLength(1);
            expect(mockLogger.warn).not.toHaveBeenCalled();
            await listener.stop();
        });

        test('a late error from a generation transition cannot report a new outage', async () => {
            const { client } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const { registry, sendEvent } = makeHealthRegistry();
            const listener = new WildDuckListener(client, processor, { ...DEFAULT_CONFIG, healthRegistry: registry });
            await listener.start();
            const source = firstFakeEventSource();
            (listener as unknown as { consecutivePollFails: number }).consecutivePollFails = 2;
            (listener as unknown as { generation: number }).generation++;
            mockLogger.warn.mockClear();
            sendEvent.mockClear();

            source.emit('error');
            await flushAsync();
            expect(source.closed).toBe(true);
            expect(mockLogger.warn).not.toHaveBeenCalled();
            expect(sendEvent).not.toHaveBeenCalledWith('email', 'CONNECTION_LOST', expect.anything());
            await listener.stop();
        });

        test('only the active source can complete its connection attempt', async () => {
            const { client } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const generation = (listener as unknown as { generation: number }).generation;
            const connect = listener as unknown as {
                connectSSEForLoop: (generation: number, loop: unknown) => Promise<void>
            };
            let obsoleteConnected = false;
            const obsoleteAttempt = connect.connectSSEForLoop(generation, { restart: () => undefined });
            void obsoleteAttempt.then(() => {
                obsoleteConnected = true;
                return undefined;
            });
            const obsolete = fakeEventSourceInstances[1];
            const activeAttempt = connect.connectSSEForLoop(generation, { restart: () => undefined });
            expect(fakeEventSourceInstances).toHaveLength(3);

            obsolete.emit('open');
            await flushAsync();
            expect(obsoleteConnected).toBe(false);

            fakeEventSourceInstances[2].emit('open');
            await activeAttempt;
            expect(obsoleteConnected).toBe(false);
            await listener.stop();
        });

        test('a stopped generation cannot create a new SSE source', async () => {
            const { client } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const generation = (listener as unknown as { generation: number }).generation;
            await listener.stop();
            const connect = listener as unknown as {
                connectSSEForLoop: (generation: number, loop: unknown) => Promise<void>
            };
            let settled = false;
            void connect.connectSSEForLoop(generation, { restart: () => undefined })
                .then(() => {
                    settled = true;
                    return undefined;
                })
                .catch(() => undefined);
            await flushAsync();
            expect(settled).toBe(true);
            expect(fakeEventSourceInstances).toHaveLength(1);
        });

        test('connection attempt resolves when EventSource becomes unavailable', async () => {
            const { client } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const generation = (listener as unknown as { generation: number }).generation;
            delete (globalThis as unknown as Record<string, unknown>).EventSource;
            const connect = listener as unknown as {
                connectSSEForLoop: (generation: number, loop: unknown) => Promise<void>
            };
            let outcome = 'pending';
            void connect.connectSSEForLoop(generation, { restart: () => undefined })
                .then(() => {
                    outcome = 'resolved';
                    return undefined;
                })
                .catch(() => { outcome = 'rejected'; });
            await flushAsync();
            expect(outcome).toBe('resolved');
            expect(fakeEventSourceInstances).toHaveLength(1);
            await listener.stop();
        });

        test('connection attempt resolves without credentials', async () => {
            const { client } = makeWildDuckClient({ getAuthToken: mock(() => '') });
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const generation = (listener as unknown as { generation: number }).generation;
            const connect = listener as unknown as {
                connectSSEForLoop: (generation: number, loop: unknown) => Promise<void>
            };
            let settled = false;
            void connect.connectSSEForLoop(generation, { restart: () => undefined })
                .then(() => {
                    settled = true;
                    return undefined;
                })
                .catch(() => undefined);
            await flushAsync();
            expect(settled).toBe(true);
            expect(fakeEventSourceInstances).toHaveLength(0);
            await listener.stop();
        });

        test('error before open rejects the connection attempt with its cause', async () => {
            const { client } = makeWildDuckClient();
            const { processor } = makeProcessor();
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();
            const generation = (listener as unknown as { generation: number }).generation;
            const connect = listener as unknown as {
                connectSSEForLoop: (generation: number, loop: unknown) => Promise<void>
            };
            const attempt = connect.connectSSEForLoop(generation, { restart: () => undefined });
            const outcome = attempt.then(() => 'resolved').catch((error: unknown) => error);
            fakeEventSourceInstances[1].emit('error');
            expect(await outcome).toEqual(new Error('SSE connection error'));
            await listener.stop();
        });

        test('SSE error before open causes ReconnectionLoop to schedule a retry with delay', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, {
                ...DEFAULT_CONFIG,
                sseReconnectDelayMs: 1000,
            });
            await listener.start();

            // One EventSource created
            expect(fakeEventSourceInstances).toHaveLength(1);

            // Trigger error before open — ReconnectionLoop should schedule retry after 1000ms
            firstFakeEventSource().emit('error');
            await waitFor(() => jest.getTimerCount() >= 2, 'SSE retry backoff timer scheduled after error before open');

            expect(firstFakeEventSource().closed).toBe(true);
            expect((listener as unknown as { sseSource: unknown }).sseSource).toBeNull();
            expect(mockLogger.warn).toHaveBeenCalledWith({
                msg: 'SSE connection error, scheduling reconnect',
            });

            // Timer should be pending (backoff delay)
            expect(jest.getTimerCount()).toBeGreaterThanOrEqual(2); // poll timer + SSE retry timer

            // Advance past SSE retry delay (2× to tolerate jitter) — second EventSource should be created
            jest.advanceTimersByTime(2000);
            await waitFor(() => fakeEventSourceInstances.length === 2, 'second EventSource created after backoff delay');

            expect(fakeEventSourceInstances).toHaveLength(2);

            await listener.stop();
        });

        test('stop() cancels the SSE reconnect loop — no retry after stop', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, {
                ...DEFAULT_CONFIG,
                sseReconnectDelayMs: 1000,
            });
            await listener.start();

            // Trigger SSE error so the loop schedules a retry
            firstFakeEventSource().emit('error');
            await waitFor(() => jest.getTimerCount() >= 2, 'SSE retry backoff timer scheduled after error');

            // Stop the listener — should cancel the pending SSE retry timer
            await listener.stop();

            // After stop, advancing time should NOT create another EventSource
            jest.advanceTimersByTime(5000);
            await flushAsync();

            expect(fakeEventSourceInstances).toHaveLength(1);
        });

        test('SSE error after open restarts the reconnect loop — new EventSource created immediately', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();
            const { registry, sendEvent } = makeHealthRegistry();

            const listener = new WildDuckListener(client, processor, {
                ...DEFAULT_CONFIG,
                healthRegistry: registry,
            });
            await listener.start();

            expect(fakeEventSourceInstances).toHaveLength(1);

            // First: open fires — connection established, loop auto-stops
            firstFakeEventSource().emit('open');
            await flushAsync();

            // A dropped established stream is a connectivity failure. Seed two
            // previous failures to make this third, SSE-originated failure observable.
            (listener as unknown as { consecutivePollFails: number }).consecutivePollFails = 2;

            // Then: error fires — stream disconnected after open
            // This calls sseReconnectLoop.start() which immediately calls connectFn()
            // creating a new EventSource synchronously
            firstFakeEventSource().emit('error');
            await waitFor(() => fakeEventSourceInstances.length === 2, 'second EventSource created immediately after error-after-open');

            // A second EventSource should have been created immediately (no delay needed)
            expect(fakeEventSourceInstances).toHaveLength(2);
            expect(firstFakeEventSource().closed).toBe(true);
            expect(sendEvent).toHaveBeenCalledWith('email', 'CONNECTION_LOST', {
                error: 'SSE connection error',
            });

            await listener.stop();
        });

        test('synchronous throw inside EventSource constructor does not kill the listener', async () => {
            // This tests that a throw inside connectSSEForLoop() is caught by the ReconnectionLoop
            let callCount = 0;
            const ThrowingEventSource = mock((_url: string) => {
                callCount++;
                if(callCount === 1) {
                    throw new Error('EventSource constructor failed');
                }
                // Second call: return a proper fake
                const instance: FakeEventSourceInstance = {
                    listeners:        new Map(),
                    closed:           false,
                    close:            () => { instance.closed = true; },
                    addEventListener: (type, handler) => {
                        const list = instance.listeners.get(type) ?? [];
                        list.push(handler);
                        instance.listeners.set(type, list);
                    },
                    emit: (type, evt) => {
                        const list = instance.listeners.get(type) ?? [];
                        for(const handler of list) {
                            handler(evt ?? new Event(type));
                        }
                    },
                };
                fakeEventSourceInstances.push(instance);
                return instance;
            });
            (globalThis as unknown as { EventSource: unknown }).EventSource = ThrowingEventSource;

            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, {
                ...DEFAULT_CONFIG,
                sseReconnectDelayMs: 1000,
            });
            await listener.start();

            // First attempt threw — loop should have scheduled retry
            await waitFor(() => callCount === 1, 'first EventSource construction attempt');
            expect(callCount).toBe(1);

            // Advance past backoff delay (2× to tolerate jitter) — second attempt should proceed without throwing
            jest.advanceTimersByTime(2000);
            await waitFor(() => callCount === 2, 'second EventSource construction attempt after backoff');

            expect(callCount).toBe(2);
            expect(fakeEventSourceInstances).toHaveLength(1); // second call succeeded

            await listener.stop();
        });

        test('stop() during SSE backoff: no EventSource created after stop', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, {
                ...DEFAULT_CONFIG,
                sseReconnectDelayMs: 2000,
            });
            await listener.start();

            // Trigger error to begin backoff
            firstFakeEventSource().emit('error');
            await waitFor(() => jest.getTimerCount() >= 2, 'SSE retry backoff timer scheduled after error');

            // Stop before the retry fires
            await listener.stop();

            // Advance well past the retry delay
            jest.advanceTimersByTime(10_000);
            await flushAsync();

            // Only the original EventSource — no retry after stop
            expect(fakeEventSourceInstances).toHaveLength(1);
            expect(listener.running).toBe(false);
        });

        test('when token or apiUrl is falsy, connectSSE resolves immediately without creating EventSource', async () => {
            const { client } = makeWildDuckClient({
                getAuthToken: mock(() => ''),       // falsy token
                getApiUrl:    mock(() => 'https://wildduck.example.com'),
            });
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            // EventSource should NOT be constructed when token is falsy
            expect(FakeEventSource).not.toHaveBeenCalled();

            await listener.stop();
        });

        test('timer count after stop() is 0 (both poll timer and SSE loop timer cleared)', async () => {
            const { client }    = makeWildDuckClient();
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, {
                ...DEFAULT_CONFIG,
                sseReconnectDelayMs: 1000,
            });
            await listener.start();

            // Trigger SSE error to create a pending retry timer in the loop
            firstFakeEventSource().emit('error');
            await waitFor(() => jest.getTimerCount() >= 2, 'SSE retry backoff timer scheduled after error');

            // There should be timers pending (poll + SSE retry)
            expect(jest.getTimerCount()).toBeGreaterThanOrEqual(2);

            // stop() must clear all of them
            await listener.stop();
            expect(jest.getTimerCount()).toBe(0);
        });
    });
});

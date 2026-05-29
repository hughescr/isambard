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

            expect(listener.start()).rejects.toThrow('List failed on startup');
            expect(listener.running).toBe(false);
        });

        test('when stop() is called while start() is draining a backlog, the loop exits after current batch', async () => {
            let listCount = 0;
            let resolveSecondList!: (value: WildDuckMessageSummary[]) => void;
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

            // Flush enough microtasks: listMessages #1 → 20 getFullMessage calls → process → listMessages #2 (blocks)
            for(let i = 0; i < 80; i++) {
                // eslint-disable-next-line no-await-in-loop -- sequential: must flush microtasks one tick at a time
                await Promise.resolve();
            }

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

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // listCount=2

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

            // Advance timer to trigger poll()
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // listCount=2 — throws inside poll()

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

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();

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

            // Advance timer once — triggers first poll
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // listCount=2, second timer scheduled

            // Advance timer again — triggers second poll, proving rescheduling happened
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // listCount=3

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

            // Fire poll timer
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();

            // Stop while poll is awaiting
            const stopPromise = listener.stop();
            resolveFetch();
            await stopPromise;
            await flushAsync();

            expect(jest.getTimerCount()).toBe(0);

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs * 3);
            await flushAsync();

            // Only 2 calls: initial + poll; none after stop
            expect(callCount).toBe(2);
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

        test('malformed SSE message data logs warn and returns without processing', async () => {
            const { client } = makeWildDuckClient();
            const { processor, processEmail } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            // connectSSE() now runs because MockEventSource is installed;
            // get the EventTarget that was created and dispatch a bad-JSON message
            const sseSource = (listener as unknown as { sseSource: EventTarget | null }).sseSource;
            expect(sseSource).not.toBeNull();

            const event = new MessageEvent('message', { data: '{not valid json}' });
            sseSource!.dispatchEvent(event);

            await flushAsync();

            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to parse SSE message data',
            }));
            // processEmail should not have been called for this SSE message
            expect(processEmail).not.toHaveBeenCalled();

            await listener.stop();
        });

        test('valid SSE EXISTS command triggers fetchAndProcess', async () => {
            const { client, listMessages } = makeWildDuckClient({
                listMessages: mock(async () => []),
            });
            const { processor } = makeProcessor();

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            // Startup call
            expect(listMessages).toHaveBeenCalledTimes(1);

            // connectSSE() now runs; dispatch a valid EXISTS command
            const sseSource = (listener as unknown as { sseSource: EventTarget | null }).sseSource;
            expect(sseSource).not.toBeNull();

            const event = new MessageEvent('message', { data: JSON.stringify({ command: 'EXISTS' }) });
            sseSource!.dispatchEvent(event);

            await flushAsync();

            // Should trigger another fetch
            expect(listMessages).toHaveBeenCalledTimes(2);

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

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();

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

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();

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

            // Trigger 2 failing polls — not yet at threshold
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // listCount=2 (fails)

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // listCount=3 (fails)

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

            // Trigger 3 failing polls to hit threshold
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // failure 1

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // failure 2

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // failure 3 — threshold hit

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

            // 3 failing polls
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // failure 1

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // failure 2

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // failure 3 — threshold hit, CONNECTION_LOST emitted

            expect(sendEvent).toHaveBeenCalledWith('email', 'CONNECTION_LOST', expect.anything());
            const connectLostCallCount = (sendEvent.mock.calls as unknown[][]).filter(
                c => c[1] === 'CONNECTION_LOST'
            ).length;
            expect(connectLostCallCount).toBe(1);

            // Successful poll — recovery
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();

            expect(sendEvent).toHaveBeenCalledWith('email', 'CONNECT_SUCCESS');

            await listener.stop();
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

            // 3 failing polls
            for(let i = 0; i < 3; i++) {
                jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
                // eslint-disable-next-line no-await-in-loop -- sequential: must flush microtasks one tick at a time
                await flushAsync();
            }

            // Two successful polls
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // first success — CONNECT_SUCCESS

            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync(); // second success — no extra CONNECT_SUCCESS

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
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; length checked above
            fakeEventSourceInstances[0]!.emit('error');
            await flushAsync();

            // Timer should be pending (backoff delay)
            expect(jest.getTimerCount()).toBeGreaterThanOrEqual(2); // poll timer + SSE retry timer

            // Advance past SSE retry delay (2× to tolerate jitter) — second EventSource should be created
            jest.advanceTimersByTime(2000);
            await flushAsync();

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
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; length checked above
            fakeEventSourceInstances[0]!.emit('error');
            await flushAsync();

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

            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            expect(fakeEventSourceInstances).toHaveLength(1);

            // First: open fires — connection established, loop auto-stops
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; length checked above
            fakeEventSourceInstances[0]!.emit('open');
            await flushAsync();

            // Then: error fires — stream disconnected after open
            // This calls sseReconnectLoop.start() which immediately calls connectFn()
            // creating a new EventSource synchronously
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; same index accessed after open
            fakeEventSourceInstances[0]!.emit('error');
            await flushAsync();

            // A second EventSource should have been created immediately (no delay needed)
            expect(fakeEventSourceInstances).toHaveLength(2);

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
            await flushAsync();
            expect(callCount).toBe(1);

            // Advance past backoff delay (2× to tolerate jitter) — second attempt should proceed without throwing
            jest.advanceTimersByTime(2000);
            await flushAsync();

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
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; length checked above
            fakeEventSourceInstances[0]!.emit('error');
            await flushAsync();

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
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; length checked above
            fakeEventSourceInstances[0]!.emit('error');
            await flushAsync();

            // There should be timers pending (poll + SSE retry)
            expect(jest.getTimerCount()).toBeGreaterThanOrEqual(2);

            // stop() must clear all of them
            await listener.stop();
            expect(jest.getTimerCount()).toBe(0);
        });
    });
});

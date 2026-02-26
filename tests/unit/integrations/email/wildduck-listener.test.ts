import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import _ from 'lodash';
import { mockLogger } from '../../../setup';
import type { EmailProcessor } from '@/integrations/email/email-processor';
import type { EmailMetadata } from '@/integrations/email/types';
import type { WildDuckClient, WildDuckMessageSummary } from '@/integrations/email/wildduck-client';
import { type WildDuckListenerConfig, WildDuckListener, MAX_NOTIFY_ATTEMPTS  } from '@/integrations/email/wildduck-listener';

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
    listMessages:          ReturnType<typeof mock>
    getFullMessage:        ReturnType<typeof mock>
    getMessage:            ReturnType<typeof mock>
    search:                ReturnType<typeof mock>
    updateMessageMetadata: ReturnType<typeof mock>
    updateMessageFlags:    ReturnType<typeof mock>
    getAuthToken:          ReturnType<typeof mock>
    getApiUrl:             ReturnType<typeof mock>
}> = {}): {
    client:                WildDuckClient
    listMessages:          ReturnType<typeof mock>
    getFullMessage:        ReturnType<typeof mock>
    getMessage:            ReturnType<typeof mock>
    search:                ReturnType<typeof mock>
    updateMessageMetadata: ReturnType<typeof mock>
    updateMessageFlags:    ReturnType<typeof mock>
    getAuthToken:          ReturnType<typeof mock>
    getApiUrl:             ReturnType<typeof mock>
} {
    const listMessages          = overrides.listMessages          ?? mock(_.constant(Promise.resolve([])));
    const getFullMessage        = overrides.getFullMessage        ?? mock(_.constant(Promise.resolve(null)));
    const getMessage            = overrides.getMessage            ?? mock(_.constant(Promise.resolve(null)));
    const search                = overrides.search                ?? mock(_.constant(Promise.resolve([])));
    const updateMessageMetadata = overrides.updateMessageMetadata ?? mock(_.constant(Promise.resolve(undefined)));
    const updateMessageFlags    = overrides.updateMessageFlags    ?? mock(_.constant(Promise.resolve(undefined)));
    const getAuthToken          = overrides.getAuthToken          ?? mock(_.constant('test-token'));
    const getApiUrl             = overrides.getApiUrl             ?? mock(_.constant('https://wildduck.example.com'));

    return {
        client: { listMessages, getFullMessage, getMessage, search, updateMessageMetadata, updateMessageFlags, getAuthToken, getApiUrl } as unknown as WildDuckClient,
        listMessages,
        getFullMessage,
        getMessage,
        search,
        updateMessageMetadata,
        updateMessageFlags,
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

// Flush async microtasks to let async setTimeout callbacks complete
async function flushAsync(): Promise<void> {
    for(let i = 0; i < 20; i++) {
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

        test('calls checkPendingNotifications after backlog drain', async () => {
            const onSendApprovalRequest = mock(async () => undefined);
            const { client, search }    = makeWildDuckClient({
                search: mock(async () => []),
            });
            const { processor } = makeProcessor();
            const config        = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            expect(search).toHaveBeenCalledTimes(1);

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
                getFullMessage: mock(_.constant(Promise.resolve(null))),
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
    // checkPendingNotifications
    // -----------------------------------------------------------------------

    describe('checkPendingNotifications', () => {
        function makeSearchResult(uid: number, folder = 'Drafts'): { message: string, from: string, to: string[], subject: string, date: string } {
            return {
                message: `${folder}:${uid}`,
                from:    'sender@example.com',
                to:      ['recv@example.com'],
                subject: 'Test',
                date:    '2024-01-15T10:00:00Z',
            };
        }

        test('does not call search when onSendApprovalRequest is not configured', async () => {
            const { client, search } = makeWildDuckClient();
            const { processor }      = makeProcessor();

            // No onSendApprovalRequest in config
            const listener = new WildDuckListener(client, processor, DEFAULT_CONFIG);
            await listener.start();

            expect(search).not.toHaveBeenCalled();

            await listener.stop();
        });

        test('no further calls when search returns empty array', async () => {
            const { client, search, getMessage } = makeWildDuckClient({
                search: mock(async () => []),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => undefined);
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            expect(search).toHaveBeenCalledWith({ query: { keyword: 'DiscordNotifyFailed' }, mailboxes: ['Drafts'] });
            expect(getMessage).not.toHaveBeenCalled();

            await listener.stop();
        });

        test('on successful retry: calls onSendApprovalRequest, clears flag, resets notifyAttempts', async () => {
            const uid = 42;
            const { client, getMessage, updateMessageMetadata, updateMessageFlags } = makeWildDuckClient({
                search:     mock(async () => [makeSearchResult(uid)]),
                getMessage: mock(async () => ({
                    id:      uid,
                    subject: 'Test subject',
                    to:      [{ address: 'alice@example.com' }],
                    cc:      [],
                })),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => undefined);
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            expect(getMessage).toHaveBeenCalledWith('Drafts', uid);
            expect(onSendApprovalRequest).toHaveBeenCalledWith('alice@example.com', 'Test subject', uid, undefined);
            expect(updateMessageFlags).toHaveBeenCalledWith('Drafts', uid, { removeFlags: ['DiscordNotifyFailed'] });
            expect(updateMessageMetadata).toHaveBeenCalledWith('Drafts', uid, { notifyAttempts: 0 });

            await listener.stop();
        });

        test('on successful retry with CC: passes cc array to onSendApprovalRequest', async () => {
            const uid = 77;
            const { client, getMessage } = makeWildDuckClient({
                search:     mock(async () => [makeSearchResult(uid)]),
                getMessage: mock(async () => ({
                    id:      uid,
                    subject: 'CC test',
                    to:      [{ address: 'alice@example.com' }],
                    cc:      [{ address: 'bob@example.com' }, { address: 'carol@example.com' }],
                })),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => undefined);
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            expect(getMessage).toHaveBeenCalledWith('Drafts', uid);
            expect(onSendApprovalRequest).toHaveBeenCalledWith('alice@example.com', 'CC test', uid, ['bob@example.com', 'carol@example.com']);

            await listener.stop();
        });

        test('on successful retry with undefined to field: passes empty string', async () => {
            const uid = 88;
            const { client, updateMessageFlags, updateMessageMetadata } = makeWildDuckClient({
                search:     mock(async () => [makeSearchResult(uid)]),
                getMessage: mock(async () => ({
                    id:      uid,
                    subject: 'No-to test',
                    // `to` field deliberately absent
                })),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => undefined);
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            expect(onSendApprovalRequest).toHaveBeenCalledWith('', 'No-to test', uid, undefined);
            expect(updateMessageFlags).toHaveBeenCalledWith('Drafts', uid, { removeFlags: ['DiscordNotifyFailed'] });
            expect(updateMessageMetadata).toHaveBeenCalledWith('Drafts', uid, { notifyAttempts: 0 });

            await listener.stop();
        });

        test('skips message when getMessage returns null', async () => {
            const uid = 55;
            const { client, getMessage, updateMessageMetadata } = makeWildDuckClient({
                search:     mock(async () => [makeSearchResult(uid)]),
                getMessage: mock(_.constant(Promise.resolve(null))),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => undefined);
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            expect(getMessage).toHaveBeenCalledWith('Drafts', uid);
            expect(onSendApprovalRequest).not.toHaveBeenCalled();
            expect(updateMessageMetadata).not.toHaveBeenCalled();

            await listener.stop();
        });

        test('when onSendApprovalRequest throws, DiscordNotifyFailed flag is retained', async () => {
            const uid = 99;
            const { client, updateMessageFlags } = makeWildDuckClient({
                search:     mock(async () => [makeSearchResult(uid)]),
                getMessage: mock(async () => ({
                    id:       uid,
                    subject:  'Pending approval',
                    to:       [{ address: 'target@example.com' }],
                    metaData: { notifyAttempts: 1 },
                })),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => {
                throw new Error('Admin channel not sendable');
            });
            const config = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            // Flag not cleared (notification still pending); no give-up since attempts < MAX
            expect(updateMessageFlags).not.toHaveBeenCalledWith('Drafts', uid, expect.objectContaining({ removeFlags: ['DiscordNotifyFailed'] }));
            expect(updateMessageFlags).not.toHaveBeenCalledWith('Drafts', uid, expect.objectContaining({ addFlags: ['DiscordNotifyGaveUp'] }));
        });

        test('on failed retry below MAX_NOTIFY_ATTEMPTS: increments notifyAttempts, keeps flag', async () => {
            const uid = 33;
            const { client, updateMessageMetadata, updateMessageFlags } = makeWildDuckClient({
                search:     mock(async () => [makeSearchResult(uid)]),
                getMessage: mock(async () => ({
                    id:       uid,
                    subject:  'Retry test',
                    to:       [{ address: 'bob@example.com' }],
                    metaData: { notifyAttempts: 2 },
                })),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => {
                throw new Error('Discord offline');
            });
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            // Did NOT transition flags (below MAX_NOTIFY_ATTEMPTS)
            expect(updateMessageFlags).not.toHaveBeenCalled();
            // Incremented attempts from 2 → 3
            expect(updateMessageMetadata).toHaveBeenCalledWith('Drafts', uid, { notifyAttempts: 3 });

            await listener.stop();
        });

        test('on failed retry at MAX_NOTIFY_ATTEMPTS: transitions to DiscordNotifyGaveUp', async () => {
            const uid = 44;
            const { client, updateMessageMetadata, updateMessageFlags } = makeWildDuckClient({
                search:     mock(async () => [makeSearchResult(uid)]),
                getMessage: mock(async () => ({
                    id:       uid,
                    subject:  'Give up test',
                    to:       [{ address: 'carol@example.com' }],
                    metaData: { notifyAttempts: MAX_NOTIFY_ATTEMPTS - 1 },
                })),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => {
                throw new Error('Discord offline');
            });
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            expect(updateMessageFlags).toHaveBeenCalledWith('Drafts', uid, {
                addFlags:    ['DiscordNotifyGaveUp'],
                removeFlags: ['DiscordNotifyFailed'],
            });
            expect(updateMessageMetadata).toHaveBeenCalledWith('Drafts', uid, { notifyAttempts: MAX_NOTIFY_ATTEMPTS });

            await listener.stop();
        });

        test('on failed retry with no metadata: defaults to 2, below MAX', async () => {
            const uid = 66;
            let getMessageCallCount = 0;
            const { client, updateMessageMetadata, updateMessageFlags } = makeWildDuckClient({
                search:     mock(async () => [makeSearchResult(uid)]),
                getMessage: mock(async () => {
                    getMessageCallCount++;
                    if(getMessageCallCount === 1) {
                        return { id: uid, subject: 'Test', to: [{ address: 'dave@example.com' }] };
                    }
                    return null;
                }),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => {
                throw new Error('Discord offline');
            });
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            expect(updateMessageFlags).not.toHaveBeenCalled();
            expect(updateMessageMetadata).toHaveBeenCalledWith('Drafts', uid, { notifyAttempts: 2 });

            await listener.stop();
        });

        test('error in search is caught and logged, does not throw', async () => {
            const { client }    = makeWildDuckClient({
                search: mock(async () => { throw new Error('Search failed'); }),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => undefined);
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            // Should not throw
            await listener.start();

            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: expect.stringContaining('pending notification'),
            }));

            await listener.stop();
        });

        test('error during escalation metadata update is logged, does not throw', async () => {
            const uid = 88;
            const { client } = makeWildDuckClient({
                search:     mock(async () => [makeSearchResult(uid)]),
                getMessage: mock(async () => ({
                    id:       uid,
                    subject:  'Meta error test',
                    to:       [{ address: 'eve@example.com' }],
                    metaData: { notifyAttempts: 1 },
                })),
                updateMessageMetadata: mock(async () => {
                    throw new Error('WildDuck offline');
                }),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => {
                throw new Error('Discord offline');
            });
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            // Should not throw
            await listener.start();

            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                msg: expect.stringContaining('notification attempt metadata'),
            }));

            await listener.stop();
        });

        test('checkPendingNotifications called after each scheduled poll cycle', async () => {
            const { client, search } = makeWildDuckClient({
                search: mock(async () => []),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => undefined);
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            const callsAfterStart = search.mock.calls.length;
            expect(callsAfterStart).toBeGreaterThanOrEqual(1);

            // Trigger one poll cycle
            jest.advanceTimersByTime(DEFAULT_CONFIG.pollFallbackMs);
            await flushAsync();

            const callsAfterPoll = search.mock.calls.length;
            expect(callsAfterPoll).toBeGreaterThan(callsAfterStart);

            await listener.stop();
        });

        test('search result with invalid format is skipped gracefully', async () => {
            // A search result with no colon (malformed) should be skipped
            const { client, getMessage } = makeWildDuckClient({
                search: mock(async () => [{ message: 'NoColonHere', from: '', to: [], subject: '', date: '' }]),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => undefined);
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            // getMessage should not be called for malformed results
            expect(getMessage).not.toHaveBeenCalled();

            await listener.stop();
        });

        test('search result with non-numeric UID is skipped gracefully', async () => {
            const { client, getMessage } = makeWildDuckClient({
                search: mock(async () => [{ message: 'Drafts:notanumber', from: '', to: [], subject: '', date: '' }]),
            });
            const { processor }         = makeProcessor();
            const onSendApprovalRequest = mock(async () => undefined);
            const config                = { ...DEFAULT_CONFIG, onSendApprovalRequest };

            const listener = new WildDuckListener(client, processor, config);
            await listener.start();

            expect(getMessage).not.toHaveBeenCalled();

            await listener.stop();
        });
    });
});

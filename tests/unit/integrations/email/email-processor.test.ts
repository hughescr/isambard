/* eslint-disable @typescript-eslint/unbound-method -- Test assertions on mock methods */
import _ from 'lodash';
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { mockLogger } from '../../../setup';
import { EmailProcessor } from '@/integrations/email/email-processor';
import { EmailProcessingError } from '@/integrations/email/errors';
import { EmailFolder } from '@/integrations/email/types';
import type { EmailMetadata, ClassifierVerdict } from '@/integrations/email/types';
import type { EmailAllowlist } from '@/integrations/email/allowlist';
import type { EmailClassifier } from '@/integrations/email/classifier';
import type { EmailCounterStore } from '@/integrations/email/email-counters';
import type { ImapConnection } from '@/integrations/email/imap-connection';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function makeEmail(overrides: Partial<EmailMetadata> = {}): EmailMetadata {
    return {
        uid:            42,
        messageId:      '<test-123@example.com>',
        from:           { name: 'Alice', address: 'alice@example.com' },
        to:             [{ name: 'Bob', address: 'bob@rungie.com' }],
        cc:             [],
        subject:        'Hello there',
        date:           new Date('2024-01-15T10:00:00Z'),
        bodyText:       'This is a normal email body.',
        hasAttachments: false,
        headers:        {
            messageId:             '<test-123@example.com>',
            authenticationResults: 'mx.rungie.com; spf=pass smtp.mailfrom=alice@example.com; dkim=pass header.d=example.com',
            xRspamdScore:          '1.2',
        },
        ...overrides,
    };
}

function makeVerdict(verdict: ClassifierVerdict['verdict'], overrides: Partial<ClassifierVerdict> = {}): ClassifierVerdict {
    return {
        verdict,
        confidence: 0.9,
        reason:     'Test reason',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeAllowlist(isAllowed: boolean): EmailAllowlist {
    return { isAllowed: mock(() => isAllowed) } as unknown as EmailAllowlist;
}

function makeClassifier(verdict: ClassifierVerdict | Error): EmailClassifier {
    if(_.isError(verdict)) {
        const err = verdict;
        return { classify: mock(async () => {
            throw err;
        }) } as unknown as EmailClassifier;
    }
    return { classify: mock(async () => verdict) } as unknown as EmailClassifier;
}

function makeCounters(): { store: EmailCounterStore, reset: ReturnType<typeof mock> } {
    const reset = mock(async () => undefined);
    return {
        store: { reset } as unknown as EmailCounterStore,
        reset,
    };
}

function makeImap(): { conn: ImapConnection, moveMessage: ReturnType<typeof mock>, getMailboxCounts: ReturnType<typeof mock> } {
    const moveMessage      = mock(async () => undefined);
    const getMailboxCounts = mock(async () => ({ total: 5, unread: 2 }));
    return {
        conn: { moveMessage, getMailboxCounts } as unknown as ImapConnection,
        moveMessage,
        getMailboxCounts,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailProcessor', () => {
    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    describe('allowlist bypass path', () => {
        test('sender on allowlist + SPF pass → CleanInbox, no classifier, sync counters', async () => {
            const email      = makeEmail();
            const classifier = makeClassifier(makeVerdict('safe'));
            const { store, reset }            = makeCounters();
            const { conn, moveMessage, getMailboxCounts } = makeImap();

            const processor = new EmailProcessor({
                allowlist: makeAllowlist(true),
                classifier,
                counters:  store,
                imap:      conn,
            });

            const result = await processor.processEmail(email);

            expect(result.verdict).toBeNull();
            expect(result.destinationFolder).toBe(EmailFolder.CleanInbox);
            expect(result.allowlistBypassed).toBe(true);
            expect(moveMessage).toHaveBeenCalledWith(42, EmailFolder.Inbox, EmailFolder.CleanInbox);
            expect(getMailboxCounts).toHaveBeenCalledWith(EmailFolder.CleanInbox);
            expect(reset).toHaveBeenCalledTimes(1);
            expect(classifier.classify).not.toHaveBeenCalled();
        });

        test('sender on allowlist + DKIM pass (no SPF) → CleanInbox bypass', async () => {
            const email = makeEmail({
                headers: { authenticationResults: 'mx.rungie.com; spf=fail smtp.mailfrom=other@other.com; dkim=pass header.d=example.com' },
            });
            const classifier = makeClassifier(makeVerdict('safe'));
            const { store, reset }            = makeCounters();
            const { conn, moveMessage, getMailboxCounts } = makeImap();

            const processor = new EmailProcessor({
                allowlist: makeAllowlist(true),
                classifier,
                counters:  store,
                imap:      conn,
            });

            const result = await processor.processEmail(email);

            expect(result.verdict).toBeNull();
            expect(result.destinationFolder).toBe(EmailFolder.CleanInbox);
            expect(result.allowlistBypassed).toBe(true);
            expect(moveMessage).toHaveBeenCalledWith(42, EmailFolder.Inbox, EmailFolder.CleanInbox);
            expect(getMailboxCounts).toHaveBeenCalledWith(EmailFolder.CleanInbox);
            expect(reset).toHaveBeenCalledTimes(1);
            expect(classifier.classify).not.toHaveBeenCalled();
        });

        test('sender on allowlist but no auth pass → falls through to classifier', async () => {
            const email = makeEmail({
                headers: { authenticationResults: 'mx.rungie.com; spf=fail smtp.mailfrom=spammer@evil.com; dkim=fail' },
            });
            const classifier = makeClassifier(makeVerdict('safe'));
            const { store, reset }            = makeCounters();
            const { conn, moveMessage, getMailboxCounts } = makeImap();

            const processor = new EmailProcessor({
                allowlist: makeAllowlist(true),
                classifier,
                counters:  store,
                imap:      conn,
            });

            const result = await processor.processEmail(email);

            expect(result.allowlistBypassed).toBe(false);
            expect(classifier.classify).toHaveBeenCalledTimes(1);
            // safe → CleanInbox, counters synced
            expect(result.destinationFolder).toBe(EmailFolder.CleanInbox);
            expect(moveMessage).toHaveBeenCalledWith(42, EmailFolder.Inbox, EmailFolder.CleanInbox);
            expect(getMailboxCounts).toHaveBeenCalledWith(EmailFolder.CleanInbox);
            expect(reset).toHaveBeenCalledTimes(1);
        });

        test('sender on allowlist with no authentication-results header → falls through to classifier', async () => {
            const email = makeEmail({ headers: {} });
            const classifier = makeClassifier(makeVerdict('spam'));
            const { store, reset }            = makeCounters();
            const { conn, moveMessage, getMailboxCounts } = makeImap();

            const processor = new EmailProcessor({
                allowlist: makeAllowlist(true),
                classifier,
                counters:  store,
                imap:      conn,
            });

            const result = await processor.processEmail(email);

            expect(result.allowlistBypassed).toBe(false);
            expect(classifier.classify).toHaveBeenCalledTimes(1);
            expect(result.destinationFolder).toBe(EmailFolder.Junk);
            expect(moveMessage).toHaveBeenCalledWith(42, EmailFolder.Inbox, EmailFolder.Junk);
            expect(getMailboxCounts).not.toHaveBeenCalled();
            expect(reset).not.toHaveBeenCalled();
        });
    });

    describe('non-allowlist routing', () => {
        test('safe verdict → CleanInbox, sync counters', async () => {
            const email      = makeEmail();
            const verdict    = makeVerdict('safe');
            const classifier = makeClassifier(verdict);
            const { store, reset }            = makeCounters();
            const { conn, moveMessage, getMailboxCounts } = makeImap();

            const processor = new EmailProcessor({
                allowlist: makeAllowlist(false),
                classifier,
                counters:  store,
                imap:      conn,
            });

            const result = await processor.processEmail(email);

            expect(result.verdict).toEqual(verdict);
            expect(result.destinationFolder).toBe(EmailFolder.CleanInbox);
            expect(result.allowlistBypassed).toBe(false);
            expect(moveMessage).toHaveBeenCalledWith(42, EmailFolder.Inbox, EmailFolder.CleanInbox);
            expect(getMailboxCounts).toHaveBeenCalledWith(EmailFolder.CleanInbox);
            expect(reset).toHaveBeenCalledTimes(1);
        });

        test('spam verdict → Junk, no counter sync', async () => {
            const verdict    = makeVerdict('spam');
            const classifier = makeClassifier(verdict);
            const { store, reset }            = makeCounters();
            const { conn, moveMessage, getMailboxCounts } = makeImap();

            const processor = new EmailProcessor({
                allowlist: makeAllowlist(false),
                classifier,
                counters:  store,
                imap:      conn,
            });

            const result = await processor.processEmail(makeEmail());

            expect(result.verdict).toEqual(verdict);
            expect(result.destinationFolder).toBe(EmailFolder.Junk);
            expect(result.allowlistBypassed).toBe(false);
            expect(moveMessage).toHaveBeenCalledWith(42, EmailFolder.Inbox, EmailFolder.Junk);
            expect(getMailboxCounts).not.toHaveBeenCalled();
            expect(reset).not.toHaveBeenCalled();
        });

        test('safe verdict → no callbacks invoked even when both provided', async () => {
            const verdict    = makeVerdict('safe');
            const classifier = makeClassifier(verdict);
            const { store }  = makeCounters();
            const { conn }   = makeImap();
            const onReview = mock(async () => undefined);
            const onUnsafe = mock(async () => undefined);

            const processor = new EmailProcessor(
                {
                    allowlist: makeAllowlist(false),
                    classifier,
                    counters:  store,
                    imap:      conn,
                },
                { onReview, onUnsafe }
            );

            await processor.processEmail(makeEmail());

            expect(onReview).not.toHaveBeenCalled();
            expect(onUnsafe).not.toHaveBeenCalled();
        });

        test('uncertain verdict → Review, no counter sync, onReview callback invoked', async () => {
            const verdict    = makeVerdict('uncertain');
            const email      = makeEmail();
            const classifier = makeClassifier(verdict);
            const { store, reset }            = makeCounters();
            const { conn, moveMessage, getMailboxCounts } = makeImap();
            const onReview = mock(async () => undefined);
            const onUnsafe = mock(async () => undefined);

            const processor = new EmailProcessor(
                {
                    allowlist: makeAllowlist(false),
                    classifier,
                    counters:  store,
                    imap:      conn,
                },
                { onReview, onUnsafe }
            );

            const result = await processor.processEmail(email);

            expect(result.verdict).toEqual(verdict);
            expect(result.destinationFolder).toBe(EmailFolder.Review);
            expect(result.allowlistBypassed).toBe(false);
            expect(moveMessage).toHaveBeenCalledWith(42, EmailFolder.Inbox, EmailFolder.Review);
            expect(getMailboxCounts).not.toHaveBeenCalled();
            expect(reset).not.toHaveBeenCalled();
            expect(onReview).toHaveBeenCalledWith(email, verdict);
            expect(onUnsafe).not.toHaveBeenCalled();
        });

        test('unsafe verdict → Quarantine, no counter sync, onUnsafe callback invoked', async () => {
            const verdict    = makeVerdict('unsafe');
            const email      = makeEmail();
            const classifier = makeClassifier(verdict);
            const { store, reset }            = makeCounters();
            const { conn, moveMessage, getMailboxCounts } = makeImap();
            const onReview = mock(async () => undefined);
            const onUnsafe = mock(async () => undefined);

            const processor = new EmailProcessor(
                {
                    allowlist: makeAllowlist(false),
                    classifier,
                    counters:  store,
                    imap:      conn,
                },
                { onReview, onUnsafe }
            );

            const result = await processor.processEmail(email);

            expect(result.verdict).toEqual(verdict);
            expect(result.destinationFolder).toBe(EmailFolder.Quarantine);
            expect(result.allowlistBypassed).toBe(false);
            expect(moveMessage).toHaveBeenCalledWith(42, EmailFolder.Inbox, EmailFolder.Quarantine);
            expect(getMailboxCounts).not.toHaveBeenCalled();
            expect(reset).not.toHaveBeenCalled();
            expect(onUnsafe).toHaveBeenCalledWith(email, verdict);
            expect(onReview).not.toHaveBeenCalled();
        });
    });

    describe('no callbacks provided', () => {
        test('uncertain verdict routes correctly with no onReview callback', async () => {
            const verdict    = makeVerdict('uncertain');
            const classifier = makeClassifier(verdict);
            const { store, reset }            = makeCounters();
            const { conn, moveMessage, getMailboxCounts } = makeImap();

            const processor = new EmailProcessor({
                allowlist: makeAllowlist(false),
                classifier,
                counters:  store,
                imap:      conn,
            });

            const result = await processor.processEmail(makeEmail());

            expect(result.destinationFolder).toBe(EmailFolder.Review);
            expect(moveMessage).toHaveBeenCalledWith(42, EmailFolder.Inbox, EmailFolder.Review);
            expect(getMailboxCounts).not.toHaveBeenCalled();
            expect(reset).not.toHaveBeenCalled();
        });

        test('unsafe verdict routes correctly with no onUnsafe callback', async () => {
            const verdict    = makeVerdict('unsafe');
            const classifier = makeClassifier(verdict);
            const { store, reset }            = makeCounters();
            const { conn, moveMessage, getMailboxCounts } = makeImap();

            const processor = new EmailProcessor({
                allowlist: makeAllowlist(false),
                classifier,
                counters:  store,
                imap:      conn,
            });

            const result = await processor.processEmail(makeEmail());

            expect(result.destinationFolder).toBe(EmailFolder.Quarantine);
            expect(moveMessage).toHaveBeenCalledWith(42, EmailFolder.Inbox, EmailFolder.Quarantine);
            expect(getMailboxCounts).not.toHaveBeenCalled();
            expect(reset).not.toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        test('classifier error → throws EmailProcessingError', async () => {
            const classifier = makeClassifier(new Error('API failed'));
            const { store }  = makeCounters();
            const { conn }   = makeImap();

            const processor = new EmailProcessor({
                allowlist: makeAllowlist(false),
                classifier,
                counters:  store,
                imap:      conn,
            });

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(processor.processEmail(makeEmail())).rejects.toBeInstanceOf(EmailProcessingError);
        });

        test('IMAP move error → throws EmailProcessingError', async () => {
            const verdict     = makeVerdict('safe');
            const classifier  = makeClassifier(verdict);
            const { store }   = makeCounters();
            const moveMessage = mock(async () => {
                throw new Error('IMAP failed');
            });
            const getMailboxCounts = mock(async () => ({ total: 5, unread: 2 }));
            const conn = { moveMessage, getMailboxCounts } as unknown as ImapConnection;

            const processor = new EmailProcessor({
                allowlist: makeAllowlist(false),
                classifier,
                counters:  store,
                imap:      conn,
            });

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(processor.processEmail(makeEmail())).rejects.toBeInstanceOf(EmailProcessingError);
        });

        test('IMAP move error on allowlist bypass → throws EmailProcessingError', async () => {
            const classifier  = makeClassifier(makeVerdict('safe'));
            const { store }   = makeCounters();
            const moveMessage = mock(async () => {
                throw new Error('IMAP move failed');
            });
            const getMailboxCounts = mock(async () => ({ total: 5, unread: 2 }));
            const conn = { moveMessage, getMailboxCounts } as unknown as ImapConnection;

            const processor = new EmailProcessor({
                allowlist: makeAllowlist(true),
                classifier,
                counters:  store,
                imap:      conn,
            });

            // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun matchers return void but are awaitable
            await expect(processor.processEmail(makeEmail())).rejects.toBeInstanceOf(EmailProcessingError);
        });

        test('getMailboxCounts failure after CleanInbox route is best-effort — email still routed', async () => {
            const verdict    = makeVerdict('safe');
            const classifier = makeClassifier(verdict);
            const { store }  = makeCounters();
            const moveMessage      = mock(async () => undefined);
            const getMailboxCounts = mock(async () => {
                throw new Error('IMAP STATUS failed');
            });
            const conn = { moveMessage, getMailboxCounts } as unknown as ImapConnection;

            const processor = new EmailProcessor({
                allowlist: makeAllowlist(false),
                classifier,
                counters:  store,
                imap:      conn,
            });

            const result = await processor.processEmail(makeEmail());

            // Email still routed successfully despite counter sync failure
            expect(result.destinationFolder).toBe(EmailFolder.CleanInbox);
            expect(mockLogger.warn).toHaveBeenCalled();
        });
    });

    describe('INFO logging', () => {
        test('logs routing decision for allowlist bypass', async () => {
            const email     = makeEmail();
            const { store } = makeCounters();
            const { conn }  = makeImap();

            const processor = new EmailProcessor({
                allowlist:  makeAllowlist(true),
                classifier: makeClassifier(makeVerdict('safe')),
                counters:   store,
                imap:       conn,
            });

            await processor.processEmail(email);

            expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({
                uid:  42,
                from: 'alice@example.com',
            }));
        });

        test('logs routing decision for classifier verdict', async () => {
            const email     = makeEmail();
            const verdict   = makeVerdict('spam');
            const { store } = makeCounters();
            const { conn }  = makeImap();

            const processor = new EmailProcessor({
                allowlist:  makeAllowlist(false),
                classifier: makeClassifier(verdict),
                counters:   store,
                imap:       conn,
            });

            await processor.processEmail(email);

            expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({
                uid:     42,
                from:    'alice@example.com',
                verdict: 'spam',
            }));
        });
    });
});

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import _ from 'lodash';
import { mockLogger } from '../../../setup';
import type { EmailAllowlist } from '@/integrations/email/allowlist';
import type { EmailClassifier } from '@/integrations/email/classifier';
import { EmailProcessor } from '@/integrations/email/email-processor';
import { EmailProcessingError } from '@/integrations/email/errors';
import { EmailFolder, type EmailMetadata, type ClassifierVerdict  } from '@/integrations/email/types';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';

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
        attachments: [],
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

function makeImap(): { conn: WildDuckClient, moveMessage: ReturnType<typeof mock> } {
    const moveMessage = mock(async () => undefined);
    return {
        conn: { moveMessage } as unknown as WildDuckClient,
        moveMessage,
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
        test('sender on allowlist + SPF pass → CleanInbox, no classifier', async () => {
            const email      = makeEmail();
            const classifier = makeClassifier(makeVerdict('safe'));
            const { conn, moveMessage } = makeImap();

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(true),
                classifier,
                wildDuckClient: conn,
            });

            const result = await processor.processEmail(email);

            expect(result.verdict).toBeNull();
            expect(result.destinationFolder).toBe(EmailFolder.CleanInbox);
            expect(result.allowlistBypassed).toBe(true);
            expect(moveMessage).toHaveBeenCalledWith(EmailFolder.Inbox, 42, EmailFolder.CleanInbox);
            expect(classifier.classify).not.toHaveBeenCalled();
        });

        test('sender on allowlist + DKIM pass (no SPF) → CleanInbox bypass', async () => {
            const email = makeEmail({
                headers: { authenticationResults: 'mx.rungie.com; spf=fail smtp.mailfrom=other@other.com; dkim=pass header.d=example.com' },
            });
            const classifier = makeClassifier(makeVerdict('safe'));
            const { conn, moveMessage } = makeImap();

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(true),
                classifier,
                wildDuckClient: conn,
            });

            const result = await processor.processEmail(email);

            expect(result.verdict).toBeNull();
            expect(result.destinationFolder).toBe(EmailFolder.CleanInbox);
            expect(result.allowlistBypassed).toBe(true);
            expect(moveMessage).toHaveBeenCalledWith(EmailFolder.Inbox, 42, EmailFolder.CleanInbox);
            expect(classifier.classify).not.toHaveBeenCalled();
        });

        test('sender on allowlist but no auth pass → falls through to classifier', async () => {
            const email = makeEmail({
                headers: { authenticationResults: 'mx.rungie.com; spf=fail smtp.mailfrom=spammer@evil.com; dkim=fail' },
            });
            const classifier = makeClassifier(makeVerdict('safe'));
            const { conn, moveMessage } = makeImap();

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(true),
                classifier,
                wildDuckClient: conn,
            });

            const result = await processor.processEmail(email);

            expect(result.allowlistBypassed).toBe(false);
            expect(classifier.classify).toHaveBeenCalledTimes(1);
            // safe → CleanInbox
            expect(result.destinationFolder).toBe(EmailFolder.CleanInbox);
            expect(moveMessage).toHaveBeenCalledWith(EmailFolder.Inbox, 42, EmailFolder.CleanInbox);
        });

        test('sender on allowlist with no authentication-results header → falls through to classifier', async () => {
            const email = makeEmail({ headers: {} });
            const classifier = makeClassifier(makeVerdict('spam'));
            const { conn, moveMessage } = makeImap();

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(true),
                classifier,
                wildDuckClient: conn,
            });

            const result = await processor.processEmail(email);

            expect(result.allowlistBypassed).toBe(false);
            expect(classifier.classify).toHaveBeenCalledTimes(1);
            expect(result.destinationFolder).toBe(EmailFolder.Junk);
            expect(moveMessage).toHaveBeenCalledWith(EmailFolder.Inbox, 42, EmailFolder.Junk);
        });
    });

    describe('non-allowlist routing', () => {
        test('safe verdict → CleanInbox', async () => {
            const email      = makeEmail();
            const verdict    = makeVerdict('safe');
            const classifier = makeClassifier(verdict);
            const { conn, moveMessage } = makeImap();

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(false),
                classifier,
                wildDuckClient: conn,
            });

            const result = await processor.processEmail(email);

            expect(result.verdict).toEqual(verdict);
            expect(result.destinationFolder).toBe(EmailFolder.CleanInbox);
            expect(result.allowlistBypassed).toBe(false);
            expect(moveMessage).toHaveBeenCalledWith(EmailFolder.Inbox, 42, EmailFolder.CleanInbox);
        });

        test('spam verdict → Junk', async () => {
            const verdict    = makeVerdict('spam');
            const classifier = makeClassifier(verdict);
            const { conn, moveMessage } = makeImap();

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(false),
                classifier,
                wildDuckClient: conn,
            });

            const result = await processor.processEmail(makeEmail());

            expect(result.verdict).toEqual(verdict);
            expect(result.destinationFolder).toBe(EmailFolder.Junk);
            expect(result.allowlistBypassed).toBe(false);
            expect(moveMessage).toHaveBeenCalledWith(EmailFolder.Inbox, 42, EmailFolder.Junk);
        });

        test('safe verdict → onReview and onUnsafe not invoked, onSafe is invoked', async () => {
            const verdict    = makeVerdict('safe');
            const email      = makeEmail();
            const classifier = makeClassifier(verdict);
            const { conn }   = makeImap();
            const onReview = mock(async () => undefined);
            const onUnsafe = mock(async () => undefined);
            const onSafe   = mock(async () => undefined);

            const processor = new EmailProcessor(
                {
                    allowlist:      makeAllowlist(false),
                    classifier,
                    wildDuckClient: conn,
                },
                { onReview, onUnsafe, onSafe }
            );

            await processor.processEmail(email);

            expect(onReview).not.toHaveBeenCalled();
            expect(onUnsafe).not.toHaveBeenCalled();
            expect(onSafe).toHaveBeenCalledWith(email, verdict);
        });

        test('safe verdict → onSafe not called when not provided', async () => {
            const verdict    = makeVerdict('safe');
            const classifier = makeClassifier(verdict);
            const { conn }   = makeImap();

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(false),
                classifier,
                wildDuckClient: conn,
            });

            // Should not throw when onSafe is not provided
            const result = await processor.processEmail(makeEmail());
            expect(result.verdict).toEqual(verdict);
            expect(result.destinationFolder).toBe(EmailFolder.CleanInbox);
        });

        test('uncertain verdict → Review, onReview callback invoked', async () => {
            const verdict    = makeVerdict('uncertain');
            const email      = makeEmail();
            const classifier = makeClassifier(verdict);
            const { conn, moveMessage } = makeImap();
            const onReview = mock(async () => undefined);
            const onUnsafe = mock(async () => undefined);

            const processor = new EmailProcessor(
                {
                    allowlist:      makeAllowlist(false),
                    classifier,
                    wildDuckClient: conn,
                },
                { onReview, onUnsafe }
            );

            const result = await processor.processEmail(email);

            expect(result.verdict).toEqual(verdict);
            expect(result.destinationFolder).toBe(EmailFolder.Review);
            expect(result.allowlistBypassed).toBe(false);
            expect(moveMessage).toHaveBeenCalledWith(EmailFolder.Inbox, 42, EmailFolder.Review);
            expect(onReview).toHaveBeenCalledWith(email, verdict);
            expect(onUnsafe).not.toHaveBeenCalled();
        });

        test('uncertain verdict → onSafe not invoked even when all callbacks provided', async () => {
            const verdict    = makeVerdict('uncertain');
            const email      = makeEmail();
            const classifier = makeClassifier(verdict);
            const { conn }   = makeImap();
            const onSafe   = mock(async () => undefined);
            const onReview = mock(async () => undefined);
            const onUnsafe = mock(async () => undefined);

            const processor = new EmailProcessor(
                {
                    allowlist:      makeAllowlist(false),
                    classifier,
                    wildDuckClient: conn,
                },
                { onSafe, onReview, onUnsafe }
            );

            await processor.processEmail(email);

            expect(onSafe).not.toHaveBeenCalled();
            expect(onReview).toHaveBeenCalledWith(email, verdict);
        });

        test('unsafe verdict → Quarantine, onUnsafe callback invoked', async () => {
            const verdict    = makeVerdict('unsafe');
            const email      = makeEmail();
            const classifier = makeClassifier(verdict);
            const { conn, moveMessage } = makeImap();
            const onReview = mock(async () => undefined);
            const onUnsafe = mock(async () => undefined);

            const processor = new EmailProcessor(
                {
                    allowlist:      makeAllowlist(false),
                    classifier,
                    wildDuckClient: conn,
                },
                { onReview, onUnsafe }
            );

            const result = await processor.processEmail(email);

            expect(result.verdict).toEqual(verdict);
            expect(result.destinationFolder).toBe(EmailFolder.Quarantine);
            expect(result.allowlistBypassed).toBe(false);
            expect(moveMessage).toHaveBeenCalledWith(EmailFolder.Inbox, 42, EmailFolder.Quarantine);
            expect(onUnsafe).toHaveBeenCalledWith(email, verdict);
            expect(onReview).not.toHaveBeenCalled();
        });

        test('unsafe verdict → onReview not invoked even when all callbacks provided', async () => {
            const verdict    = makeVerdict('unsafe');
            const email      = makeEmail();
            const classifier = makeClassifier(verdict);
            const { conn }   = makeImap();
            const onSafe   = mock(async () => undefined);
            const onReview = mock(async () => undefined);
            const onUnsafe = mock(async () => undefined);

            const processor = new EmailProcessor(
                {
                    allowlist:      makeAllowlist(false),
                    classifier,
                    wildDuckClient: conn,
                },
                { onSafe, onReview, onUnsafe }
            );

            await processor.processEmail(email);

            expect(onReview).not.toHaveBeenCalled();
            expect(onUnsafe).toHaveBeenCalledWith(email, verdict);
        });

        test('safe verdict → onUnsafe not invoked when onSafe is absent', async () => {
            // When safe verdict and onSafe not provided, no callbacks should fire
            // This test specifically kills the mutation: verdict.verdict === 'unsafe' → true
            // (which would cause onUnsafe to be invoked for safe emails)
            const verdict    = makeVerdict('safe');
            const email      = makeEmail();
            const classifier = makeClassifier(verdict);
            const { conn }   = makeImap();
            const onUnsafe = mock(async () => undefined);

            const processor = new EmailProcessor(
                {
                    allowlist:      makeAllowlist(false),
                    classifier,
                    wildDuckClient: conn,
                },
                // onSafe intentionally not provided — ensures mutant at line 183 is caught
                { onUnsafe }
            );

            await processor.processEmail(email);

            expect(onUnsafe).not.toHaveBeenCalled();
        });
    });

    describe('no callbacks provided', () => {
        test('uncertain verdict routes correctly with no onReview callback', async () => {
            const verdict    = makeVerdict('uncertain');
            const classifier = makeClassifier(verdict);
            const { conn, moveMessage } = makeImap();

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(false),
                classifier,
                wildDuckClient: conn,
            });

            const result = await processor.processEmail(makeEmail());

            expect(result.destinationFolder).toBe(EmailFolder.Review);
            expect(moveMessage).toHaveBeenCalledWith(EmailFolder.Inbox, 42, EmailFolder.Review);
        });

        test('unsafe verdict routes correctly with no onUnsafe callback', async () => {
            const verdict    = makeVerdict('unsafe');
            const classifier = makeClassifier(verdict);
            const { conn, moveMessage } = makeImap();

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(false),
                classifier,
                wildDuckClient: conn,
            });

            const result = await processor.processEmail(makeEmail());

            expect(result.destinationFolder).toBe(EmailFolder.Quarantine);
            expect(moveMessage).toHaveBeenCalledWith(EmailFolder.Inbox, 42, EmailFolder.Quarantine);
        });
    });

    describe('error handling', () => {
        test('classifier error → throws EmailProcessingError', async () => {
            const classifier = makeClassifier(new Error('API failed'));
            const { conn }   = makeImap();

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(false),
                classifier,
                wildDuckClient: conn,
            });

            await expect(processor.processEmail(makeEmail())).rejects.toBeInstanceOf(EmailProcessingError);
        });

        test('IMAP move error → throws EmailProcessingError', async () => {
            const verdict     = makeVerdict('safe');
            const classifier  = makeClassifier(verdict);
            const moveMessage = mock(async () => {
                throw new Error('IMAP failed');
            });
            const conn = { moveMessage } as unknown as WildDuckClient;

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(false),
                classifier,
                wildDuckClient: conn,
            });

            await expect(processor.processEmail(makeEmail())).rejects.toBeInstanceOf(EmailProcessingError);
        });

        test('IMAP move error on allowlist bypass → throws EmailProcessingError', async () => {
            const classifier  = makeClassifier(makeVerdict('safe'));
            const moveMessage = mock(async () => {
                throw new Error('IMAP move failed');
            });
            const conn = { moveMessage } as unknown as WildDuckClient;

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(true),
                classifier,
                wildDuckClient: conn,
            });

            await expect(processor.processEmail(makeEmail())).rejects.toBeInstanceOf(EmailProcessingError);
        });
    });

    describe('INFO logging', () => {
        test('logs routing decision for allowlist bypass', async () => {
            const email    = makeEmail();
            const { conn } = makeImap();

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(true),
                classifier:     makeClassifier(makeVerdict('safe')),
                wildDuckClient: conn,
            });

            await processor.processEmail(email);

            expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({
                uid:  42,
                from: 'alice@example.com',
            }));
        });

        test('logs routing decision for classifier verdict', async () => {
            const email    = makeEmail();
            const verdict  = makeVerdict('spam');
            const { conn } = makeImap();

            const processor = new EmailProcessor({
                allowlist:      makeAllowlist(false),
                classifier:     makeClassifier(verdict),
                wildDuckClient: conn,
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

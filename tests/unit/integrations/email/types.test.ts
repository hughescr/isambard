import { describe, test, expect } from 'bun:test';
import { EmailFolder } from '@/config';
import {
    ClassifierVerdictType,
    SPAM_CATEGORIES,
    UNSAFE_CATEGORIES,
    classifierVerdictSchema,
    draftsMailboxMessageRefSchema,
    emailSenderProfileSchema,
    formatMailboxMessageRef,
    mailboxMessageRefSchema,
    parseMailboxMessageRef
} from '@/integrations/email/types';

describe.concurrent('EmailFolder', () => {
    test('should have correct values', () => {
        expect(EmailFolder.Inbox).toBe('INBOX');
        expect(EmailFolder.CleanInbox).toBe('CleanInbox');
        expect(EmailFolder.Quarantine).toBe('Quarantine');
        expect(EmailFolder.Review).toBe('Review');
        expect(EmailFolder.Junk).toBe('Junk');
        expect(EmailFolder.Trash).toBe('Trash');
        expect(EmailFolder.Archive).toBe('Archive');
        expect(EmailFolder.Drafts).toBe('Drafts');
        expect(EmailFolder.Sent).toBe('Sent Mail');
    });

    test('should have exactly the expected keys', () => {
        const folderKeys = Object.keys(EmailFolder);
        expect(folderKeys).toContain('Inbox');
        expect(folderKeys).toContain('CleanInbox');
        expect(folderKeys).toContain('Quarantine');
        expect(folderKeys).toContain('Review');
        expect(folderKeys).toContain('Junk');
        expect(folderKeys).toContain('Trash');
        expect(folderKeys).toContain('Archive');
        expect(folderKeys).toContain('Drafts');
        expect(folderKeys).toContain('Sent');
        expect(folderKeys).toHaveLength(9);
    });
});

describe.concurrent('ClassifierVerdictType', () => {
    test('should have correct values', () => {
        expect(ClassifierVerdictType.Safe).toBe('safe');
        expect(ClassifierVerdictType.Spam).toBe('spam');
        expect(ClassifierVerdictType.Uncertain).toBe('uncertain');
        expect(ClassifierVerdictType.Unsafe).toBe('unsafe');
    });

    test('should have exactly the expected keys', () => {
        const verdictKeys = Object.keys(ClassifierVerdictType);
        expect(verdictKeys).toContain('Safe');
        expect(verdictKeys).toContain('Spam');
        expect(verdictKeys).toContain('Uncertain');
        expect(verdictKeys).toContain('Unsafe');
        expect(verdictKeys).toHaveLength(4);
    });
});

describe.concurrent('emailSenderProfileSchema', () => {
    test('accepts the formal and informal sender profiles', () => {
        expect(emailSenderProfileSchema.safeParse('formal').success).toBe(true);
        expect(emailSenderProfileSchema.safeParse('informal').success).toBe(true);
    });

    test('rejects an unknown sender profile', () => {
        expect(emailSenderProfileSchema.safeParse('personal').success).toBe(false);
    });
});

describe.concurrent('MailboxMessageRef', () => {
    test('round trips folders through the shared codec', () => {
        const refs = [
            { folder: EmailFolder.CleanInbox, uid: 42 },
            { folder: EmailFolder.Sent, uid: 7 },
            { folder: 'INBOX.Sub', uid: 15 },
            { folder: 'unmapped:mailbox', uid: 9 },
        ];

        for(const ref of refs) {
            expect(parseMailboxMessageRef(formatMailboxMessageRef(ref))).toEqual(ref);
        }
    });

    test('uses the final colon as the UID delimiter', () => {
        expect(parseMailboxMessageRef('nested:folder:42')).toEqual({ folder: 'nested:folder', uid: 42 });
    });

    test('accepts a single-character folder immediately before the delimiter', () => {
        expect(parseMailboxMessageRef('a:5')).toEqual({ folder: 'a', uid: 5 });
    });

    test('rejects malformed, non-positive, fractional, and unsafe references', () => {
        for(const raw of ['Drafts:', ':12', 'abc:', 'Drafts:0', 'Drafts:-1', 'Drafts:7.5', `Drafts:${Number.MAX_SAFE_INTEGER + 1}`]) {
            expect(parseMailboxMessageRef(raw)).toBeUndefined();
            expect(mailboxMessageRefSchema.safeParse(raw).success).toBe(false);
        }
    });

    test('only accepts Drafts references through the drafts schema', () => {
        expect(draftsMailboxMessageRefSchema.safeParse('Drafts:42').success).toBe(true);
        expect(draftsMailboxMessageRefSchema.safeParse('CleanInbox:42').success).toBe(false);
    });
});

describe.concurrent('classifierVerdictSchema', () => {
    const validVerdict = {
        verdict:    'safe',
        confidence: 0.95,
        reason:     'Message passed all checks',
    };

    test('should parse a valid safe verdict', () => {
        const result = classifierVerdictSchema.safeParse(validVerdict);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.verdict).toBe('safe');
            expect(result.data.confidence).toBeCloseTo(0.95, 2);
            expect(result.data.reason).toBe('Message passed all checks');
            expect(result.data).not.toHaveProperty('category');
        }
    });

    test('should parse all verdict types', () => {
        const verdicts = ['safe', 'spam', 'uncertain', 'unsafe'] as const;
        for(const verdict of verdicts) {
            const result = classifierVerdictSchema.safeParse({ ...validVerdict, verdict });
            expect(result.success).toBe(true);
        }
    });

    test('pins the verdict-scoped category vocabularies', () => {
        expect(UNSAFE_CATEGORIES).toEqual(['phishing', 'malware', 'social_engineering', 'prompt_injection', 'scam']);
        expect(SPAM_CATEGORIES).toEqual(['marketing', 'newsletter', 'bulk', 'automated']);
    });

    test('keeps a valid unsafe category', () => {
        const result = classifierVerdictSchema.safeParse({ ...validVerdict, verdict: 'unsafe', category: 'phishing' });

        expect(result.success).toBe(true);
        if(result.success && result.data.verdict === 'unsafe') {
            expect(result.data.category).toBe('phishing');
        }
    });

    test('drops a spam category that belongs to the unsafe vocabulary', () => {
        const result = classifierVerdictSchema.safeParse({ ...validVerdict, verdict: 'spam', category: 'phishing' });

        expect(result.success).toBe(true);
        if(result.success && result.data.verdict === 'spam') {
            expect(result.data.category).toBeUndefined();
        }
    });

    test('drops categories from safe verdicts', () => {
        const result = classifierVerdictSchema.safeParse({ ...validVerdict, category: 'x' });

        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data).not.toHaveProperty('category');
        }
    });

    test('should accept confidence at boundaries (0 and 1)', () => {
        expect(classifierVerdictSchema.safeParse({ ...validVerdict, confidence: 0 }).success).toBe(true);
        expect(classifierVerdictSchema.safeParse({ ...validVerdict, confidence: 1 }).success).toBe(true);
    });

    test('should reject invalid verdict type', () => {
        const result = classifierVerdictSchema.safeParse({ ...validVerdict, verdict: 'unknown' });
        expect(result.success).toBe(false);
    });

    test('should reject confidence below 0', () => {
        const result = classifierVerdictSchema.safeParse({ ...validVerdict, confidence: -0.1 });
        expect(result.success).toBe(false);
    });

    test('should reject confidence above 1', () => {
        const result = classifierVerdictSchema.safeParse({ ...validVerdict, confidence: 1.1 });
        expect(result.success).toBe(false);
    });

    test('should reject missing required fields', () => {
        const { verdict: _v, ...noVerdict } = validVerdict;
        expect(classifierVerdictSchema.safeParse(noVerdict).success).toBe(false);

        const { confidence: _c, ...noConfidence } = validVerdict;
        expect(classifierVerdictSchema.safeParse(noConfidence).success).toBe(false);

        const { reason: _r, ...noReason } = validVerdict;
        expect(classifierVerdictSchema.safeParse(noReason).success).toBe(false);
    });

    test('should reject non-string reason', () => {
        const result = classifierVerdictSchema.safeParse({ ...validVerdict, reason: 42 });
        expect(result.success).toBe(false);
    });
});

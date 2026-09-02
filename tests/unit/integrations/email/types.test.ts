import { describe, test, expect } from 'bun:test';
import {
    EmailFolder,
    ClassifierVerdictType,
    EmailIdentity,
    classifierVerdictSchema
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

describe.concurrent('EmailIdentity', () => {
    test('should have correct values', () => {
        expect(EmailIdentity.Formal).toBe('formal');
        expect(EmailIdentity.Informal).toBe('informal');
    });

    test('should have exactly the expected keys', () => {
        const identityKeys = Object.keys(EmailIdentity);
        expect(identityKeys).toContain('Formal');
        expect(identityKeys).toContain('Informal');
        expect(identityKeys).toHaveLength(2);
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
            expect(result.data.category).toBeUndefined();
        }
    });

    test('should parse all verdict types', () => {
        const verdicts = ['safe', 'spam', 'uncertain', 'unsafe'] as const;
        for(const verdict of verdicts) {
            const result = classifierVerdictSchema.safeParse({ ...validVerdict, verdict });
            expect(result.success).toBe(true);
        }
    });

    test('should parse verdict with optional category', () => {
        const withCategory = { ...validVerdict, category: 'newsletter' };
        const result = classifierVerdictSchema.safeParse(withCategory);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.category).toBe('newsletter');
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

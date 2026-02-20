import { describe, test, expect } from 'bun:test';
import _ from 'lodash';
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
        expect(EmailFolder.Sent).toBe('Sent');
    });

    test('should have exactly the expected keys', () => {
        const keys = _.keys(EmailFolder);
        expect(keys).toContain('Inbox');
        expect(keys).toContain('CleanInbox');
        expect(keys).toContain('Quarantine');
        expect(keys).toContain('Review');
        expect(keys).toContain('Junk');
        expect(keys).toContain('Trash');
        expect(keys).toContain('Archive');
        expect(keys).toContain('Drafts');
        expect(keys).toContain('Sent');
        expect(keys).toHaveLength(9);
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
        const keys = _.keys(ClassifierVerdictType);
        expect(keys).toContain('Safe');
        expect(keys).toContain('Spam');
        expect(keys).toContain('Uncertain');
        expect(keys).toContain('Unsafe');
        expect(keys).toHaveLength(4);
    });
});

describe.concurrent('EmailIdentity', () => {
    test('should have correct values', () => {
        expect(EmailIdentity.Formal).toBe('formal');
        expect(EmailIdentity.Informal).toBe('informal');
    });

    test('should have exactly the expected keys', () => {
        const keys = _.keys(EmailIdentity);
        expect(keys).toContain('Formal');
        expect(keys).toContain('Informal');
        expect(keys).toHaveLength(2);
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
            expect(result.data.confidence).toBe(0.95);
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

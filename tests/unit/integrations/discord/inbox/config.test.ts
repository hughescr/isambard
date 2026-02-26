import { describe, test, expect } from 'bun:test';
import { inboxConfigSchema, DEFAULT_INBOX_CONFIG } from '@/integrations/discord/inbox/config';

describe.concurrent('inboxConfigSchema', () => {
    test('should accept valid config with all fields', () => {
        const config = {
            minGapDurationMs:   300_000,
            maxCatchUpMessages: 50,
            maxCatchUpAgeDays:  3,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
    });

    test('should apply default for minGapDurationMs when missing', () => {
        const config = {
            maxCatchUpMessages: 50,
            maxCatchUpAgeDays:  3,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.minGapDurationMs).toBe(10 * 1000);
        }
    });

    test('should apply default for maxCatchUpMessages when missing', () => {
        const config = {
            minGapDurationMs:  300_000,
            maxCatchUpAgeDays: 3,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.maxCatchUpMessages).toBe(100);
        }
    });

    test('should apply default for maxCatchUpAgeDays when missing', () => {
        const config = {
            minGapDurationMs:   300_000,
            maxCatchUpMessages: 50,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.maxCatchUpAgeDays).toBe(7);
        }
    });

    test('should apply all defaults when config is empty', () => {
        const result = inboxConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.minGapDurationMs).toBe(10 * 1000);
            expect(result.data.maxCatchUpMessages).toBe(100);
            expect(result.data.maxCatchUpAgeDays).toBe(7);
        }
    });

    test('should reject negative minGapDurationMs', () => {
        const config = {
            minGapDurationMs:   -1,
            maxCatchUpMessages: 50,
            maxCatchUpAgeDays:  3,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    test('should reject zero minGapDurationMs', () => {
        const config = {
            minGapDurationMs:   0,
            maxCatchUpMessages: 50,
            maxCatchUpAgeDays:  3,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    test('should reject negative maxCatchUpMessages', () => {
        const config = {
            minGapDurationMs:   300_000,
            maxCatchUpMessages: -1,
            maxCatchUpAgeDays:  3,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    test('should reject zero maxCatchUpMessages', () => {
        const config = {
            minGapDurationMs:   300_000,
            maxCatchUpMessages: 0,
            maxCatchUpAgeDays:  3,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    test('should reject negative maxCatchUpAgeDays', () => {
        const config = {
            minGapDurationMs:   300_000,
            maxCatchUpMessages: 50,
            maxCatchUpAgeDays:  -1,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    test('should reject zero maxCatchUpAgeDays', () => {
        const config = {
            minGapDurationMs:   300_000,
            maxCatchUpMessages: 50,
            maxCatchUpAgeDays:  0,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    test('should reject non-integer minGapDurationMs', () => {
        const config = {
            minGapDurationMs:   300.5,
            maxCatchUpMessages: 50,
            maxCatchUpAgeDays:  3,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    test('should reject non-integer maxCatchUpMessages', () => {
        const config = {
            minGapDurationMs:   300_000,
            maxCatchUpMessages: 50.5,
            maxCatchUpAgeDays:  3,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });

    test('should reject non-integer maxCatchUpAgeDays', () => {
        const config = {
            minGapDurationMs:   300_000,
            maxCatchUpMessages: 50,
            maxCatchUpAgeDays:  3.5,
        };
        const result = inboxConfigSchema.safeParse(config);
        expect(result.success).toBe(false);
    });
});

describe.concurrent('DEFAULT_INBOX_CONFIG', () => {
    test('should have correct default values', () => {
        expect(DEFAULT_INBOX_CONFIG.minGapDurationMs).toBe(10 * 1000);
        expect(DEFAULT_INBOX_CONFIG.maxCatchUpMessages).toBe(100);
        expect(DEFAULT_INBOX_CONFIG.maxCatchUpAgeDays).toBe(7);
    });

    test('should validate against schema', () => {
        const result = inboxConfigSchema.safeParse(DEFAULT_INBOX_CONFIG);
        expect(result.success).toBe(true);
    });

    test('should have positive minGapDurationMs', () => {
        expect(DEFAULT_INBOX_CONFIG.minGapDurationMs).toBeGreaterThan(0);
    });

    test('should have positive maxCatchUpMessages', () => {
        expect(DEFAULT_INBOX_CONFIG.maxCatchUpMessages).toBeGreaterThan(0);
    });

    test('should have positive maxCatchUpAgeDays', () => {
        expect(DEFAULT_INBOX_CONFIG.maxCatchUpAgeDays).toBeGreaterThan(0);
    });
});

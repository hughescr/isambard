import { describe, test, expect } from 'bun:test';
import {
    atUriSchema,
    cidSchema,
    createAtUri,
    createCid
} from '@/integrations/bsky/types';

describe.concurrent('atUriSchema', () => {
    test('should accept a valid at:// URI', () => {
        const result = atUriSchema.safeParse('at://did:plc:abc123/app.bsky.feed.post/xyz');
        expect(result.success).toBe(true);
    });

    test('should reject an empty string', () => {
        const result = atUriSchema.safeParse('');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toBe('AT URI cannot be empty');
        }
    });

    test('should reject a string that does not start with at://', () => {
        const result = atUriSchema.safeParse('https://example.com/not-an-at-uri');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toBe('AT URI must start with at://');
        }
    });

    test('should reject a bare "at:" prefix without the double slash', () => {
        const result = atUriSchema.safeParse('at:did:plc:abc123');
        expect(result.success).toBe(false);
    });

    test('should reject non-string values', () => {
        expect(atUriSchema.safeParse(123).success).toBe(false);
        expect(atUriSchema.safeParse(null).success).toBe(false);
        expect(atUriSchema.safeParse(undefined).success).toBe(false);
        expect(atUriSchema.safeParse({}).success).toBe(false);
    });
});

describe('createAtUri', () => {
    test('should create a branded AtUri from a valid at:// URI', () => {
        const uri = 'at://did:plc:abc123/app.bsky.feed.post/xyz';
        const result = createAtUri(uri);
        // TypeScript ensures the branded type is correct at compile time
        expect(result as string).toBe(uri);
    });

    test('should throw for an empty string', () => {
        expect(() => createAtUri('')).toThrow();
    });

    test('should throw for a URI missing the at:// prefix', () => {
        expect(() => createAtUri('did:plc:abc123')).toThrow();
    });
});

describe.concurrent('cidSchema', () => {
    test('should accept a non-empty CID string', () => {
        const result = cidSchema.safeParse('bafyreiabc123');
        expect(result.success).toBe(true);
    });

    test('should reject an empty string', () => {
        const result = cidSchema.safeParse('');
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toBe('CID cannot be empty');
        }
    });

    test('should reject non-string values', () => {
        expect(cidSchema.safeParse(123).success).toBe(false);
        expect(cidSchema.safeParse(null).success).toBe(false);
        expect(cidSchema.safeParse(undefined).success).toBe(false);
        expect(cidSchema.safeParse({}).success).toBe(false);
    });
});

describe('createCid', () => {
    test('should create a branded Cid from a non-empty string', () => {
        const cid = 'bafyreiabc123';
        const result = createCid(cid);
        // TypeScript ensures the branded type is correct at compile time
        expect(result as string).toBe(cid);
    });

    test('should throw for an empty string', () => {
        expect(() => createCid('')).toThrow();
    });
});

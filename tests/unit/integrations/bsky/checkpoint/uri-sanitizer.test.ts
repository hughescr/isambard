import { describe, test, expect } from 'bun:test';
import { sanitizeFeedName } from '@/integrations/bsky/checkpoint/uri-sanitizer';

describe('sanitizeFeedName', () => {
    test('passes through "following" as-is', () => {
        expect(sanitizeFeedName('following')).toBe('following');
    });

    test('passes through "for-you" as-is', () => {
        expect(sanitizeFeedName('for-you')).toBe('for-you');
    });

    test('passes through "discover" as-is', () => {
        expect(sanitizeFeedName('discover')).toBe('discover');
    });

    test('sanitizes AT URI by replacing :// and /', () => {
        expect(sanitizeFeedName('at://did:plc:abc123/app.bsky.feed.generator/my-feed'))
            .toBe('at-did:plc:abc123-app.bsky.feed.generator-my-feed');
    });

    test('sanitizes another AT URI format', () => {
        expect(sanitizeFeedName('at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot'))
            .toBe('at-did:plc:z72i7hdynmk6r22z27h6tvur-app.bsky.feed.generator-whats-hot');
    });

    test('passes through simple custom names as-is', () => {
        expect(sanitizeFeedName('my-custom-feed')).toBe('my-custom-feed');
    });

    test('sanitizes double-slash input by replacing slashes', () => {
        // The safety check is a defensive net; the replacement logic converts
        // all slashes to dashes, so // becomes -- (no // survives replacement)
        expect(sanitizeFeedName('bad//input')).toBe('bad--input');
    });
});

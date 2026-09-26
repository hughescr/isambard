import { describe, expect, test } from 'bun:test';
import { DISCORD_MAX_LENGTH } from '@/integrations/discord/messages';
import { appendDeliveryCode, decodeDeliveryCode, deliveryCodeFor, deliveryTokenForBase, maxContentLengthForDeliveryCode, DELIVERY_TOKEN_MAX_LENGTH } from '@/utils/delivery-code';

const zeroWidth = (...codePoints: string[]): string => String.fromCodePoint(...codePoints.map(codePoint => Number.parseInt(codePoint, 16)));

describe('zero-width delivery code', () => {
    test('encodes a token with the exact invisible alphabet and sentinels', () => {
        expect(deliveryCodeFor('iz0')).toBe(zeroWidth('2063', '200C', '200B', '200D', '200D', '200B', '2060', '200B', '200B', '200B', '2064'));
    });

    test('round-trips the delivery token from the end of message content', () => {
        const token = 'iz0123456789abcdefghijklmnopqrstuvwxyz';
        expect(decodeDeliveryCode(appendDeliveryCode('Visible content', token))).toBe(token);
    });

    test('separates the delivery code from visible content with exactly one ASCII space, not a newline', () => {
        const token = 'iz0';
        expect(appendDeliveryCode('Visible content', token)).toBe(`Visible content ${deliveryCodeFor(token)}`);
    });

    test('separates the delivery code from a trailing URL with a space so link detection is not broken', () => {
        const token = 'iz0';
        const tagged = appendDeliveryCode('See https://example.com/path', token);
        expect(tagged).toBe(`See https://example.com/path ${deliveryCodeFor(token)}`);
        // The character immediately after the URL is a plain ASCII space, which terminates
        // Discord's URL autolinking; it is not part of the invisible zero-width payload.
        expect(tagged.charAt('See https://example.com/path'.length)).toBe(' ');
    });

    test('finds the final delivery code despite unrelated zero-width characters', () => {
        const token = 'izabc0';
        const unrelated = zeroWidth('200B', '200C', '200D', '2060', 'FEFF');
        expect(decodeDeliveryCode(`Visible${unrelated}${deliveryCodeFor(token)}${unrelated}`)).toBe(token);
    });

    test('does not decode malformed, non-final, or unrelated zero-width content', () => {
        const code = deliveryCodeFor('iz0');
        expect(decodeDeliveryCode(zeroWidth('200B', '200C', '200D', '2060'))).toBeUndefined();
        expect(decodeDeliveryCode(`${code}Visible`)).toBeUndefined();
        expect(decodeDeliveryCode(`${code.slice(0, -1)}${zeroWidth('200B')}`)).toBeUndefined();
    });

    test('reserves enough UTF-16 code units to reach exactly Discord maximum without overflow', () => {
        const token = 'iz0123456789abcdef000000';
        const text = 'a'.repeat(maxContentLengthForDeliveryCode(token));
        expect(appendDeliveryCode(text, token)).toHaveLength(DISCORD_MAX_LENGTH);
        expect(appendDeliveryCode(`${text}a`, token)).toHaveLength(DISCORD_MAX_LENGTH + 1);
    });

    test('throws for a token character outside the base-36 alphabet', () => {
        expect(() => deliveryCodeFor('!')).toThrow('Delivery token contains unsupported character: !');
    });

    test('tolerates a trailing start sentinel after the final end sentinel', () => {
        const token = 'iz0';
        const trailingStartSentinel = zeroWidth('2063');
        expect(decodeDeliveryCode(`${deliveryCodeFor(token)}${trailingStartSentinel}`)).toBe(token);
    });

    test('does not decode a valid-looking digit run with no start sentinel before the end sentinel', () => {
        const codeWithoutStartSentinel = deliveryCodeFor('i').slice(1);
        expect(decodeDeliveryCode(codeWithoutStartSentinel)).toBeUndefined();
    });

    test('rejects a delivery code with an empty encoded token between adjacent sentinels', () => {
        expect(decodeDeliveryCode(deliveryCodeFor(''))).toBeUndefined();
    });

    test('stops decoding at the first undecodable character group, never skipping past it', () => {
        const validGroup = deliveryCodeFor('a').slice(1, -1);
        const content = `${zeroWidth('2063')}${validGroup}xyz${validGroup}${zeroWidth('2064')}`;
        expect(decodeDeliveryCode(content)).toBeUndefined();
    });

    test('rejects a payload whose digit count is not a multiple of three', () => {
        const validPayload = deliveryCodeFor('iz').slice(1, -1);
        const withDigits = (...extra: string[]): string => `${zeroWidth('2063')}${validPayload}${zeroWidth(...extra)}${zeroWidth('2064')}`;
        expect(decodeDeliveryCode(withDigits())).toBe('iz');
        expect(decodeDeliveryCode(withDigits('200B'))).toBeUndefined();
        expect(decodeDeliveryCode(withDigits('200B', '200B'))).toBeUndefined();
    });
});

describe('deliveryTokenForBase', () => {
    test('pads part 0 to six zero-padded base36 digits', () => {
        expect(deliveryTokenForBase('abc', 0)).toBe('izabc000000');
    });

    test('encodes part 35 as a single base36 digit padded to six characters', () => {
        expect(deliveryTokenForBase('abc', 35)).toBe('izabc00000z');
    });

    test('truncates a base longer than 17 characters to the base budget', () => {
        const longBase = '0'.repeat(20);
        expect(deliveryTokenForBase(longBase, 0)).toBe(`iz${'0'.repeat(17)}000000`);
    });

    test('DELIVERY_TOKEN_MAX_LENGTH is 25 and bounds every token generated from a short base', () => {
        expect(DELIVERY_TOKEN_MAX_LENGTH).toBe(25);
        expect(deliveryTokenForBase('ab', 0).length).toBeLessThanOrEqual(DELIVERY_TOKEN_MAX_LENGTH);
        expect(deliveryTokenForBase('0'.repeat(17), 35)).toHaveLength(DELIVERY_TOKEN_MAX_LENGTH);
    });
});

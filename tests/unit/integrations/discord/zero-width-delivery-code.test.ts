import { describe, expect, test } from 'bun:test';
import { DISCORD_MAX_LENGTH } from '@/integrations/discord/messages';
import { appendDeliveryCode, decodeDeliveryCode, deliveryCodeFor, maxContentLengthForDeliveryCode } from '@/integrations/discord/zero-width-delivery-code';

const zeroWidth = (...codePoints: string[]): string => String.fromCodePoint(...codePoints.map(codePoint => Number.parseInt(codePoint, 16)));

describe('zero-width delivery code', () => {
    test('encodes a token with the exact invisible alphabet and sentinels', () => {
        expect(deliveryCodeFor('iz0')).toBe(zeroWidth('2063', '200C', '200B', '200D', '200D', '200B', '2060', '200B', '200B', '200B', '2064'));
    });

    test('round-trips the delivery token from the end of message content', () => {
        const token = 'iz0123456789abcdefghijklmnopqrstuvwxyz';
        expect(decodeDeliveryCode(appendDeliveryCode('Visible content', token))).toBe(token);
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
});

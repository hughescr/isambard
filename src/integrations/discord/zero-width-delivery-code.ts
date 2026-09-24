/**
 * Invisible Separator and Invisible Plus bound a delivery code. Its payload uses
 * zero-width space, non-joiner, joiner, and word joiner to encode base-36 tokens.
 */
const START_SENTINEL = '⁣';
const END_SENTINEL = '⁤';
const ZERO_WIDTH_DIGITS = ['​', '‌', '‍', '⁠'] as const;
const ZERO_WIDTH_DIGIT_INDEX = new Map(ZERO_WIDTH_DIGITS.map((digit, index) => [digit, index]));
const TRAILING_ZERO_WIDTH_CHARACTERS = new Set(['​', '‌', '‍', '⁠', '⁣', '⁤', '﻿']);
const TOKEN_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function encodeTokenCharacter(character: string): string {
    const value = TOKEN_ALPHABET.indexOf(character);
    if(value === -1) {
        throw new Error(`Delivery token contains unsupported character: ${character}`);
    }
    const high = ZERO_WIDTH_DIGITS[Math.floor(value / 16)]!;
    const middle = ZERO_WIDTH_DIGITS[Math.floor(value / 4) % 4]!;
    const low = ZERO_WIDTH_DIGITS[value % 4]!;
    return high + middle + low;
}

function decodeTokenCharacter(encoded: string): string | undefined {
    const [first, second, third] = Array.from(encoded, digit => ZERO_WIDTH_DIGIT_INDEX.get(digit as typeof ZERO_WIDTH_DIGITS[number]));
    if(first === undefined || second === undefined || third === undefined || encoded.length !== 3) {
        return undefined;
    }
    return TOKEN_ALPHABET[first * 16 + second * 4 + third];
}

/** Encodes one delivery token as an invisible code bounded by fixed sentinels. */
export function deliveryCodeFor(token: string): string {
    return START_SENTINEL + Array.from(token, character => encodeTokenCharacter(character)).join('') + END_SENTINEL;
}

/** Appends one complete invisible delivery code after visible message content. */
export function appendDeliveryCode(content: string, token: string): string {
    return `${content}\n${deliveryCodeFor(token)}`;
}

/** Returns the visible-content budget whose tagged form is at most Discord's 2,000 UTF-16 code-unit limit. */
export function maxContentLengthForDeliveryCode(token: string, maxLength = 2000): number {
    return maxLength - 1 - deliveryCodeFor(token).length;
}

/**
 * Decodes the final invisible delivery code, ignoring other zero-width characters
 * before and after it. Returns undefined when no complete valid code is present.
 */
export function decodeDeliveryCode(content: string): string | undefined {
    const finalSentinel = content.lastIndexOf(END_SENTINEL);
    if(finalSentinel === -1) {
        return undefined;
    }
    const trailing = content.slice(finalSentinel + END_SENTINEL.length);
    for(const character of trailing) {
        if(!TRAILING_ZERO_WIDTH_CHARACTERS.has(character)) {
            return undefined;
        }
    }
    const startSentinel = content.lastIndexOf(START_SENTINEL, finalSentinel - 1);
    if(startSentinel === -1) {
        return undefined;
    }
    const encoded = content.slice(startSentinel + START_SENTINEL.length, finalSentinel);
    if(encoded.length === 0 || encoded.length % 3 !== 0) {
        return undefined;
    }
    let token = '';
    for(let offset = 0; offset < encoded.length; offset += 3) {
        const character = decodeTokenCharacter(encoded.slice(offset, offset + 3));
        if(character === undefined) {
            return undefined;
        }
        token += character;
    }
    return token;
}

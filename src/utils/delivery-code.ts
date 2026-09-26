/**
 * Invisible Separator and Invisible Plus bound a delivery code. Its payload uses
 * zero-width space, non-joiner, joiner, and word joiner to encode base-36 tokens.
 */
const START_SENTINEL = '⁣';
const END_SENTINEL = '⁤';
const ZERO_WIDTH_DIGITS = ['​', '‌', '‍', '⁠'] as const;
const ZERO_WIDTH_DIGIT_INDEX = new Map(ZERO_WIDTH_DIGITS.map((digit, index) => [digit, index]));
// END_SENTINEL is deliberately excluded: `finalSentinel` below is always the LAST end-sentinel
// occurrence, so no end-sentinel character can ever fall in the trailing slice.
const TRAILING_ZERO_WIDTH_CHARACTERS = new Set(['​', '‌', '‍', '⁠', '⁣', '﻿']);
const TOKEN_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Each base-36 token character is written as exactly this many base-4 zero-width digits. */
const DIGITS_PER_TOKEN_CHARACTER = 3;

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

/**
 * Decodes one group of exactly three digits, passed individually so no caller can hand over a
 * wider slice. A digit missing past the end of the payload arrives as undefined and is rejected
 * like any other non-digit, which is what rejects a payload whose length is not a multiple of 3.
 */
function decodeTokenCharacter(...digits: [string | undefined, string | undefined, string | undefined]): string | undefined {
    const [first, second, third] = digits.map(digit => ZERO_WIDTH_DIGIT_INDEX.get(digit as typeof ZERO_WIDTH_DIGITS[number]));
    if(first === undefined || second === undefined || third === undefined) {
        return undefined;
    }
    return TOKEN_ALPHABET[first * 16 + second * 4 + third];
}

/** Encodes one delivery token as an invisible code bounded by fixed sentinels. */
export function deliveryCodeFor(token: string): string {
    return START_SENTINEL + Array.from(token, character => encodeTokenCharacter(character)).join('') + END_SENTINEL;
}

/**
 * Appends one complete invisible delivery code after visible message content, separated by a
 * single ASCII space. A space (not an empty string) keeps the invisible characters from gluing
 * onto a trailing URL, which Discord's link detection could otherwise swallow into the link and
 * break; a space is whitespace that ends the URL and is invisible at the end of a line. A newline
 * is avoided because Discord renders it as a visible blank line.
 */
export function appendDeliveryCode(content: string, token: string): string {
    return `${content} ${deliveryCodeFor(token)}`;
}

/** Returns the visible-content budget whose tagged form is at most Discord's 2,000 UTF-16 code-unit limit (the `- 1` reserves one code unit for the single-space separator). */
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
    // No `- 1` adjustment needed: position `finalSentinel` itself holds the end sentinel
    // character, never the start sentinel, so bounding the search there is equivalent.
    const startSentinel = content.lastIndexOf(START_SENTINEL, finalSentinel);
    if(startSentinel === -1) {
        return undefined;
    }
    const encoded = content.slice(startSentinel + START_SENTINEL.length, finalSentinel);
    // A non-multiple-of-3 length is not checked explicitly: the final group then reads past the
    // end of the payload, and decodeTokenCharacter rejects the missing digit as undefined.
    if(encoded.length === 0) {
        return undefined;
    }
    let token = '';
    for(let offset = 0; offset < encoded.length; offset += DIGITS_PER_TOKEN_CHARACTER) {
        const character = decodeTokenCharacter(encoded[offset], encoded[offset + 1], encoded[offset + 2]);
        if(character === undefined) {
            return undefined;
        }
        token += character;
    }
    return token;
}

const DELIVERY_TOKEN_PREFIX = 'iz';
const DELIVERY_TOKEN_BASE_MAX_LENGTH = 17;
const DELIVERY_TOKEN_PART_LENGTH = 6;

/** Upper bound on delivery-token length, used by tests to assert the token and chunk budgets. */
export const DELIVERY_TOKEN_MAX_LENGTH = DELIVERY_TOKEN_PREFIX.length + DELIVERY_TOKEN_BASE_MAX_LENGTH + DELIVERY_TOKEN_PART_LENGTH;

/**
 * A compact token that is both a Discord nonce and invisible history correlation code, built from
 * a caller-supplied base (truncated to the base budget) and a zero-padded base-36 part suffix. Any
 * part index gives a token of the same length: the suffix is always exactly
 * {@link DELIVERY_TOKEN_PART_LENGTH} base-36 digits, so a budget reserved for one part's token
 * applies equally to every other part.
 */
export function deliveryTokenForBase(base: string, part: number): string {
    return `${DELIVERY_TOKEN_PREFIX}${base.slice(0, DELIVERY_TOKEN_BASE_MAX_LENGTH)}${part.toString(36).padStart(DELIVERY_TOKEN_PART_LENGTH, '0')}`;
}

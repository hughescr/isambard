import { chain } from 'lodash-es';
/**
 * Maximum message length allowed by Discord API.
 */
export const DISCORD_MAX_LENGTH = 2000;

/**
 * Safe message length with buffer for Discord API.
 * Provides 100 character buffer for safety margin.
 */
export const DISCORD_SAFE_LENGTH = 1900;

/**
 * Checks if a length exceeds the maximum allowed length.
 * Centralizes boundary logic to eliminate equivalent mutants.
 * @param length The length to check
 * @param maxLength The maximum allowed length
 * @returns true if length > maxLength (strictly greater, NOT >=)
 */
export function exceedsLimit(length: number, maxLength: number): boolean {
    return length > maxLength;
}

/**
 * Splits a word that exceeds maxLength into character-based chunks.
 * @param word The word to must be non-empty.split()
 * @param maxLength Maximum length per chunk (must be positive)
 * @returns Array of character chunks (always non-empty for non-empty input)
 */
function splitWordByCharacters(word: string, maxLength: number): string[] {
    // Pre-condition: word is non-empty (guaranteed by callers)
    const chunks: string[] = [];
    let i = 0;
    while(i < word.length) {
        chunks.push(word.slice(i, i + maxLength));
        i += maxLength;
    }
    return chunks;
}

/**
 * Splits text at word boundaries when it exceeds maxLength.
 * Falls back to character splitting for very long words.
 * @param text The text to split at word boundaries (must be non-empty after trimming)
 * @param maxLength Maximum length per chunk
 * @returns Array of chunks split at word boundaries (always non-empty)
 */
function pushNonEmpty(chunks: string[], chunk: string): void {
    if(chunk !== '') {
        chunks.push(chunk);
    }
}

function splitUnits(
    units: string[],
    maxLength: number,
    separator: string,
    splitOversize: (unit: string, maxLength: number) => string[]
): string[] {
    const chunks: string[] = [];
    let currentChunk = '';
    for(const unit of units) {
        if(exceedsLimit(unit.length, maxLength)) {
            pushNonEmpty(chunks, currentChunk);
            currentChunk = '';
            chunks.push(...splitOversize(unit, maxLength));
            continue;
        }

        const combinedLength = currentChunk.length + separator.length + unit.length;
        if(exceedsLimit(combinedLength, maxLength)) {
            pushNonEmpty(chunks, currentChunk);
            currentChunk = unit;
        } else {
            currentChunk = currentChunk === '' ? unit : currentChunk + separator + unit;
        }
    }
    pushNonEmpty(chunks, currentChunk);
    return chunks;
}

function splitByWords(text: string, maxLength: number): string[] {
    // splitUnits already ignores empty units, so a second filtering pass is redundant.
    return splitUnits(text.split(/\s+/), maxLength, ' ', splitWordByCharacters);
}

function extractSentences(text: string): string[] {
    const sentenceBoundary = /[.!?](?=\s)/g;
    const sentences: string[] = [];
    let sentenceStart = 0;

    while(sentenceBoundary.exec(text) !== null) {
        const boundaryEnd = sentenceBoundary.lastIndex;
        sentences.push(text.slice(sentenceStart, boundaryEnd).trim());
        sentenceStart = boundaryEnd;
    }

    const remaining = text.slice(sentenceStart).trim();
    sentences.push(remaining);

    return sentences;
}

function splitBySentences(text: string, maxLength: number): string[] {
    const sentences = extractSentences(text);
    return splitUnits(sentences, maxLength, ' ', splitByWords);
}

/**
 * Splits text at paragraph boundaries (\n\n).
 * Falls back to sentence splitting for very long paragraphs.
 * @param text The text to split at paragraph boundaries (must be non-empty after trimming)
 * @param maxLength Maximum length per chunk
 * @returns Array of chunks split at paragraph boundaries (always non-empty)
 */
function splitByParagraphs(text: string, maxLength: number): string[] {
    const paragraphs = chain(text.split(/\n{2,}/)).map(p => p.trim()).compact().value();
    return splitUnits(paragraphs, maxLength, '\n\n', splitBySentences);
}

/**
 * Splits a long message into Discord-safe chunks.
 *
 * Split hierarchy (preferred to least preferred):
 * 1. Paragraph breaks (\n\n) - preserves document structure
 * 2. Sentence endings (. ! ?) - preserves sentence integrity
 * 3. Word boundaries (spaces) - preserves word integrity
 * 4. Characters - last resort for very long words
 *
 * @param text The message text to split
 * @param maxLength Maximum length per chunk (defaults to DISCORD_SAFE_LENGTH)
 * @returns Array of message chunks, each <= maxLength characters
 *
 * @example
 * ```typescript
 * const chunks = splitMessage("Very long message...", 1900);
 * // Send each chunk as a separate Discord message
 * for (const chunk of chunks) {
 *   await channel.send(chunk);
 * }
 * ```
 */
export function splitMessage(text: string, maxLength: number = DISCORD_SAFE_LENGTH): string[] {
    // Normalize input: trim whitespace
    const normalized = text.trim();

    // A fitting message preserves all internal whitespace exactly.
    if(!exceedsLimit(normalized.length, maxLength)) {
        return [normalized];
    }

    // Split by paragraphs first (this cascades to sentences, words, then characters as needed).
    return splitByParagraphs(normalized, maxLength);
}

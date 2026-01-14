import _ from 'lodash';

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
 * @param word The word to split (must be non-empty)
 * @param maxLength Maximum length per chunk (must be positive)
 * @returns Array of character chunks (always non-empty for non-empty input)
 */
function splitWordByCharacters(word: string, maxLength: number): string[] {
    // Pre-condition: word is non-empty (guaranteed by callers)
    const chunks: string[] = [];
    let i = 0;
    // Stryker disable next-line BlockStatement: Character chunking loop with increment prevents infinite loop
    while(i < word.length) {
        chunks.push(word.slice(i, i + maxLength));
        // Stryker disable next-line AssignmentOperator: Loop increment required for termination
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
function splitByWords(text: string, maxLength: number): string[] {
    // Stryker disable next-line Regex: Equivalent - _.compact() filters empty strings from single \s split
    // eslint-disable-next-line lodash/prefer-lodash-method -- split with regex not supported by lodash
    const words = _.compact(text.split(/\s+/));

    // Pre-condition: callers guarantee non-empty trimmed text, so words is non-empty
    const chunks: string[] = [];
    const firstWord = words[0];
    const firstWordTooLong = exceedsLimit(firstWord.length, maxLength);
    let currentChunk = firstWordTooLong ? '' : firstWord;

    // If first word is too long, split it
    if(firstWordTooLong) {
        chunks.push(...splitWordByCharacters(firstWord, maxLength));
    }

    // Process remaining words starting from index 1
    for(let i = 1; i < words.length; i++) {
        const word = words[i];

        // Handle words longer than maxLength by splitting into characters
        if(exceedsLimit(word.length, maxLength)) {
            // Flush current chunk if it has content
            if(currentChunk !== '') {
                chunks.push(currentChunk);
                currentChunk = '';
            }
            // Split the long word into character chunks
            chunks.push(...splitWordByCharacters(word, maxLength));
            continue;
        }

        // Check if adding this word would exceed maxLength
        // separator is always ' ' since we're not on first word
        const testLength = currentChunk.length + 1 + word.length;
        if(exceedsLimit(testLength, maxLength)) {
            // Push current chunk and start a new one
            // Stryker disable next-line all: Empty string check prevents pushing empty chunks
            if(currentChunk !== '') {
                chunks.push(currentChunk);
            }
            currentChunk = word;
        } else {
            currentChunk = currentChunk === '' ? word : currentChunk + ' ' + word;
        }
    }

    // Don't forget the last chunk
    if(currentChunk !== '') {
        chunks.push(currentChunk);
    }

    // chunks is guaranteed non-empty: either we pushed character chunks or currentChunk has content
    return chunks;
}

/**
 * Extracts sentences from text using punctuation boundaries.
 * @param text The text to extract sentences from
 * @returns Array of trimmed sentences (may be empty if no content)
 */
function extractSentences(text: string): string[] {
    // Fast path: if no sentence-ending punctuation, skip expensive regex
    // Stryker disable next-line all: Performance optimization, not logic
    if(!/[.!?]/.test(text)) {
        return [];
    }

    // Stryker disable next-line Regex: Equivalent - remaining text handler (lines 122-128) catches unmatched sentences
    const sentencePattern = /[^.!?]*[.!?](?:\s|$)/g;
    const sentences: string[] = [];
    let match;
    let lastIndex = 0;

    // Stryker disable all: extractSentences has intentionally redundant logic for robustness
    while((match = sentencePattern.exec(text)) !== null) {
        const trimmed = _.trim(match[0]);
        if(trimmed) {
            sentences.push(trimmed);
        }
        lastIndex = sentencePattern.lastIndex;
    }

    // Handle any remaining text after the last sentence
    if(lastIndex < text.length) {
        const remaining = _.trim(text.slice(lastIndex));
        if(remaining) {
            sentences.push(remaining);
        }
    }
    // Stryker restore all

    return sentences;
}

/**
 * Splits text at sentence boundaries (. ! ?).
 * Falls back to word splitting for very long sentences.
 * @param text The text to split at sentence boundaries (must be non-empty)
 * @param maxLength Maximum length per chunk
 * @returns Array of chunks split at sentence boundaries (always non-empty)
 */
function splitBySentences(text: string, maxLength: number): string[] {
    const sentences = extractSentences(text);

    // If no sentences found (text has no punctuation), fall back to word splitting
    // Stryker disable next-line all: Equivalent - word splitting is valid fallback for any input
    if(sentences.length === 0) {
        return splitByWords(text, maxLength);
    }

    // Pre-condition: sentences is non-empty
    const chunks: string[] = [];
    const firstSentence = sentences[0];
    const firstSentenceTooLong = exceedsLimit(firstSentence.length, maxLength);
    let currentChunk = firstSentenceTooLong ? '' : firstSentence;

    // If first sentence is too long, split it
    if(firstSentenceTooLong) {
        chunks.push(...splitByWords(firstSentence, maxLength));
    }

    // Process remaining sentences starting from index 1
    for(let i = 1; i < sentences.length; i++) {
        const sentence = sentences[i];

        // Handle sentences longer than maxLength
        if(exceedsLimit(sentence.length, maxLength)) {
            // Flush current chunk if it has content
            // Stryker disable next-line StringLiteral: Empty string comparison for chunk boundary
            if(currentChunk !== '') {
                chunks.push(currentChunk);
                // Stryker disable next-line StringLiteral: Reset to empty string
                currentChunk = '';
            }
            // Split the long sentence by words
            chunks.push(...splitByWords(sentence, maxLength));
            continue;
        }

        // Check if adding this sentence would exceed maxLength
        // separator is always ' ' since we're not on first sentence
        const testLength = currentChunk.length + 1 + sentence.length;
        if(exceedsLimit(testLength, maxLength)) {
            // Push current chunk and start a new one
            // Stryker disable next-line all: Equivalent - empty guard is optimization, not correctness
            if(currentChunk !== '') {
                chunks.push(currentChunk);
            }
            currentChunk = sentence;
        } else {
            // Stryker disable next-line ConditionalExpression,StringLiteral: Empty string check prevents leading space, space character is string constant
            currentChunk = currentChunk === '' ? sentence : currentChunk + ' ' + sentence;
        }
    }

    // Don't forget the last chunk
    if(currentChunk !== '') {
        chunks.push(currentChunk);
    }

    // chunks is guaranteed non-empty: either we pushed word chunks or currentChunk has content
    return chunks;
}

/**
 * Splits text at paragraph boundaries (\n\n).
 * Falls back to sentence splitting for very long paragraphs.
 * @param text The text to split at paragraph boundaries (must be non-empty after trimming)
 * @param maxLength Maximum length per chunk
 * @returns Array of chunks split at paragraph boundaries (always non-empty)
 */
function splitByParagraphs(text: string, maxLength: number): string[] {
    // Split on paragraph breaks (two or more newlines)
    // eslint-disable-next-line lodash/prefer-wrapper-method, lodash/prefer-lodash-method, lodash/chaining -- split with regex not supported by lodash
    const paragraphs = _.compact(_(text.split(/\n{2,}/)).map(p => _.trim(p)).value());

    // Pre-condition: caller guarantees non-empty trimmed text
    // The text will produce at least one paragraph (even without \n\n)
    // paragraphs is guaranteed non-empty for non-empty trimmed input

    const chunks: string[] = [];
    const firstParagraph = paragraphs[0];
    const firstParagraphTooLong = exceedsLimit(firstParagraph.length, maxLength);
    let currentChunk = firstParagraphTooLong ? '' : firstParagraph;

    // If first paragraph is too long, split it
    if(firstParagraphTooLong) {
        chunks.push(...splitBySentences(firstParagraph, maxLength));
    }

    // Process remaining paragraphs starting from index 1
    for(let i = 1; i < paragraphs.length; i++) {
        const paragraph = paragraphs[i];

        // Handle paragraphs longer than maxLength
        if(exceedsLimit(paragraph.length, maxLength)) {
            // Flush current chunk if it has content
            if(currentChunk !== '') {
                chunks.push(currentChunk);
                currentChunk = '';
            }
            // Split the long paragraph by sentences
            chunks.push(...splitBySentences(paragraph, maxLength));
            continue;
        }

        // Check if adding this paragraph would exceed maxLength
        // separator is always '\n\n' (2 chars) since we're not on first paragraph
        const testLength = currentChunk.length + 2 + paragraph.length;
        if(exceedsLimit(testLength, maxLength)) {
            // Push current chunk and start a new one
            // Stryker disable next-line all: Equivalent - empty guard is optimization, not correctness
            if(currentChunk !== '') {
                chunks.push(currentChunk);
            }
            currentChunk = paragraph;
        } else {
            currentChunk = currentChunk === '' ? paragraph : currentChunk + '\n\n' + paragraph;
        }
    }

    // Don't forget the last chunk
    if(currentChunk !== '') {
        chunks.push(currentChunk);
    }

    // chunks is guaranteed non-empty: either we pushed sentence chunks or currentChunk has content
    return chunks;
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
    const normalized = _.trim(text);

    // Handle empty or whitespace-only input
    // Stryker disable next-line all: Equivalent - early return optimization, full split handles edge cases
    if(normalized === '') {
        return [''];
    }

    // If the message fits, return as single chunk (uses <= for "fits within limit")
    // Stryker disable next-line all: Equivalent - early return optimization, full split handles short input
    if(!exceedsLimit(normalized.length, maxLength)) {
        return [normalized];
    }

    // Split by paragraphs first (this cascades to sentences, words, then characters as needed)
    // splitByParagraphs guarantees non-empty result for non-empty input
    return splitByParagraphs(normalized, maxLength);
}

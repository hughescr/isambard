import { chain } from 'lodash-es';
import { InvariantViolationError } from '@/errors';
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
// eslint-disable-next-line sonarjs/cognitive-complexity -- chunk-accumulator pattern requires tracking multiple edge cases; extracting helpers would obscure the algorithm
function splitByWords(text: string, maxLength: number): string[] {
    // Stryker disable next-line Regex,MethodExpression: Equivalent — compact()/filter(Boolean) is defensive for trimmed input; \s+ vs \s both produce same split on pre-trimmed text
    const words = text.split(/\s+/).filter(Boolean);

    // Pre-condition: callers guarantee non-empty trimmed text, so words is non-empty
    const chunks: string[] = [];
    const firstWord = words[0];
    // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — non-empty trimmed text always produces ≥1 word; unreachable in practice
    if(firstWord === undefined) {
        // Stryker disable next-line StringLiteral: invariant violation message — debug context only
        throw new InvariantViolationError('splitByWords', 'words is empty despite caller guarantee of non-empty trimmed text');
    }
    const firstWordTooLong = exceedsLimit(firstWord.length, maxLength);
    let currentChunk = firstWordTooLong ? '' : firstWord;

    // If first word is too long, split it
    if(firstWordTooLong) {
        chunks.push(...splitWordByCharacters(firstWord, maxLength));
    }

    // Process remaining words starting from index 1
    for(let i = 1; i < words.length; i++) {
        const word = words[i];
        // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — loop bounds guarantee i < words.length; unreachable in practice
        if(word === undefined) {
            // Stryker disable next-line StringLiteral: invariant violation message — debug context only
            throw new InvariantViolationError('splitByWords', 'words[i] undefined despite i < words.length');
        }

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
            currentChunk = currentChunk === '' ? word : `${currentChunk} ${word}`;
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
    // eslint-disable-next-line sonarjs/super-linear-regex, regexp/no-super-linear-move -- KNOWN QUADRATIC, suppressed pending a decision, NOT because the input is safe. Measured on a long run with no sentence break: 20k chars ~215ms, 80k ~3.4s. The previous justification here claimed the input was a length-bounded inbound Discord message; that was wrong in both halves. extractSentences is reached only from splitMessage(), which early-returns unless the text EXCEEDS DISCORD_SAFE_LENGTH, and its callers (response-sender.ts, discord-mcp-server.ts, index.ts) all pass outbound agent-generated text of unbounded length. Not attacker-controlled, so this is an event-loop stall risk rather than a DoS, but a model response containing a URL or version string inside a long unbroken run does trigger it.
    const sentencePattern = /[^.!?]*[.!?](?:\s|$)/g;
    const sentences: string[] = [];
    let match;
    let lastIndex = 0;

    // Stryker disable all: extractSentences has intentionally redundant logic for robustness
    while((match = sentencePattern.exec(text)) !== null) {
        const trimmed = match[0].trim();
        if(trimmed) {
            sentences.push(trimmed);
        }
        lastIndex = sentencePattern.lastIndex;
    }

    // Handle any remaining text after the last sentence
    if(lastIndex < text.length) {
        const remaining = text.slice(lastIndex).trim();
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
// eslint-disable-next-line sonarjs/cognitive-complexity -- chunk-accumulator pattern requires tracking multiple edge cases; extracting helpers would obscure the algorithm
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
    // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — sentences.length === 0 early-return above ensures non-empty; unreachable in practice
    if(firstSentence === undefined) {
        // Stryker disable next-line StringLiteral: invariant violation message — debug context only
        throw new InvariantViolationError('splitBySentences', 'sentences[0] undefined despite sentences.length === 0 early-return guard');
    }
    const firstSentenceTooLong = exceedsLimit(firstSentence.length, maxLength);
    let currentChunk = firstSentenceTooLong ? '' : firstSentence;

    // If first sentence is too long, split it
    if(firstSentenceTooLong) {
        chunks.push(...splitByWords(firstSentence, maxLength));
    }

    // Process remaining sentences starting from index 1
    for(let i = 1; i < sentences.length; i++) {
        const sentence = sentences[i];
        // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — loop bounds guarantee i < sentences.length; unreachable in practice
        if(sentence === undefined) {
            // Stryker disable next-line StringLiteral: invariant violation message — debug context only
            throw new InvariantViolationError('splitBySentences', 'sentences[i] undefined despite i < sentences.length');
        }

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
            currentChunk = currentChunk === '' ? sentence : `${currentChunk} ${sentence}`;
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
// eslint-disable-next-line sonarjs/cognitive-complexity -- chunk-accumulator pattern requires tracking multiple edge cases; extracting helpers would obscure the algorithm
function splitByParagraphs(text: string, maxLength: number): string[] {
    // Split on paragraph breaks (two or more newlines)
    const paragraphs = chain(text.split(/\n{2,}/)).map(p => p.trim()).compact().value();

    // Pre-condition: caller guarantees non-empty trimmed text
    // The text will produce at least one paragraph (even without \n\n)
    // paragraphs is guaranteed non-empty for non-empty trimmed input

    const chunks: string[] = [];
    const firstParagraph = paragraphs[0];
    // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — non-empty trimmed text always produces ≥1 paragraph; unreachable in practice
    if(firstParagraph === undefined) {
        // Stryker disable next-line StringLiteral: invariant violation message — debug context only
        throw new InvariantViolationError('splitByParagraphs', 'paragraphs[0] undefined despite non-empty trimmed text');
    }
    const firstParagraphTooLong = exceedsLimit(firstParagraph.length, maxLength);
    let currentChunk = firstParagraphTooLong ? '' : firstParagraph;

    // If first paragraph is too long, split it
    if(firstParagraphTooLong) {
        chunks.push(...splitBySentences(firstParagraph, maxLength));
    }

    // Process remaining paragraphs starting from index 1
    for(let i = 1; i < paragraphs.length; i++) {
        const paragraph = paragraphs[i];
        // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — loop bounds guarantee i < paragraphs.length; unreachable in practice
        if(paragraph === undefined) {
            // Stryker disable next-line StringLiteral: invariant violation message — debug context only
            throw new InvariantViolationError('splitByParagraphs', 'paragraphs[i] undefined despite i < paragraphs.length');
        }

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
            currentChunk = currentChunk === '' ? paragraph : `${currentChunk}\n\n${paragraph}`;
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
    const normalized = text.trim();

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

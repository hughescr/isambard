import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** How many filenames one tool text lists before it only counts the rest. */
const LISTED_NAMES_MAX = 10;

/** The most characters (grapheme clusters) of one filename a tool text shows. */
const LISTED_NAME_MAX_CHARACTERS = 80;

/** Control characters, and the bidi marks, embeddings, overrides and isolates that can make a name read as another. */
export const UNSAFE_NAME_CHARACTERS = /[\p{Cc}\u{61C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

/** The most UTF-16 code units of one filename that are stripped and segmented, so the work per name is bounded however long it is. */
const LISTED_NAME_SCAN_MAX_CODE_UNITS = 1024;

const graphemes = new Intl.Segmenter();

/**
 * A filename from WildDuck or the tool arguments, made safe for tool text: cut to its first
 * {@link LISTED_NAME_SCAN_MAX_CODE_UNITS} code units, unsafe characters stripped, then cut to
 * {@link LISTED_NAME_MAX_CHARACTERS}; a name cut either way ends with an ellipsis.
 */
export function displayName(name: string): string {
    const scanned = name.slice(0, LISTED_NAME_SCAN_MAX_CODE_UNITS);
    const characters = Array.from(graphemes.segment(scanned.replaceAll(UNSAFE_NAME_CHARACTERS, '')), ({ segment }) => segment);
    return characters.length > LISTED_NAME_MAX_CHARACTERS || scanned.length < name.length
        ? `${characters.slice(0, LISTED_NAME_MAX_CHARACTERS).join('')}…`
        : characters.join('');
}

/** Filenames for tool text, comma-separated: the first {@link LISTED_NAMES_MAX}, each made safe and quoted, then how many more (counted, not formatted). */
export function quotedNames(names: Iterable<string>): string {
    const all = [...names];
    const listed = all.slice(0, LISTED_NAMES_MAX).map(name => JSON.stringify(displayName(name))).join(', ');
    return all.length > LISTED_NAMES_MAX ? `${listed} and ${all.length - LISTED_NAMES_MAX} more` : listed;
}

/** `count` and its noun, singular for one. */
export function counted(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

/** An amend's refusal or failure as an error tool result. */
export function amendError(text: string): CallToolResult {
    return { content: [{ type: 'text' as const, text }], isError: true };
}

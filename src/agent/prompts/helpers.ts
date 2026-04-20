/**
 * Shared prompt formatting helpers.
 *
 * These utilities are used by the various prompt builders
 * (perch, catch-up, resume) for consistent section delimiters
 * and optional-section formatting.
 */

/**
 * Canonical separator between major prompt sections.
 * Used when transitioning between a context header and body content.
 */
export const PROMPT_SECTION_SEPARATOR = '\n\n---\n\n';

/**
 * Wrap text in a `--- BANNER ---` style delimiter line.
 *
 * @param text - The banner text (will be upper-cased by convention in callers)
 * @returns Formatted banner string, e.g. `--- PERCH TIME RESUMED ---`
 *
 * @example
 * ```typescript
 * formatBanner('PERCH TIME RESUMED') // '--- PERCH TIME RESUMED ---'
 * ```
 */
export function formatBanner(text: string): string {
    return `--- ${text} ---`;
}

/**
 * Format an optional prompt section.
 * Returns `null` when the content is empty or whitespace-only,
 * allowing callers to compact away absent sections.
 *
 * @param label  - Section label, shown as-is (e.g. `'[Your thinking at timeout:]'`)
 * @param content - Section body text
 * @returns Formatted `label\ncontent` string, or `null` if content is blank
 *
 * @example
 * ```typescript
 * formatOptionalSection('[Your thinking:]', 'Some thought') // '[Your thinking:]\nSome thought'
 * formatOptionalSection('[Your thinking:]', '')             // null
 * ```
 */
export function formatOptionalSection(label: string, content: string): string | null {
    if(!content.trim()) {
        return null;
    }
    return `${label}\n${content}`;
}

/**
 * Prompt-hygiene assertion shared by every prompt-builder test (`system-prompt.test.ts`,
 * `subagent-prompt.test.ts`, `shared-sections.test.ts`): no unresolved `{PLACEHOLDER}` tokens,
 * no trailing whitespace on any line, and no duplicated (back-to-back) blank lines.
 *
 * Extracted from `system-prompt.test.ts` so the sub-agent prompt is held to exactly the same
 * bar as the session prompt, rather than to a second, drifting copy of the same check.
 *
 * @module tests/helpers/prompt-hygiene
 */
import { expect } from 'bun:test';

/**
 * Asserts the shared prompt-hygiene invariants on a rendered prompt or prompt fragment.
 * @param text The prompt text to check
 */
export function assertPromptHygiene(text: string): void {
    expect(text).not.toMatch(/\{[A-Z_]+\}/);
    for(const line of text.split('\n')) {
        expect(line).not.toMatch(/\s$/);
    }
    expect(text).not.toContain('\n\n\n');
}

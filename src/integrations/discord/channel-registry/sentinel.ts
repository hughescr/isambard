import replace from 'lodash/replace';
import trim from 'lodash/trim';
/**
 * The sentinel string that indicates "do not send this response".
 * If the agent's response contains this, suppress sending to Discord.
 */
export const NO_RESPONSE_SENTINEL = '@@NO_RESPONSE@@';

/**
 * Checks if a response contains the no-response sentinel.
 * @param response The agent's response text
 * @returns true if the sentinel is present
 */
export function hasSentinel(response: string): boolean {
    return response.includes(NO_RESPONSE_SENTINEL);
}

/**
 * Strips the sentinel from a response.
 * Also trims any resulting whitespace.
 * @param response The agent's response text
 * @returns The response with sentinel removed and trimmed
 */
export function stripSentinel(response: string): string {
    return trim(replace(response, NO_RESPONSE_SENTINEL, ''));
}

/**
 * Processes a response, checking for sentinel and extracting content.
 * @param response The agent's response text
 * @returns Object with shouldSend flag and cleaned content
 */
export function processResponse(response: string): {
    shouldSend: boolean
    content:    string
} {
    const containsSentinel = hasSentinel(response);
    const content = containsSentinel ? stripSentinel(response) : response;

    return {
        shouldSend: !containsSentinel,
        content,
    };
}

/**
 * Session ID extraction
 *
 * Extracts session IDs from SDK stream events.
 */

import type { SystemEvent } from './types';

/**
 * Extracts session ID from a system init event.
 *
 * The Claude SDK emits a system event with subtype 'init' at the start of each query,
 * which contains the session_id field.
 *
 * @param event - Stream event from the SDK (unknown type for flexibility)
 * @returns Session ID if found, undefined otherwise
 */
export const extractSessionId = (event: unknown): string | undefined => {
    if(!(typeof event === 'object' && event !== null)) {
        return undefined;
    }

    const typedEvent = event as Partial<SystemEvent>;

    if(typedEvent.type !== 'system' || typedEvent.subtype !== 'init') {
        return undefined;
    }

    return typedEvent.session_id;
};

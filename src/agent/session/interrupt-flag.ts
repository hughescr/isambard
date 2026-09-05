/**
 * A mutable flag a session sets while an interrupt is in flight, so query options built before
 * the session exists (the stderr classifier in ./query-options.ts) can read its live value via
 * a closure without depending on the session object itself.
 *
 * @module agent/session/interrupt-flag
 */

/** Mutable interrupt-in-flight flag, owned by exactly one session for its whole lifetime. */
export interface InterruptFlag {
    value: boolean
}

/** Creates a fresh {@link InterruptFlag}, initially `false`. */
export function createInterruptFlag(): InterruptFlag {
    return { value: false };
}

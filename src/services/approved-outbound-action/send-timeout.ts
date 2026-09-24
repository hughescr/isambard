/**
 * Wait for `work` for at most `timeoutMs`. Resolves `{ value }` when the work resolves first,
 * rejects with the work's own error when it rejects first, and resolves undefined when the
 * deadline passes first. The timer is always cleared once the race settles.
 *
 * A timeout can invoke caller-supplied cancellation after the deadline outcome has won. A late
 * rejection is observed by the race's own subscription, so it never becomes an unhandled
 * rejection.
 */
export async function raceDeadline<T>(work: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<{ value: T } | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
            resolve(undefined);
            onTimeout?.();
        }, timeoutMs);
    });
    try {
        return await Promise.race([work.then(value => ({ value })), deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Wait for an external send for at most `timeoutMs`. Resolves `'sent'` when the send resolves
 * first, rejects with the send's own error when it rejects first, and resolves `'timed-out'`
 * when the deadline passes first (see {@link raceDeadline}).
 *
 * After a timeout the remote service may still have applied the send, so the caller must treat
 * the outcome as unknown.
 */
export async function raceSendTimeout(send: Promise<void>, timeoutMs: number, onTimeout?: () => void): Promise<'sent' | 'timed-out'> {
    return await raceDeadline(send, timeoutMs, onTimeout) === undefined ? 'timed-out' : 'sent';
}

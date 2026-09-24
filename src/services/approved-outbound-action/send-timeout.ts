/**
 * Wait for an external send for at most `timeoutMs`. Resolves `'sent'` when the send resolves
 * first, rejects with the send's own error when it rejects first, and resolves `'timed-out'`
 * when the deadline passes first. The timer is always cleared once the race settles.
 *
 * A timeout only stops waiting: the send itself is not cancelled and may still land (or fail)
 * later, so the caller must treat a timed-out send's outcome as unknown. A late rejection is
 * observed by the race's own subscription, so it never becomes an unhandled rejection.
 */
export async function raceSendTimeout(send: Promise<void>, timeoutMs: number): Promise<'sent' | 'timed-out'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timed-out'>((resolve) => {
        timer = setTimeout(() => {
            resolve('timed-out');
        }, timeoutMs);
    });
    try {
        return await Promise.race([send.then(() => 'sent' as const), deadline]);
    } finally {
        clearTimeout(timer);
    }
}

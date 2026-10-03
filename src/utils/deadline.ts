/**
 * A cancellable deadline: an abort signal that fires a `TimeoutError` after a while, plus a way to
 * stand it down. Use this instead of `AbortSignal.timeout(ms)` for an operation-scoped deadline:
 * the native version cannot be cancelled, so it stays armed (for minutes, in some of our
 * fetches) after the operation it guarded has finished.
 */
export interface Deadline {
    readonly signal: AbortSignal
    /** Stands the deadline down. Call when the guarded operation settles, on every path. Safe to call twice. */
    clear():         void
}

/**
 * Creates a deadline that aborts its signal with a `TimeoutError` (`DOMException`, matching what
 * `AbortSignal.timeout` produces) after `ms` milliseconds.
 * @param ms Milliseconds until the signal aborts
 * @returns The signal and its `clear()`
 */
export function createDeadline(ms: number): Deadline {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    }, ms);
    return {
        signal: controller.signal,
        clear:  () => { clearTimeout(timer); },
    };
}

/**
 * Builds a deadline factory for a class whose tests inject their own `(ms) => AbortSignal` seam.
 * With no seam it is {@link createDeadline}; with one, the injected signal is used as is and
 * `clear()` has nothing to stand down.
 * @param inject The test seam, if any
 * @returns A function that makes a deadline for a duration
 */
export function deadlineFactory(inject: ((ms: number) => AbortSignal) | undefined): (ms: number) => Deadline {
    if(inject === undefined) {
        return createDeadline;
    }
    return ms => ({ signal: inject(ms), clear: () => undefined });
}

/**
 * Returns `response` with its deadline tied to its body: the deadline stands down when the body
 * ends, fails or is cancelled, so the deadline keeps covering a slow body read by the caller yet
 * never outlives the response. A response with no body has nothing left to guard, so its deadline
 * stands down at once and the response is returned as is.
 * @param response The response whose body the deadline guards
 * @param deadline The deadline that was armed for the request
 * @returns A response with the same status, status text and headers whose body settles the deadline
 */
export function clearDeadlineWhenBodySettles(response: Response, deadline: Deadline): Response {
    if(response.body === null) {
        deadline.clear();
        return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const chunk = await reader.read();
                if(chunk.done) {
                    deadline.clear();
                    controller.close();
                } else {
                    controller.enqueue(chunk.value);
                }
            } catch (error) {
                deadline.clear();
                controller.error(error);
            }
        },
        async cancel(reason) {
            deadline.clear();
            await reader.cancel(reason);
        },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

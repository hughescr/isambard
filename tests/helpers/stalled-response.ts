/**
 * A response whose body delivers one chunk and then stalls forever, recording whether anything
 * cancelled it. Used to prove that code which returns early on an error status (without reading the
 * body) cancels the abandoned body, rather than leaving a stalled transport open once its deadline
 * has stood down.
 *
 * @module tests/helpers/stalled-response
 */

/** A stalled response plus a view of whether its body was cancelled. */
export interface StalledResponse {
    readonly response:  Response
    /** True once the body's underlying source was cancelled (what an aborted/closed connection looks like to the source) */
    readonly cancelled: () => boolean
}

/**
 * Builds a stalled, non-empty response with the given status.
 * @param status HTTP status of the response (typically an error status)
 * @returns The response and a cancel probe
 */
export function stalledResponse(status: number): StalledResponse {
    let wasCancelled = false;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('partial error body'));
        },
        pull: async () => Promise.withResolvers<void>().promise,
        cancel() {
            wasCancelled = true;
        },
    });
    return {
        response:  new Response(body, { status, statusText: 'Stalled' }),
        cancelled: () => wasCancelled,
    };
}

/**
 * Minimal logger interface required by safeAsyncHandler.
 * Compatible with Pick<Logger, 'error'> but usable with test mocks.
 */
export interface SafeAsyncLogger {
    error: (message: string, meta: { error: unknown }) => unknown
}

/**
 * Wraps an async event handler so it returns void and logs rejections.
 * Use this for event emitter callbacks (process.on, client.on) where
 * the caller expects a synchronous void-returning function.
 *
 * @param handler - The async event handler to wrap
 * @param logger - Logger instance for error reporting
 * @param context - Optional context string to prefix error messages (e.g. 'SIGINT handler')
 * @returns A synchronous void-returning function that runs the handler and logs errors
 */
export function safeAsyncHandler<TArgs extends unknown[]>(
    handler: (...args: TArgs) => Promise<void>,
    logger: SafeAsyncLogger,
    context?: string
): (...args: TArgs) => void {
    return (...args: TArgs): void => {
        void handler(...args).catch((error: unknown) => {
            const message = context ? `${context}: ${String(error)}` : String(error);
            logger.error(message, { error });
        });
    };
}

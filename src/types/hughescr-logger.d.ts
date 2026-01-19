// Type augmentation for @hughescr/logger to support pino-style API
// The runtime implementation (processLogArgs) handles multiple formats:
// - String-first: logger.info('message', { key: value })
// - Object-first (pino-style): logger.info({ key: value }, 'message')
// - Object-only: logger.info({ msg: 'message' })

declare module '@hughescr/logger' {
    /* eslint-disable @typescript-eslint/no-explicit-any -- Logger accepts flexible arguments */
    interface Logger {
        info(...args: any[]): void
        warn(...args: any[]): void
        error(...args: any[]): void
        debug(...args: any[]): void
    }
    /* eslint-enable @typescript-eslint/no-explicit-any -- Re-enable no-explicit-any */

    export const logger: Logger;
    export const noprefix: string;
    export const middleware: unknown;
}

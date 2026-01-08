// Type augmentation for @hughescr/logger to support pino-style API
// The runtime implementation (processLogArgs) handles multiple formats:
// - String-first: logger.info('message', { key: value })
// - Object-first (pino-style): logger.info({ key: value }, 'message')
// - Object-only: logger.info({ msg: 'message' })

declare module '@hughescr/logger' {
    interface Logger {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger accepts flexible arguments
        info(...args: any[]): void
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger accepts flexible arguments
        warn(...args: any[]): void
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger accepts flexible arguments
        error(...args: any[]): void
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger accepts flexible arguments
        debug(...args: any[]): void
    }

    export const logger: Logger;
    export const noprefix: string;
    export const middleware: unknown;
}

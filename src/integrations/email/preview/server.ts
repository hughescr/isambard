import { logger } from '@hughescr/logger';

/** The subset of `Bun.serve`'s options the preview server sets. */
export interface PreviewServeOptions {
    hostname:    string
    port:        number
    /** Seconds a connection may sit idle; a streaming download is not idle. */
    idleTimeout: number
    fetch:       (request: Request) => Promise<Response>
    error:       (err: Error) => Response
}

/** `Bun.serve`, injected so tests never open a socket. */
export type PreviewServe = (options: PreviewServeOptions) => { stop(closeActiveConnections?: boolean): Promise<void> | void };

export interface PreviewServer {
    stop(): Promise<void>
}

/**
 * Start the draft preview server (#158) on 127.0.0.1 only — never another interface; the admin's
 * devices reach it through `tailscale serve`. A bind failure is logged and yields undefined, so
 * the caller shows no preview links; it never fails startup.
 */
export function startDraftPreviewServer(port: number, handler: (request: Request) => Promise<Response>, serve: PreviewServe): PreviewServer | undefined {
    try {
        const server = serve({
            hostname:    '127.0.0.1',
            port,
            idleTimeout: 60,
            fetch:       handler,
            error:       (err: Error) => {
                logger.error({ error: err.message, msg: 'Draft preview request failed' });
                return new Response('Internal error.', { status: 500, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
            },
        });
        logger.info({ port, msg: 'Draft preview server listening on 127.0.0.1' });
        return {
            stop: async () => {
                await server.stop(true);
            },
        };
    } catch (err: unknown) {
        logger.error({ port, error: err instanceof Error ? err.message : String(err), msg: 'Draft preview server failed to start; approval cards will carry no preview links' });
        return undefined;
    }
}

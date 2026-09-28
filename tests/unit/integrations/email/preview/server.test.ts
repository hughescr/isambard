import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { mockLogger } from '../../../../setup';
import { startDraftPreviewServer, type PreviewServe, type PreviewServeOptions } from '@/integrations/email/preview';

function fakeServe(): { serve: ReturnType<typeof mock<PreviewServe>>, stop: ReturnType<typeof mock<(close?: boolean) => Promise<void>>> } {
    const stop = mock(async (_close?: boolean): Promise<void> => {});
    const serve = mock((_options: PreviewServeOptions) => ({ stop }));
    return { serve, stop };
}

function optionsOf(serve: ReturnType<typeof mock<PreviewServe>>): PreviewServeOptions {
    return serve.mock.calls[0][0];
}

describe('startDraftPreviewServer', () => {
    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
    });

    test('binds the handler to 127.0.0.1 only, on the configured port, with a 60 s idle timeout', async () => {
        const { serve } = fakeServe();
        const handler = mock(async (_request: Request) => new Response('ok'));

        expect(startDraftPreviewServer(8791, handler, serve)).toBeDefined();

        const options = optionsOf(serve);
        expect(options.hostname).toBe('127.0.0.1');
        expect(options.port).toBe(8791);
        expect(options.idleTimeout).toBe(60);
        expect(options.fetch).toBe(handler);
        expect(mockLogger.info).toHaveBeenCalledWith({ port: 8791, msg: 'Draft preview server listening on 127.0.0.1' });
    });

    test('answers an unexpected handler failure with a bare 500, logged', async () => {
        const { serve } = fakeServe();
        startDraftPreviewServer(8791, async () => new Response('ok'), serve);

        const response = optionsOf(serve).error(new Error('render blew up'));

        expect(response.status).toBe(500);
        expect(await response.text()).toBe('Internal error.');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(mockLogger.error).toHaveBeenCalledWith({ error: 'render blew up', msg: 'Draft preview request failed' });
    });

    test('stops the server, closing active connections', async () => {
        const { serve, stop } = fakeServe();

        await startDraftPreviewServer(8791, async () => new Response('ok'), serve)?.stop();

        expect(stop.mock.calls).toEqual([[true]]);
    });

    test('does not report the server stopped until its connections have closed', async () => {
        const { serve, stop } = fakeServe();
        const closed = Promise.withResolvers<undefined>();
        stop.mockImplementation(async () => closed.promise);

        const stopping = startDraftPreviewServer(8791, async () => new Response('ok'), serve)?.stop();
        await Promise.resolve();
        await Promise.resolve();

        expect(stop).toHaveBeenCalledTimes(1);
        expect(Bun.peek.status(stopping!)).toBe('pending');
        closed.resolve(undefined);
        expect(await stopping).toBeUndefined();
    });

    test('logs a bind failure and reports no server', () => {
        const serve = mock((_options: PreviewServeOptions): { stop: () => Promise<void> } => {
            throw new Error('EADDRINUSE');
        });

        expect(startDraftPreviewServer(8791, async () => new Response('ok'), serve)).toBeUndefined();
        expect(mockLogger.error).toHaveBeenCalledWith({ port: 8791, error: 'EADDRINUSE', msg: 'Draft preview server failed to start; approval cards will carry no preview links' });
    });

    test('logs a non-Error bind failure as a string', () => {
        const serve = mock((_options: PreviewServeOptions): { stop: () => Promise<void> } => {
            throw 'port taken';
        });

        expect(startDraftPreviewServer(8791, async () => new Response('ok'), serve)).toBeUndefined();
        expect(mockLogger.error).toHaveBeenCalledWith({ port: 8791, error: 'port taken', msg: 'Draft preview server failed to start; approval cards will carry no preview links' });
    });
});

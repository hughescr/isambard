import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { mockLogger } from '../../../../setup';
import { startDraftPreview, startDraftPreviewServer, type PreviewServe, type PreviewServeOptions } from '@/integrations/email/preview';
import type { WildDuckMessage } from '@/integrations/email/wildduck-client';

const TOKEN = 'A'.repeat(43);

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

describe('startDraftPreview', () => {
    const CONFIG = { port: 8791, publicBaseUrl: 'https://mac.tailnet.ts.net', ttlHours: 2 };
    const NOW = Date.parse('2026-09-27T12:00:00.000Z');

    function client(date: string): { getMessage: ReturnType<typeof mock>, openAttachmentStream: ReturnType<typeof mock> } {
        const draft: WildDuckMessage = { id: 42, draft: true, date, metaData: { previewToken: TOKEN } };
        return {
            getMessage:           mock(async () => draft),
            openAttachmentStream: mock(async () => null),
        };
    }

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('is disabled, starting nothing, without preview config', () => {
        const { serve } = fakeServe();
        const registerCleanup = mock(() => {});

        expect(startDraftPreview(undefined, { wildDuckClient: client(''), serve, registerCleanup })).toBeUndefined();
        expect(serve).not.toHaveBeenCalled();
        expect(registerCleanup).not.toHaveBeenCalled();
    });

    test('starts the server, registers its shutdown, and builds links under the public base URL', async () => {
        const { serve, stop } = fakeServe();
        const registerCleanup = mock((_step: { name: string, run: () => void | Promise<void> }) => {});

        const previewUrlFor = startDraftPreview(CONFIG, { wildDuckClient: client(''), serve, registerCleanup });

        expect(previewUrlFor?.(42, TOKEN)).toBe(`https://mac.tailnet.ts.net/d/42/${TOKEN}`);
        expect(optionsOf(serve).port).toBe(8791);
        expect(registerCleanup.mock.calls[0][0].name).toBe('email preview server');
        await registerCleanup.mock.calls[0][0].run();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    test('offers no links when the server could not start', () => {
        const serve = mock((_options: PreviewServeOptions): { stop: () => Promise<void> } => {
            throw new Error('EACCES');
        });
        const registerCleanup = mock(() => {});

        expect(startDraftPreview(CONFIG, { wildDuckClient: client(''), serve, registerCleanup })).toBeUndefined();
        expect(registerCleanup).not.toHaveBeenCalled();
    });

    test('serves drafts until ttlHours after their date, by the clock', async () => {
        const fresh = fakeServe();
        startDraftPreview(CONFIG, { wildDuckClient: client(new Date(NOW - (2 * 3_600_000)).toISOString()), serve: fresh.serve, registerCleanup: () => {} });
        const stale = fakeServe();
        startDraftPreview(CONFIG, { wildDuckClient: client(new Date(NOW - (2 * 3_600_000) - 1).toISOString()), serve: stale.serve, registerCleanup: () => {} });
        const request = new Request(`http://127.0.0.1:8791/d/42/${TOKEN}`);

        const freshResponse = await optionsOf(fresh.serve).fetch(request);
        const staleResponse = await optionsOf(stale.serve).fetch(request);
        expect(freshResponse.status).toBe(200);
        expect(staleResponse.status).toBe(410);
    });

    test('enforces the configured login allowlist', async () => {
        const { serve } = fakeServe();
        startDraftPreview({ ...CONFIG, allowedLogins: ['craig@example.com'] }, { wildDuckClient: client(new Date(NOW).toISOString()), serve, registerCleanup: () => {} });

        const anonymous = await optionsOf(serve).fetch(new Request(`http://127.0.0.1:8791/d/42/${TOKEN}`));
        const allowed = await optionsOf(serve).fetch(new Request(`http://127.0.0.1:8791/d/42/${TOKEN}`, { headers: { 'Tailscale-User-Login': 'craig@example.com' } }));
        expect(anonymous.status).toBe(403);
        expect(allowed.status).toBe(200);
    });
});

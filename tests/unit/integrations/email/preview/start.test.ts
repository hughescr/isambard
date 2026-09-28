import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { mockLogger } from '../../../../setup';
import type { EmailPreviewConfig } from '@/config';
import { startDraftPreview, type PreviewServeOptions, type StartDraftPreviewDeps } from '@/integrations/email/preview';
import type { WildDuckMessage } from '@/integrations/email/wildduck-client';
import type { SpawnRunner } from '@/utils';

type SpawnResult = Awaited<ReturnType<SpawnRunner>>;

const TOKEN = 'A'.repeat(43);
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const DNS = 'mac.tailnet.ts.net';
const CLI = '/usr/local/bin/tailscale';
const SERVE = 'serve --bg --https=443 --set-path=/izzy-preview http://127.0.0.1:8787';
const UNSERVE = 'serve --https=443 --set-path=/izzy-preview off';
const DISABLED = 'Draft preview disabled; approval cards will carry no preview links';

const AUTO: EmailPreviewConfig = { mode: 'auto', port: 8787, ttlHours: 2 };
const MANUAL: EmailPreviewConfig = { mode: 'auto', port: 8791, publicBaseUrl: 'https://mac.tailnet.ts.net', ttlHours: 2 };

const STATUS = {
    BackendState: 'Running',
    Self:         { DNSName: `${DNS}.`, UserID: 7 },
    CertDomains:  [DNS],
    User:         { '7': { LoginName: 'Craig@Example.com' } },
};
const PUBLISHED = { Web: { [`${DNS}:443`]: { Handlers: { '/izzy-preview': { Proxy: 'http://127.0.0.1:8787' } } } } };

type Reply = Partial<SpawnResult> | Promise<Partial<SpawnResult>>;

function json(value: unknown): Reply {
    return { stdout: JSON.stringify(value) };
}

/** The usual auto-mode conversation: status, Funnel check, serve, serve check. */
/** Replies per command line (the arguments after the CLI path), consumed in order. */
type Script = Partial<Record<string, Reply[]>>;

function happyScript(): Script {
    return {
        'status --json':       [json(STATUS)],
        'serve status --json': [json(null), json(PUBLISHED)],
        [SERVE]:               [{}],
        [UNSERVE]:             [{}],
    };
}

interface Step { name: string, run: () => void | Promise<void> }

interface Harness {
    deps:     StartDraftPreviewDeps
    /** Commands run, servers bound and stopped, in order. */
    events:   string[]
    serve:    ReturnType<typeof mock<(options: PreviewServeOptions) => { stop: (close?: boolean) => Promise<void> }>>
    stop:     ReturnType<typeof mock<(close?: boolean) => Promise<void>>>
    cleanups: Step[]
}

function draftClient(date = new Date(NOW).toISOString()): StartDraftPreviewDeps['wildDuckClient'] {
    const draft: WildDuckMessage = { id: 42, draft: true, date, metaData: { previewToken: TOKEN } };
    return {
        getMessage:           mock(async () => draft),
        openAttachmentStream: mock(async () => null),
    };
}

function harness(script: Script = happyScript(), overrides: { which?: (command: string) => string | null, bindFails?: boolean, date?: string } = {}): Harness {
    const events: string[] = [];
    const cleanups: Step[] = [];
    const stop = mock(async (_close?: boolean): Promise<void> => {
        events.push('stop server');
    });
    const serve = mock((options: PreviewServeOptions) => {
        if(overrides.bindFails === true) {
            throw new Error('EADDRINUSE');
        }
        events.push(`bind ${options.hostname}:${options.port}`);
        return { stop };
    });
    const run = mock(async (cmd: string[], _options?: { timeout?: number }): Promise<SpawnResult> => {
        const line = cmd.slice(1).join(' ');
        events.push(line);
        const reply = await (script[line]?.shift() ?? { exitCode: 99, stderr: 'unscripted' });
        return { stdout: '', stderr: '', exitCode: 0, ...reply };
    });
    const tailscale: StartDraftPreviewDeps['tailscale'] = {
        run,
        which:      overrides.which ?? (() => CLI),
        fileExists: async () => false,
        timeoutMs:  5000,
    };
    const deps: StartDraftPreviewDeps = {
        wildDuckClient:  draftClient(overrides.date),
        serve,
        registerCleanup: (step) => {
            cleanups.push(step);
        },
        tailscale,
    };
    return { deps, events, serve, stop, cleanups };
}

function fetchVia(h: Harness, path: string, login?: string): Promise<Response> {
    const headers: Record<string, string> = login === undefined ? {} : { 'Tailscale-User-Login': login };
    return h.serve.mock.calls[0][0].fetch(new Request(`http://127.0.0.1:8787${path}`, { headers }));
}

async function statusVia(h: Harness, path: string, login?: string): Promise<number> {
    const response = await fetchVia(h, path, login);
    return response.status;
}

describe('startDraftPreview', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW));
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    describe('off', () => {
        test.each([
            ['without preview config', undefined],
            ['with EMAIL_PREVIEW=off', { ...AUTO, mode: 'off' as const }],
            ['with EMAIL_PREVIEW=off and a manual base URL', { ...MANUAL, mode: 'off' as const }],
        ])('starts nothing %s', (_label, config) => {
            const h = harness();

            expect(startDraftPreview(config, h.deps)).toBeUndefined();
            expect(h.events).toEqual([]);
            expect(h.cleanups).toEqual([]);
        });
    });

    describe('manual (EMAIL_PREVIEW_PUBLIC_BASE_URL set)', () => {
        test('starts the server without any Tailscale command and builds links under the base URL', async () => {
            const h = harness();

            const preview = startDraftPreview(MANUAL, h.deps);

            expect(preview?.urlFor(42, TOKEN)).toBe(`https://mac.tailnet.ts.net/d/42/${TOKEN}`);
            expect(await preview?.ready).toBe(true);
            expect(h.events).toEqual(['bind 127.0.0.1:8791']);
        });

        test('registers the server\'s shutdown', async () => {
            const h = harness();
            startDraftPreview(MANUAL, h.deps);

            expect(h.cleanups.map(step => step.name)).toEqual(['email preview server']);
            await h.cleanups[0].run();
            expect(h.events).toEqual(['bind 127.0.0.1:8791', 'stop server']);
        });

        test('offers no links when the server could not start', () => {
            const h = harness(happyScript(), { bindFails: true });

            expect(startDraftPreview(MANUAL, h.deps)).toBeUndefined();
            expect(h.cleanups).toEqual([]);
        });

        test('admits anyone with the link when no logins are configured', async () => {
            const h = harness();
            startDraftPreview(MANUAL, h.deps);

            expect(await statusVia(h, `/d/42/${TOKEN}`)).toBe(200);
        });

        test('enforces configured logins', async () => {
            const h = harness();
            startDraftPreview({ ...MANUAL, allowedLogins: ['craig@example.com'] }, h.deps);

            expect(await statusVia(h, `/d/42/${TOKEN}`)).toBe(403);
            expect(await statusVia(h, `/d/42/${TOKEN}`, 'craig@example.com')).toBe(200);
        });

        test('serves requests with or without the base URL\'s path', async () => {
            const h = harness();
            const preview = startDraftPreview({ ...MANUAL, publicBaseUrl: 'https://mac.tailnet.ts.net/preview' }, h.deps);

            expect(preview?.urlFor(42, TOKEN)).toBe(`https://mac.tailnet.ts.net/preview/d/42/${TOKEN}`);
            expect(await statusVia(h, `/preview/d/42/${TOKEN}`)).toBe(200);
            expect(await statusVia(h, `/d/42/${TOKEN}`)).toBe(200);
            expect(await statusVia(h, `/other/d/42/${TOKEN}`)).toBe(404);
        });

        test('serves drafts until ttlHours after their date, by the clock', async () => {
            const fresh = harness(happyScript(), { date: new Date(NOW - (2 * 3_600_000)).toISOString() });
            const stale = harness(happyScript(), { date: new Date(NOW - (2 * 3_600_000) - 1).toISOString() });
            startDraftPreview(MANUAL, fresh.deps);
            startDraftPreview(MANUAL, stale.deps);

            expect(await statusVia(fresh, `/d/42/${TOKEN}`)).toBe(200);
            expect(await statusVia(stale, `/d/42/${TOKEN}`)).toBe(410);
        });
    });

    describe('auto', () => {
        test('checks Tailscale, binds, then publishes /izzy-preview and links to it', async () => {
            const h = harness();

            const preview = startDraftPreview(AUTO, h.deps);
            expect(preview?.urlFor(42, TOKEN)).toBeUndefined();
            expect(await preview?.ready).toBe(true);

            expect(h.events).toEqual(['status --json', 'serve status --json', 'bind 127.0.0.1:8787', SERVE, 'serve status --json']);
            expect(preview?.urlFor(42, TOKEN)).toBe(`https://${DNS}/izzy-preview/d/42/${TOKEN}`);
            expect(mockLogger.info).toHaveBeenCalledWith({ publicBaseUrl: `https://${DNS}/izzy-preview`, msg: 'Draft preview published on the tailnet' });
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test('admits only the Mac owner\'s login by default, under the mount or not', async () => {
            const h = harness();
            await startDraftPreview(AUTO, h.deps)?.ready;

            expect(await statusVia(h, `/izzy-preview/d/42/${TOKEN}`, 'craig@example.com')).toBe(200);
            expect(await statusVia(h, `/d/42/${TOKEN}`, 'Craig@Example.com')).toBe(200);
            expect(await statusVia(h, `/d/42/${TOKEN}`, 'other@example.com')).toBe(403);
            expect(await statusVia(h, `/d/42/${TOKEN}`)).toBe(403);
        });

        test('lets configured logins replace the owner, even when Tailscale lists no owner', async () => {
            const script = { ...happyScript(), 'status --json': [json({ ...STATUS, User: null })] };
            const h = harness(script);
            expect(await startDraftPreview({ ...AUTO, allowedLogins: ['other@example.com'] }, h.deps)?.ready).toBe(true);

            expect(await statusVia(h, `/d/42/${TOKEN}`, 'other@example.com')).toBe(200);
            expect(await statusVia(h, `/d/42/${TOKEN}`, 'craig@example.com')).toBe(403);
        });

        test('removes only its own mount, then stops the server, at shutdown', async () => {
            const h = harness();
            await startDraftPreview(AUTO, h.deps)?.ready;

            expect(h.cleanups.map(step => step.name)).toEqual(['email preview server']);
            await h.cleanups[0].run();

            expect(h.events.slice(-2)).toEqual([UNSERVE, 'stop server']);
            expect(h.stop.mock.calls).toEqual([[true]]);
        });

        test('still stops the server when removing the mount fails, logging why', async () => {
            const h = harness({ ...happyScript(), [UNSERVE]: [{ exitCode: 1, stderr: 'handler does not exist' }] });
            await startDraftPreview(AUTO, h.deps)?.ready;

            await h.cleanups[0].run();

            expect(h.events.slice(-2)).toEqual([UNSERVE, 'stop server']);
            expect(mockLogger.warn).toHaveBeenCalledWith({
                error: `\`tailscale ${UNSERVE}\` failed (exit 1): handler does not exist`,
                msg:   'Could not remove the draft preview from tailscale serve; the next start replaces it',
            });
        });

        test('does nothing at shutdown when setup failed', async () => {
            const h = harness({ 'status --json': [{ exitCode: 1, stderr: 'down' }] });
            await startDraftPreview(AUTO, h.deps)?.ready;

            await h.cleanups[0].run();

            expect(h.events).toEqual(['status --json']);
        });

        test('neither binds nor publishes when shutdown starts during the Tailscale checks', async () => {
            const status = Promise.withResolvers<Partial<SpawnResult>>();
            const h = harness({ ...happyScript(), 'status --json': [status.promise] });
            const preview = startDraftPreview(AUTO, h.deps);

            const stopping = h.cleanups[0].run();
            status.resolve({ stdout: JSON.stringify(STATUS) });
            await stopping;

            expect(await preview?.ready).toBe(false);
            expect(h.events).toEqual(['status --json', 'serve status --json']);
            expect(preview?.urlFor(42, TOKEN)).toBeUndefined();
        });

        describe('disables the preview, logging one line, and keeps going', () => {
            test.each([
                ['Tailscale is not installed', {}, () => null, 'Tailscale CLI not found (no `tailscale` on PATH and no /Applications/Tailscale.app); install Tailscale', []],
                ['tailscale status fails', { 'status --json': [{ exitCode: 1, stderr: 'failed to connect' }] }, undefined, '`tailscale status --json` failed (exit 1): failed to connect', ['status --json']],
                ['HTTPS certificates are off', { 'status --json': [json({ ...STATUS, CertDomains: [] })] }, undefined, 'Tailscale HTTPS certificates are not enabled for this tailnet; turn on HTTPS Certificates in the Tailscale admin console (DNS page), then restart Izzy', ['status --json']],
                ['Tailscale lists no owner login', { 'status --json': [json({ ...STATUS, User: {} })] }, undefined, 'Tailscale lists no login for this Mac\'s owner; set EMAIL_PREVIEW_ALLOWED_LOGINS', ['status --json']],
                ['Funnel is on for the host', { 'status --json': [json(STATUS)], 'serve status --json': [json({ AllowFunnel: { [`${DNS}:443`]: true } })] }, undefined, `Tailscale Funnel is on for ${DNS}:443; refusing to publish draft previews where the internet can reach them`, ['status --json', 'serve status --json']],
            ])('when %s, before binding', async (_label, script, which, reason, events) => {
                const h = harness(script, { which });

                const preview = startDraftPreview(AUTO, h.deps);

                expect(await preview?.ready).toBe(false);
                expect(preview?.urlFor(42, TOKEN)).toBeUndefined();
                expect(h.events).toEqual(events);
                expect(mockLogger.warn.mock.calls).toEqual([[{ reason, msg: DISABLED }]]);
            });

            test('when tailscale serve fails, stopping the server it bound', async () => {
                const h = harness({ ...happyScript(), [SERVE]: [{ exitCode: 1, stderr: 'already serving TCP' }] });

                const preview = startDraftPreview(AUTO, h.deps);

                expect(await preview?.ready).toBe(false);
                expect(preview?.urlFor(42, TOKEN)).toBeUndefined();
                expect(h.events).toEqual(['status --json', 'serve status --json', 'bind 127.0.0.1:8787', SERVE, 'stop server']);
                expect(mockLogger.warn.mock.calls).toEqual([[{ reason: `\`tailscale ${SERVE}\` failed (exit 1): already serving TCP`, msg: DISABLED }]]);
            });

            test('when a command cannot even be spawned, logging a non-Error as a string', async () => {
                const h = harness();
                h.deps.tailscale.run = async () => {
                    throw 'spawn blew up';
                };

                expect(await startDraftPreview(AUTO, h.deps)?.ready).toBe(false);
                expect(mockLogger.warn.mock.calls).toEqual([[{ reason: 'spawn blew up', msg: DISABLED }]]);
            });

            test('when the port is taken, running no tailscale serve', async () => {
                const h = harness(happyScript(), { bindFails: true });

                const preview = startDraftPreview(AUTO, h.deps);

                expect(await preview?.ready).toBe(false);
                expect(h.events).toEqual(['status --json', 'serve status --json']);
                await h.cleanups[0].run();
                expect(h.events).toEqual(['status --json', 'serve status --json']);
            });
        });
    });
});

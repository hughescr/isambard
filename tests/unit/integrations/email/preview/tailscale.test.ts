import { describe, test, expect, mock } from 'bun:test';
import type { CommandResult } from '@/integrations/email/preview/bounded-runner';
import { MAC_APP_TAILSCALE_CLI, openTailscaleCli, previewMountPath, type TailscaleCli, type TailscaleDeps } from '@/integrations/email/preview/tailscale';

const CLI = '/opt/homebrew/bin/tailscale';
const DNS = 'mac.tailnet.ts.net';
const HOST = `${DNS}:443`;
const TARGET = 'http://127.0.0.1:8787';
const SERVE = `serve --bg --https=443 --set-path=/izzy-preview-8787 ${TARGET}`;
const UNSERVE = 'serve --https=443 --set-path=/izzy-preview-8787 off';

interface Reply { stdout?: string, stderr?: string, exitCode?: number }

/** Replies per command line (the arguments after the CLI path), consumed in order. */
type Script = Partial<Record<string, Reply[]>>;

function fakeRun(script: Script): ReturnType<typeof mock<(cmd: string[], options: { timeout: number }) => Promise<CommandResult>>> {
    return mock(async (cmd: string[], _options: { timeout: number }): Promise<CommandResult> => {
        const reply = script[cmd.slice(1).join(' ')]?.shift() ?? { exitCode: 99, stderr: 'unscripted command' };
        return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', exitCode: reply.exitCode ?? 0 };
    });
}

function deps(script: Script, overrides: Partial<TailscaleDeps> = {}): TailscaleDeps & { run: ReturnType<typeof fakeRun> } {
    return {
        run:        fakeRun(script),
        which:      mock((_command: string): string | null => CLI),
        fileExists: mock(async (_path: string) => false),
        timeoutMs:  5000,
        ...overrides,
    } as TailscaleDeps & { run: ReturnType<typeof fakeRun> };
}

const STATUS = {
    BackendState: 'Running',
    Self:         { DNSName: `${DNS}.`, UserID: 123 },
    CertDomains:  [DNS],
    User:         {
        '123': { ID: 123, LoginName: 'Craig@Example.com' },
        '456': { ID: 456, LoginName: 'other@example.com' },
    },
};

function json(value: unknown): Reply {
    return { stdout: `${JSON.stringify(value, null, 2)}\n` };
}

/** A serve config whose background session serves `handlers` on this host's port 443. */
function serving(handlers: Record<string, object>): object {
    return { Web: { [HOST]: { Handlers: handlers } } };
}

async function cli(script: Script, overrides: Partial<TailscaleDeps> = {}): Promise<{ tailscale: TailscaleCli, run: ReturnType<typeof fakeRun> }> {
    const d = deps(script, overrides);
    return { tailscale: await openTailscaleCli(d), run: d.run };
}

async function rejection(pending: Promise<unknown>): Promise<Error> {
    try {
        await pending;
    } catch (err: unknown) {
        return err as Error;
    }
    throw new Error('expected a rejection');
}

async function failure(pending: Promise<unknown>): Promise<string> {
    const error = await rejection(pending);
    return error.message;
}

describe('previewMountPath', () => {
    test('gives each preview port its own path', () => {
        expect(previewMountPath(8787)).toBe('/izzy-preview-8787');
        expect(previewMountPath(8788)).toBe('/izzy-preview-8788');
    });
});

describe('openTailscaleCli', () => {
    test('uses the tailscale on PATH', async () => {
        const d = deps({ 'status --json': [json(STATUS)] });
        const tailscale = await openTailscaleCli(d);

        await tailscale.readSelf();

        expect(d.which).toHaveBeenCalledWith('tailscale');
        expect(d.fileExists).not.toHaveBeenCalled();
        expect(d.run.mock.calls[0][0][0]).toBe(CLI);
    });

    test('falls back to the CLI inside the Mac app when none is on PATH', async () => {
        const d = deps({ 'status --json': [json(STATUS)] }, { which: () => null, fileExists: mock(async (path: string) => path === MAC_APP_TAILSCALE_CLI) });
        const tailscale = await openTailscaleCli(d);

        await tailscale.readSelf();

        expect(MAC_APP_TAILSCALE_CLI).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
        expect(d.run.mock.calls[0][0][0]).toBe(MAC_APP_TAILSCALE_CLI);
    });

    test('fails when Tailscale is not installed', async () => {
        const d = deps({}, { which: () => null });

        expect(await failure(openTailscaleCli(d))).toBe('Tailscale CLI not found (no `tailscale` on PATH and no /Applications/Tailscale.app); install Tailscale');
    });
});

describe('TailscaleCli.readSelf', () => {
    test('reads the Mac\'s MagicDNS name and its owner\'s login, with the per-command timeout', async () => {
        const { tailscale, run } = await cli({ 'status --json': [json(STATUS)] }, { timeoutMs: 1234 });

        expect(await tailscale.readSelf()).toEqual({ dnsName: DNS, login: 'craig@example.com' });
        expect(run.mock.calls).toEqual([[[CLI, 'status', '--json'], { timeout: 1234 }]]);
    });

    test('keeps a DNS name that has no trailing dot', async () => {
        const { tailscale } = await cli({ 'status --json': [json({ ...STATUS, Self: { DNSName: DNS, UserID: 123 } })] });

        expect(await tailscale.readSelf()).toEqual({ dnsName: DNS, login: 'craig@example.com' });
    });

    test.each([
        ['no entry for the owner', { '999': { LoginName: 'x@example.com' } }],
        ['no user map', null],
        ['an absent user map', undefined],
    ])('reports no login when Tailscale lists %s', async (_label, User) => {
        const { tailscale } = await cli({ 'status --json': [json({ ...STATUS, User })] });

        expect(await tailscale.readSelf()).toEqual({ dnsName: DNS, login: undefined });
    });

    test('reports a failing command with its exit code and its stderr on one line', async () => {
        const { tailscale } = await cli({ 'status --json': [{ exitCode: 1, stderr: 'failed to connect to local tailscaled\n\n  is it running?\n' }] });

        expect(await failure(tailscale.readSelf())).toBe('`tailscale status --json` failed (exit 1): failed to connect to local tailscaled is it running?');
    });

    test.each([
        ['an Error', new Error('timed out after 5000 ms and was killed'), 'timed out after 5000 ms and was killed'],
        ['a non-Error', 'spawn blew up', 'spawn blew up'],
    ])('names the command when it cannot run to completion (%s), keeping the cause', async (_label, thrown, reason) => {
        const { tailscale } = await cli({}, {
            run: async () => {
                throw thrown;
            },
        });

        const error = await rejection(tailscale.readSelf());
        expect(error.message).toBe(`\`tailscale status --json\` did not finish: ${reason}`);
        expect(error.cause).toBe(thrown);
    });

    test('refuses output that is not JSON', async () => {
        const { tailscale } = await cli({ 'status --json': [{ stdout: 'Logged out.' }] });

        expect(await failure(tailscale.readSelf())).toBe('`tailscale status --json` printed output that is not JSON');
    });

    test.each([
        ['JSON in another shape', json({ Self: STATUS.Self })],
        ['null', json(null)],
    ])('refuses %s', async (_label, reply) => {
        const { tailscale } = await cli({ 'status --json': [reply] });

        expect(await failure(tailscale.readSelf())).toBe('`tailscale status --json` printed JSON of an unexpected shape');
    });

    test('fails unless Tailscale is running', async () => {
        const { tailscale } = await cli({ 'status --json': [json({ ...STATUS, BackendState: 'NeedsLogin' })] });

        expect(await failure(tailscale.readSelf())).toBe('Tailscale is not connected on this Mac (state NeedsLogin); open Tailscale and sign in');
    });

    test.each([
        ['no self node', null],
        ['an empty DNS name', { DNSName: '', UserID: 123 }],
    ])('fails without a MagicDNS name: %s', async (_label, Self) => {
        const { tailscale } = await cli({ 'status --json': [json({ ...STATUS, Self })] });

        expect(await failure(tailscale.readSelf())).toBe('Tailscale reports no MagicDNS name for this Mac; turn on MagicDNS in the Tailscale admin console (DNS page)');
    });

    test.each([
        ['none', []],
        ['null', null],
        ['absent', undefined],
    ])('fails without HTTPS certificates (%s)', async (_label, CertDomains) => {
        const { tailscale } = await cli({ 'status --json': [json({ ...STATUS, CertDomains })] });

        expect(await failure(tailscale.readSelf())).toBe('Tailscale HTTPS certificates are not enabled for this tailnet; turn on HTTPS Certificates in the Tailscale admin console (DNS page), then restart Izzy');
    });
});

describe('TailscaleCli.preflight', () => {
    const funnelOn = { AllowFunnel: { [HOST]: true } };

    test.each([
        ['no serve config', null],
        ['a config without Funnel', { Web: {} }],
        ['Funnel on another port', { AllowFunnel: { [`${DNS}:8443`]: true } }],
        ['Funnel on another host', { AllowFunnel: { 'other.tailnet.ts.net:443': true } }],
        ['Funnel recorded as off', { AllowFunnel: { [HOST]: false } }],
        ['a foreground session without Funnel', { Foreground: { abc: { Web: {} } } }],
        ['other paths served on the host', serving({ '/': { Proxy: 'http://127.0.0.1:3000' }, '/izzy-preview': { Proxy: 'http://127.0.0.1:9000' } })],
        ['another instance\'s preview mount', serving({ '/izzy-preview-8788': { Proxy: 'http://127.0.0.1:8788' } })],
        ['our own mount left over from a crash', serving({ '/izzy-preview-8787': { Proxy: TARGET } })],
        ['our own mount, with a trailing slash', serving({ '/izzy-preview-8787/': { Proxy: TARGET } })],
        ['our mount path taken on another port', { Web: { [`${DNS}:8443`]: { Handlers: { '/izzy-preview-8787': { Proxy: 'http://127.0.0.1:3000' } } } } }],
        ['a web config for the host without handlers', { Web: { [HOST]: {} } }],
    ])('passes with %s', async (_label, config) => {
        const { tailscale, run } = await cli({ 'serve status --json': [json(config)] }, { timeoutMs: 777 });

        expect(await tailscale.preflight(DNS, 8787)).toBeUndefined();
        expect(run.mock.calls).toEqual([[[CLI, 'serve', 'status', '--json'], { timeout: 777 }]]);
    });

    test.each([
        ['in the background config', funnelOn],
        ['in a foreground session', { Foreground: { abc: {}, def: funnelOn } }],
    ])('refuses when Funnel is on for this host\'s port 443 %s', async (_label, config) => {
        const { tailscale } = await cli({ 'serve status --json': [json(config)] });

        expect(await failure(tailscale.preflight(DNS, 8787))).toBe(`Tailscale Funnel is on for ${HOST}; refusing to publish draft previews where the internet can reach them`);
    });

    test.each([
        ['a proxy elsewhere at the mount path', serving({ '/izzy-preview-8787': { Proxy: 'http://127.0.0.1:3000' } }), '/izzy-preview-8787', 'http://127.0.0.1:3000'],
        ['a proxy elsewhere at the mount path with a trailing slash', serving({ '/izzy-preview-8787/': { Proxy: 'http://127.0.0.1:3000' } }), '/izzy-preview-8787/', 'http://127.0.0.1:3000'],
        ['a handler that is not a proxy', serving({ '/izzy-preview-8787': { Path: '/Users/craig/www' } }), '/izzy-preview-8787', 'a handler that is not a proxy'],
        ['a foreground session\'s handler', { Foreground: { abc: serving({ '/izzy-preview-8787': { Proxy: 'http://127.0.0.1:3000' } }) } }, '/izzy-preview-8787', 'http://127.0.0.1:3000'],
    ])('refuses to replace %s', async (_label, config, path, holder) => {
        const { tailscale } = await cli({ 'serve status --json': [json(config)] });

        expect(await failure(tailscale.preflight(DNS, 8787))).toBe(`https://${HOST}${path} is already served by ${holder}, not this Izzy (${TARGET}); refusing to replace it: remove that mount or set EMAIL_PREVIEW_PORT to another port`);
    });

    test('fails when serve status fails', async () => {
        const { tailscale } = await cli({ 'serve status --json': [{ exitCode: 1, stderr: 'boom' }] });

        expect(await failure(tailscale.preflight(DNS, 8787))).toBe('`tailscale serve status --json` failed (exit 1): boom');
    });

    test.each([
        ['output that is not JSON', { stdout: '' }, 'printed output that is not JSON'],
        ['JSON of an unexpected shape', json({ AllowFunnel: 'yes' }), 'printed JSON of an unexpected shape'],
    ])('refuses serve status %s', async (_label, reply, problem) => {
        const { tailscale } = await cli({ 'serve status --json': [reply] });

        expect(await failure(tailscale.preflight(DNS, 8787))).toBe(`\`tailscale serve status --json\` ${problem}`);
    });
});

describe('TailscaleCli.serve', () => {
    test('publishes only this port\'s preview path on the HTTPS port, in the background', async () => {
        const { tailscale, run } = await cli({ [SERVE]: [{}] }, { timeoutMs: 42 });

        expect(await tailscale.serve(8787)).toBeUndefined();
        expect(run.mock.calls).toEqual([[[CLI, 'serve', '--bg', '--https=443', '--set-path=/izzy-preview-8787', TARGET], { timeout: 42 }]]);
    });

    test('fails when the command fails', async () => {
        const { tailscale } = await cli({ [SERVE]: [{ exitCode: 1, stderr: 'error: cannot serve web; already serving TCP' }] });

        expect(await failure(tailscale.serve(8787))).toBe(`\`tailscale ${SERVE}\` failed (exit 1): error: cannot serve web; already serving TCP`);
    });
});

describe('TailscaleCli.verify', () => {
    test('passes when serve status shows this port\'s mount proxying to it', async () => {
        const { tailscale, run } = await cli({ 'serve status --json': [json(serving({ '/': { Proxy: 'http://127.0.0.1:3000' }, '/izzy-preview-8787': { Proxy: TARGET } }))] }, { timeoutMs: 42 });

        expect(await tailscale.verify(DNS, 8787)).toBeUndefined();
        expect(run.mock.calls).toEqual([[[CLI, 'serve', 'status', '--json'], { timeout: 42 }]]);
    });

    test.each([
        ['no serve config', null],
        ['no web config for the host', { Web: {} }],
        ['no handlers', { Web: { [HOST]: {} } }],
        ['no preview handler', serving({ '/': { Proxy: TARGET } })],
        ['only another port\'s preview handler', serving({ '/izzy-preview-8788': { Proxy: TARGET } })],
        ['the handler on another HTTPS port', { Web: { [`${DNS}:8443`]: { Handlers: { '/izzy-preview-8787': { Proxy: TARGET } } } } }],
        ['the handler proxying elsewhere', serving({ '/izzy-preview-8787': { Proxy: 'http://127.0.0.1:8788' } })],
    ])('fails when serve status shows %s', async (_label, config) => {
        const { tailscale } = await cli({ 'serve status --json': [json(config)] });

        expect(await failure(tailscale.verify(DNS, 8787))).toBe(`\`tailscale serve\` did not publish /izzy-preview-8787 → ${TARGET}; check \`tailscale serve status\``);
    });
});

describe('TailscaleCli.unmount', () => {
    test('removes only this port\'s preview path from the HTTPS port', async () => {
        const { tailscale, run } = await cli({ [UNSERVE]: [{}] }, { timeoutMs: 9 });

        expect(await tailscale.unmount(8787)).toBeUndefined();
        expect(run.mock.calls).toEqual([[[CLI, 'serve', '--https=443', '--set-path=/izzy-preview-8787', 'off'], { timeout: 9 }]]);
    });

    test('fails when the command fails', async () => {
        const { tailscale } = await cli({ [UNSERVE]: [{ exitCode: 1, stderr: 'error: failed to remove web serve: handler does not exist' }] });

        expect(await failure(tailscale.unmount(8787))).toBe(`\`tailscale ${UNSERVE}\` failed (exit 1): error: failed to remove web serve: handler does not exist`);
    });
});

describe('TailscaleCli.unmountIfOurs', () => {
    test('removes the mount while it still proxies to this port', async () => {
        const { tailscale, run } = await cli({ 'serve status --json': [json(serving({ '/izzy-preview-8787': { Proxy: TARGET } }))], [UNSERVE]: [{}] }, { timeoutMs: 9 });

        expect(await tailscale.unmountIfOurs(DNS, 8787)).toBe(true);
        expect(run.mock.calls).toEqual([
            [[CLI, 'serve', 'status', '--json'], { timeout: 9 }],
            [[CLI, 'serve', '--https=443', '--set-path=/izzy-preview-8787', 'off'], { timeout: 9 }],
        ]);
    });

    test.each([
        ['it is gone', null],
        ['someone replaced it', serving({ '/izzy-preview-8787': { Proxy: 'http://127.0.0.1:3000' } })],
    ])('leaves the mount alone when %s', async (_label, config) => {
        const { tailscale, run } = await cli({ 'serve status --json': [json(config)] });

        expect(await tailscale.unmountIfOurs(DNS, 8787)).toBe(false);
        expect(run).toHaveBeenCalledTimes(1);
    });

    test('fails when serve status fails, removing nothing', async () => {
        const { tailscale, run } = await cli({ 'serve status --json': [{ exitCode: 1, stderr: 'boom' }] });

        expect(await failure(tailscale.unmountIfOurs(DNS, 8787))).toBe('`tailscale serve status --json` failed (exit 1): boom');
        expect(run).toHaveBeenCalledTimes(1);
    });
});

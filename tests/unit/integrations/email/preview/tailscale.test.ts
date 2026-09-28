import { describe, test, expect, mock } from 'bun:test';
import { MAC_APP_TAILSCALE_CLI, PREVIEW_MOUNT_PATH, openTailscaleCli, type TailscaleCli, type TailscaleDeps } from '@/integrations/email/preview/tailscale';
import type { SpawnRunner } from '@/utils';

type SpawnResult = Awaited<ReturnType<SpawnRunner>>;

const CLI = '/opt/homebrew/bin/tailscale';
const DNS = 'mac.tailnet.ts.net';
const TARGET = 'http://127.0.0.1:8787';
const SERVE = `serve --bg --https=443 --set-path=/izzy-preview ${TARGET}`;

interface Reply { stdout?: string, stderr?: string, exitCode?: number }

/** Replies per command line (the arguments after the CLI path), consumed in order. */
type Script = Partial<Record<string, Reply[]>>;

function fakeRun(script: Script): ReturnType<typeof mock<(cmd: string[], options?: { timeout?: number }) => Promise<SpawnResult>>> {
    return mock(async (cmd: string[], _options?: { timeout?: number }): Promise<SpawnResult> => {
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

async function cli(script: Script, overrides: Partial<TailscaleDeps> = {}): Promise<{ tailscale: TailscaleCli, run: ReturnType<typeof fakeRun> }> {
    const d = deps(script, overrides);
    return { tailscale: await openTailscaleCli(d), run: d.run };
}

async function failure(pending: Promise<unknown>): Promise<string> {
    try {
        await pending;
    } catch (err: unknown) {
        return (err as Error).message;
    }
    throw new Error('expected a rejection');
}

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

describe('TailscaleCli.assertNoFunnel', () => {
    const funnelOn = { AllowFunnel: { [`${DNS}:443`]: true } };

    test.each([
        ['no serve config', null],
        ['a config without Funnel', { Web: {} }],
        ['Funnel on another port', { AllowFunnel: { [`${DNS}:8443`]: true } }],
        ['Funnel on another host', { AllowFunnel: { 'other.tailnet.ts.net:443': true } }],
        ['Funnel recorded as off', { AllowFunnel: { [`${DNS}:443`]: false } }],
        ['a foreground session without Funnel', { Foreground: { abc: { Web: {} } } }],
    ])('passes with %s', async (_label, config) => {
        const { tailscale, run } = await cli({ 'serve status --json': [json(config)] }, { timeoutMs: 777 });

        expect(await tailscale.assertNoFunnel(DNS)).toBeUndefined();
        expect(run.mock.calls).toEqual([[[CLI, 'serve', 'status', '--json'], { timeout: 777 }]]);
    });

    test.each([
        ['in the background config', funnelOn],
        ['in a foreground session', { Foreground: { abc: {}, def: funnelOn } }],
    ])('refuses when Funnel is on for this host\'s port 443 %s', async (_label, config) => {
        const { tailscale } = await cli({ 'serve status --json': [json(config)] });

        expect(await failure(tailscale.assertNoFunnel(DNS))).toBe(`Tailscale Funnel is on for ${DNS}:443; refusing to publish draft previews where the internet can reach them`);
    });

    test('fails when serve status fails', async () => {
        const { tailscale } = await cli({ 'serve status --json': [{ exitCode: 1, stderr: 'boom' }] });

        expect(await failure(tailscale.assertNoFunnel(DNS))).toBe('`tailscale serve status --json` failed (exit 1): boom');
    });

    test.each([
        ['output that is not JSON', { stdout: '' }, 'printed output that is not JSON'],
        ['JSON of an unexpected shape', json({ AllowFunnel: 'yes' }), 'printed JSON of an unexpected shape'],
    ])('refuses serve status %s', async (_label, reply, problem) => {
        const { tailscale } = await cli({ 'serve status --json': [reply] });

        expect(await failure(tailscale.assertNoFunnel(DNS))).toBe(`\`tailscale serve status --json\` ${problem}`);
    });
});

describe('TailscaleCli.mount', () => {
    const published = { Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' }, '/izzy-preview': { Proxy: TARGET } } } } };

    test('publishes only the preview path on this host\'s HTTPS port, in the background, then checks it', async () => {
        const { tailscale, run } = await cli({ [SERVE]: [{}], 'serve status --json': [json(published)] }, { timeoutMs: 42 });

        expect(await tailscale.mount(DNS, 8787)).toBeUndefined();
        expect(PREVIEW_MOUNT_PATH).toBe('/izzy-preview');
        expect(run.mock.calls).toEqual([
            [[CLI, 'serve', '--bg', '--https=443', '--set-path=/izzy-preview', TARGET], { timeout: 42 }],
            [[CLI, 'serve', 'status', '--json'], { timeout: 42 }],
        ]);
    });

    test('fails when the serve command fails, without checking', async () => {
        const { tailscale, run } = await cli({ [SERVE]: [{ exitCode: 1, stderr: 'error: cannot serve web; already serving TCP' }] });

        expect(await failure(tailscale.mount(DNS, 8787))).toBe(`\`tailscale ${SERVE}\` failed (exit 1): error: cannot serve web; already serving TCP`);
        expect(run).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['no serve config', null],
        ['no web config for the host', { Web: {} }],
        ['no handlers', { Web: { [`${DNS}:443`]: {} } }],
        ['no preview handler', { Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: TARGET } } } } }],
        ['the handler on another port', { Web: { [`${DNS}:8443`]: { Handlers: { '/izzy-preview': { Proxy: TARGET } } } } }],
        ['the handler proxying elsewhere', { Web: { [`${DNS}:443`]: { Handlers: { '/izzy-preview': { Proxy: 'http://127.0.0.1:8788' } } } } }],
    ])('fails when the command exits cleanly but serve status shows %s', async (_label, config) => {
        const { tailscale } = await cli({ [SERVE]: [{}], 'serve status --json': [json(config)] });

        expect(await failure(tailscale.mount(DNS, 8787))).toBe(`\`tailscale serve\` did not publish /izzy-preview → ${TARGET}; check \`tailscale serve status\``);
    });
});

describe('TailscaleCli.unmount', () => {
    test('removes only the preview path from this host\'s HTTPS port', async () => {
        const { tailscale, run } = await cli({ 'serve --https=443 --set-path=/izzy-preview off': [{}] }, { timeoutMs: 9 });

        expect(await tailscale.unmount()).toBeUndefined();
        expect(run.mock.calls).toEqual([[[CLI, 'serve', '--https=443', '--set-path=/izzy-preview', 'off'], { timeout: 9 }]]);
    });

    test('fails when the command fails', async () => {
        const { tailscale } = await cli({ 'serve --https=443 --set-path=/izzy-preview off': [{ exitCode: 1, stderr: 'error: failed to remove web serve: handler does not exist' }] });

        expect(await failure(tailscale.unmount())).toBe('`tailscale serve --https=443 --set-path=/izzy-preview off` failed (exit 1): error: failed to remove web serve: handler does not exist');
    });
});

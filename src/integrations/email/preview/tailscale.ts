import { z } from 'zod';
import type { SpawnRunner } from '@/utils';

/**
 * The only path Isambard publishes on the Mac's tailnet host. `tailscale serve` strips it before
 * proxying (tailscale/tailscale ipn/ipnlocal/serve.go, "Trim the mount point from the URL path
 * before proxying"), and the handler accepts it either way.
 */
export const PREVIEW_MOUNT_PATH = '/izzy-preview';

/** Where the Mac app keeps its CLI when no `tailscale` is on PATH (tailscale.com/kb/1080/cli). */
export const MAC_APP_TAILSCALE_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/** The time limit production gives each Tailscale CLI command. */
export const TAILSCALE_COMMAND_TIMEOUT_MS = 5000;

/** `tailscale serve` publishes on the host's HTTPS port; Funnel is checked on the same port. */
const HTTPS_PORT = 443;

export interface TailscaleDeps {
    /** Runs one CLI command, killing it after `timeout` ms; `createSpawnRunner()` in production. */
    run:        SpawnRunner
    /** `Bun.which` in production. */
    which:      (command: string) => string | null
    fileExists: (path: string) => Promise<boolean>
    /** The time limit for each CLI command. */
    timeoutMs:  number
}

export interface TailnetSelf {
    /** The Mac's MagicDNS name, without the trailing dot. */
    dnsName: string
    /** The Mac owner's Tailscale login, lower-cased, when Tailscale lists one. */
    login:   string | undefined
}

/** The Tailscale commands the draft preview runs. Each rejects with a one-line reason. */
export interface TailscaleCli {
    /** Checks that Tailscale is connected with MagicDNS and HTTPS certificates. */
    readSelf(): Promise<TailnetSelf>
    /** Rejects when Funnel exposes this host's HTTPS port to the internet. */
    assertNoFunnel(dnsName: string): Promise<void>
    /** Publishes `PREVIEW_MOUNT_PATH` → 127.0.0.1:`port` on this host's HTTPS port, then checks it. */
    mount(dnsName: string, port: number): Promise<void>
    /** Removes `PREVIEW_MOUNT_PATH`, and nothing else, from this host's HTTPS port. */
    unmount(): Promise<void>
}

/** The `tailscale status --json` fields used (ipn/ipnstate.Status). */
const statusSchema = z.object({
    BackendState: z.string(),
    Self:         z.object({ DNSName: z.string(), UserID: z.number() }).nullish(),
    CertDomains:  z.array(z.string()).nullish(),
    User:         z.record(z.string(), z.object({ LoginName: z.string() })).nullish(),
});

const allowFunnelSchema = z.record(z.string(), z.boolean()).nullish();

const handlersSchema = z.record(z.string(), z.object({ Proxy: z.string().optional() })).nullish();

/** The `tailscale serve status --json` fields used (ipn.ServeConfig; `null` when nothing is served). */
const serveConfigSchema = z.object({
    AllowFunnel: allowFunnelSchema,
    Web:         z.record(z.string(), z.object({ Handlers: handlersSchema })).nullish(),
    Foreground:  z.record(z.string(), z.object({ AllowFunnel: allowFunnelSchema })).nullish(),
}).nullable();

/** A command line as log text, e.g. "`tailscale serve status --json`". */
function commandText(args: readonly string[]): string {
    return `\`tailscale ${args.join(' ')}\``;
}

/**
 * The Tailscale CLI: `tailscale` on PATH, else the one inside the Mac app. Rejects when Tailscale
 * is not installed.
 */
export async function openTailscaleCli(deps: TailscaleDeps): Promise<TailscaleCli> {
    const found = deps.which('tailscale') ?? (await deps.fileExists(MAC_APP_TAILSCALE_CLI) ? MAC_APP_TAILSCALE_CLI : undefined);
    if(found === undefined) {
        throw new Error('Tailscale CLI not found (no `tailscale` on PATH and no /Applications/Tailscale.app); install Tailscale');
    }
    const cli = found;

    async function exec(args: string[]): Promise<string> {
        const { stdout, stderr, exitCode } = await deps.run([cli, ...args], { timeout: deps.timeoutMs });
        if(exitCode !== 0) {
            throw new Error(`${commandText(args)} failed (exit ${exitCode}): ${stderr.trim().replaceAll(/\s+/gu, ' ')}`);
        }
        return stdout;
    }

    async function query<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
        const stdout = await exec(args);
        let json: unknown;
        try {
            json = JSON.parse(stdout);
        } catch{
            throw new Error(`${commandText(args)} printed output that is not JSON`);
        }
        const parsed = schema.safeParse(json);
        if(!parsed.success) {
            throw new Error(`${commandText(args)} printed JSON of an unexpected shape`);
        }
        return parsed.data;
    }

    const serveStatus = async (): Promise<z.infer<typeof serveConfigSchema>> => query(['serve', 'status', '--json'], serveConfigSchema);
    const pathFlags = [`--https=${HTTPS_PORT}`, `--set-path=${PREVIEW_MOUNT_PATH}`];

    return {
        async readSelf() {
            const status = await query(['status', '--json'], statusSchema);
            if(status.BackendState !== 'Running') {
                throw new Error(`Tailscale is not connected on this Mac (state ${status.BackendState}); open Tailscale and sign in`);
            }
            const self = status.Self;
            if(!self?.DNSName) {
                throw new Error('Tailscale reports no MagicDNS name for this Mac; turn on MagicDNS in the Tailscale admin console (DNS page)');
            }
            if(!status.CertDomains?.length) {
                throw new Error('Tailscale HTTPS certificates are not enabled for this tailnet; turn on HTTPS Certificates in the Tailscale admin console (DNS page), then restart Izzy');
            }
            return {
                dnsName: self.DNSName.replace(/\.$/u, ''),
                login:   status.User?.[String(self.UserID)]?.LoginName.toLowerCase(),
            };
        },

        async assertNoFunnel(dnsName) {
            const config = await serveStatus();
            const hostPort = `${dnsName}:${HTTPS_PORT}`;
            const sessions = [config, ...Object.values(config?.Foreground ?? {})];
            if(sessions.some(session => session?.AllowFunnel?.[hostPort] === true)) {
                throw new Error(`Tailscale Funnel is on for ${hostPort}; refusing to publish draft previews where the internet can reach them`);
            }
        },

        async mount(dnsName, port) {
            const target = `http://127.0.0.1:${port}`;
            await exec(['serve', '--bg', ...pathFlags, target]);
            const config = await serveStatus();
            // `serve` can exit 0 without changing anything (e.g. when HTTPS still needs enabling),
            // so the mount only counts once serve status shows it.
            if(config?.Web?.[`${dnsName}:${HTTPS_PORT}`]?.Handlers?.[PREVIEW_MOUNT_PATH]?.Proxy !== target) {
                throw new Error(`\`tailscale serve\` did not publish ${PREVIEW_MOUNT_PATH} → ${target}; check \`tailscale serve status\``);
            }
        },

        async unmount() {
            await exec(['serve', ...pathFlags, 'off']);
        },
    };
}

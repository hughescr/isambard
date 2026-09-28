import { z } from 'zod';
import type { BoundedRunner } from './bounded-runner';

/**
 * The only path an Isambard instance publishes on the Mac's tailnet host: one per preview port,
 * so a deployed Izzy and a dev checkout on the same Mac never share a mount. `tailscale serve`
 * strips it before proxying (tailscale/tailscale ipn/ipnlocal/serve.go, "Trim the mount point from
 * the URL path before proxying"), and the handler accepts it either way.
 */
export function previewMountPath(port: number): string {
    return `/izzy-preview-${port}`;
}

/** Where the Mac app keeps its CLI when no `tailscale` is on PATH (tailscale.com/kb/1080/cli). */
export const MAC_APP_TAILSCALE_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/** The time limit production gives each Tailscale CLI command. */
export const TAILSCALE_COMMAND_TIMEOUT_MS = 5000;

/** `tailscale serve` publishes on the host's HTTPS port; Funnel is checked on the same port. */
const HTTPS_PORT = 443;

export interface TailscaleDeps {
    /** Runs one CLI command under a hard deadline; `createBoundedRunner()` in production. */
    run:        BoundedRunner
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

/**
 * The Tailscale commands the draft preview runs, each for the mount of one preview `port`
 * (`previewMountPath(port)` → `http://127.0.0.1:<port>` on this host's HTTPS port). Each rejects
 * with a one-line reason.
 */
export interface TailscaleCli {
    /** Checks that Tailscale is connected with MagicDNS and HTTPS certificates. */
    readSelf(): Promise<TailnetSelf>
    /**
     * One read of the serve config. Rejects when Funnel exposes this host's HTTPS port to the
     * internet, or when a handler that is not this port's own proxy holds the mount path (with or
     * without a trailing slash). Our own leftover mount, from a crash, passes.
     */
    preflight(dnsName: string, port: number): Promise<void>
    /** Publishes the mount with `tailscale serve --bg`; rejects when the command fails. */
    serve(port: number): Promise<void>
    /** Rejects unless serve status shows the mount proxying to this port. */
    verify(dnsName: string, port: number): Promise<void>
    /** Removes the mount path, and nothing else, whatever it points at. */
    unmount(port: number): Promise<void>
    /** Removes the mount only while serve status shows it still proxying to this port; resolves whether it did. */
    unmountIfOurs(dnsName: string, port: number): Promise<boolean>
}

/** The `tailscale status --json` fields used (ipn/ipnstate.Status). */
const statusSchema = z.object({
    BackendState: z.string(),
    Self:         z.object({ DNSName: z.string(), UserID: z.number() }).nullish(),
    CertDomains:  z.array(z.string()).nullish(),
    User:         z.record(z.string(), z.object({ LoginName: z.string() })).nullish(),
});

/** The serve settings used from one session (ipn.ServeConfig), background or foreground. */
const serveSessionSchema = z.object({
    AllowFunnel: z.record(z.string(), z.boolean()).nullish(),
    Web:         z.record(z.string(), z.object({
        Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })).nullish(),
    })).nullish(),
});

type ServeSession = z.infer<typeof serveSessionSchema>;

/** `tailscale serve status --json` (`null` when nothing is served). */
const serveConfigSchema = serveSessionSchema.extend({
    Foreground: z.record(z.string(), serveSessionSchema).nullish(),
}).nullable();

/** A command line as log text, e.g. "`tailscale serve status --json`". */
function commandText(args: readonly string[]): string {
    return `\`tailscale ${args.join(' ')}\``;
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function targetFor(port: number): string {
    return `http://127.0.0.1:${port}`;
}

/** The `tailscale serve` flags that address this port's mount path on the HTTPS port. */
function pathFlags(port: number): string[] {
    return [`--https=${HTTPS_PORT}`, `--set-path=${previewMountPath(port)}`];
}

/** How serve config keys this host's HTTPS port, e.g. `mac.tailnet.ts.net:443`. */
function hostPortOf(dnsName: string): string {
    return `${dnsName}:${HTTPS_PORT}`;
}

function handlerAt(session: ServeSession | null, hostPort: string, path: string): { Proxy?: string } | undefined {
    return session?.Web?.[hostPort]?.Handlers?.[path];
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
        let result: Awaited<ReturnType<BoundedRunner>>;
        try {
            result = await deps.run([cli, ...args], { timeout: deps.timeoutMs });
        } catch (err: unknown) {
            throw new Error(`${commandText(args)} did not finish: ${errorText(err)}`, { cause: err });
        }
        if(result.exitCode !== 0) {
            throw new Error(`${commandText(args)} failed (exit ${result.exitCode}): ${result.stderr.trim().replaceAll(/\s+/gu, ' ')}`);
        }
        return result.stdout;
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

    /** Whether the background serve config has this port's mount proxying to it. */
    async function mountedHere(dnsName: string, port: number): Promise<boolean> {
        return handlerAt(await serveStatus(), hostPortOf(dnsName), previewMountPath(port))?.Proxy === targetFor(port);
    }

    async function unmount(port: number): Promise<void> {
        await exec(['serve', ...pathFlags(port), 'off']);
    }

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

        async preflight(dnsName, port) {
            const config = await serveStatus();
            const hostPort = hostPortOf(dnsName);
            const sessions = [config, ...Object.values(config?.Foreground ?? {})];
            if(sessions.some(session => session?.AllowFunnel?.[hostPort] === true)) {
                throw new Error(`Tailscale Funnel is on for ${hostPort}; refusing to publish draft previews where the internet can reach them`);
            }
            const target = targetFor(port);
            const mountPath = previewMountPath(port);
            for(const path of [mountPath, `${mountPath}/`]) {
                const foreign = sessions.map(session => handlerAt(session, hostPort, path)).find(handler => handler !== undefined && handler.Proxy !== target);
                if(foreign !== undefined) {
                    throw new Error(`https://${hostPort}${path} is already served by ${foreign.Proxy ?? 'a handler that is not a proxy'}, not this Izzy (${target}); refusing to replace it: remove that mount or set EMAIL_PREVIEW_PORT to another port`);
                }
            }
        },

        async serve(port) {
            await exec(['serve', '--bg', ...pathFlags(port), targetFor(port)]);
        },

        async verify(dnsName, port) {
            // `serve` can exit 0 without changing anything (e.g. when HTTPS still needs enabling),
            // so the mount only counts once serve status shows it.
            if(!await mountedHere(dnsName, port)) {
                throw new Error(`\`tailscale serve\` did not publish ${previewMountPath(port)} → ${targetFor(port)}; check \`tailscale serve status\``);
            }
        },

        unmount,

        async unmountIfOurs(dnsName, port) {
            if(!await mountedHere(dnsName, port)) {
                return false;
            }
            await unmount(port);
            return true;
        },
    };
}

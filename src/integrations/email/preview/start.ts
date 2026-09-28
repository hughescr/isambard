import { logger } from '@hughescr/logger';
import type { WildDuckClient } from '../wildduck-client';
import { createDraftPreviewHandler } from './handler';
import { startDraftPreviewServer, type PreviewServe, type PreviewServer } from './server';
import { openTailscaleCli, previewMountPath, type TailscaleCli, type TailscaleDeps } from './tailscale';
import type { EmailPreviewConfig } from '@/config';

const HOUR_MS = 3_600_000;

/** A draft's preview URL, or undefined while the preview is not published. */
export type PreviewUrlFor = (uid: number, token: string) => string | undefined;

export interface DraftPreview {
    urlFor: PreviewUrlFor
    /** Whether the preview was published; settles once setup has finished and never rejects. */
    ready:  Promise<boolean>
}

export interface StartDraftPreviewDeps {
    wildDuckClient:  Pick<WildDuckClient, 'getMessage' | 'openAttachmentStream'>
    /** `Bun.serve` in production. */
    serve:           PreviewServe
    registerCleanup: (step: { name: string, run: () => void | Promise<void> }) => void
    /** How auto mode runs the Tailscale CLI. */
    tailscale:       TailscaleDeps
}

const CLEANUP_NAME = 'email preview server';

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function startServer(config: EmailPreviewConfig, deps: StartDraftPreviewDeps, allowedLogins: readonly string[] | undefined, mountPath: string): PreviewServer | undefined {
    const handler = createDraftPreviewHandler({
        wildDuckClient: deps.wildDuckClient,
        ttlMs:          config.ttlHours * HOUR_MS,
        allowedLogins,
        mountPath,
        now:            () => Date.now(),
    });
    return startDraftPreviewServer(config.port, handler, deps.serve);
}

/** Manual mode: the admin publishes the server with their own `tailscale serve`. */
function startManual(config: EmailPreviewConfig, publicBaseUrl: string, deps: StartDraftPreviewDeps): DraftPreview | undefined {
    const server = startServer(config, deps, config.allowedLogins, new URL(publicBaseUrl).pathname);
    if(server === undefined) {
        return undefined;
    }
    deps.registerCleanup({ name: CLEANUP_NAME, run: () => server.stop() });
    return {
        urlFor: (uid, token) => `${publicBaseUrl}/d/${uid}/${token}`,
        ready:  Promise.resolve(true),
    };
}

interface Published {
    tailscale: TailscaleCli
    server:    PreviewServer
    dnsName:   string
}

/** Runs a best-effort removal of the mount (each command is time-limited), logging a failure. */
async function removeMount(remove: () => Promise<void>): Promise<void> {
    try {
        await remove();
    } catch (err: unknown) {
        logger.warn({ error: errorText(err), msg: 'Could not remove the draft preview from tailscale serve; the next start replaces it' });
    }
}

/**
 * Auto mode: check Tailscale, bind the server, and publish it at `previewMountPath(port)` on the
 * Mac's tailnet host, in the background. Until that finishes, and for good if any step fails, cards
 * get no preview link; a failure is one log line and never stops Izzy. A failure after `tailscale
 * serve` succeeded removes the mount again, so a failed start never leaves one behind.
 */
function startAuto(config: EmailPreviewConfig, deps: StartDraftPreviewDeps): DraftPreview {
    const port = config.port;
    const mountPath = previewMountPath(port);
    let publicBaseUrl: string | undefined;
    let stopping = false;

    async function publish(): Promise<Published | undefined> {
        const tailscale = await openTailscaleCli(deps.tailscale);
        const self = await tailscale.readSelf();
        const allowedLogins = config.allowedLogins ?? (self.login === undefined ? undefined : [self.login]);
        if(allowedLogins === undefined) {
            throw new Error('Tailscale lists no login for this Mac\'s owner; set EMAIL_PREVIEW_ALLOWED_LOGINS');
        }
        await tailscale.preflight(self.dnsName, port);
        if(stopping) {
            return undefined;
        }
        const server = startServer(config, deps, allowedLogins, mountPath);
        if(server === undefined) {
            return undefined;
        }
        let served = false;
        try {
            await tailscale.serve(port);
            served = true;
            await tailscale.verify(self.dnsName, port);
        } catch (err: unknown) {
            if(served) {
                await removeMount(async () => tailscale.unmount(port));
            }
            await server.stop();
            throw err;
        }
        publicBaseUrl = `https://${self.dnsName}${mountPath}`;
        logger.info({ publicBaseUrl, msg: 'Draft preview published on the tailnet' });
        return { tailscale, server, dnsName: self.dnsName };
    }

    const published = publish().catch((err: unknown) => {
        logger.warn({ reason: errorText(err), msg: 'Draft preview disabled; approval cards will carry no preview links' });
        return undefined;
    });

    deps.registerCleanup({
        name: CLEANUP_NAME,
        run:  async () => {
            stopping = true;
            const live = await published;
            if(live === undefined) {
                return;
            }
            await removeMount(async () => {
                if(!await live.tailscale.unmountIfOurs(live.dnsName, port)) {
                    logger.info({ mountPath, msg: 'Draft preview mount no longer points at this Izzy; left it in place' });
                }
            });
            await live.server.stop();
        },
    });

    return {
        urlFor: (uid, token) => (publicBaseUrl === undefined ? undefined : `${publicBaseUrl}/d/${uid}/${token}`),
        ready:  published.then(live => live !== undefined),
    };
}

/**
 * Start the draft preview (#158): off (undefined) when unconfigured or `EMAIL_PREVIEW=off`; manual
 * when `EMAIL_PREVIEW_PUBLIC_BASE_URL` is set; otherwise published on the tailnet automatically.
 * Returns synchronously; auto-mode setup continues in the background.
 */
export function startDraftPreview(config: EmailPreviewConfig | undefined, deps: StartDraftPreviewDeps): DraftPreview | undefined {
    if(config === undefined || config.mode === 'off') {
        return undefined;
    }
    if(config.publicBaseUrl !== undefined) {
        return startManual(config, config.publicBaseUrl, deps);
    }
    return startAuto(config, deps);
}

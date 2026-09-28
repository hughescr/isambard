import type { WildDuckClient } from '../wildduck-client';
import { createDraftPreviewHandler } from './handler';
import { startDraftPreviewServer, type PreviewServe } from './server';
import type { EmailPreviewConfig } from '@/config';

const HOUR_MS = 3_600_000;

export interface StartDraftPreviewDeps {
    wildDuckClient:  Pick<WildDuckClient, 'getMessage' | 'openAttachmentStream'>
    /** `Bun.serve` in production. */
    serve:           PreviewServe
    registerCleanup: (step: { name: string, run: () => void | Promise<void> }) => void
}

/**
 * Start the draft preview (#158) when it is configured: the handler over the live WildDuck client
 * behind a loopback-only server, stopped at shutdown. Returns how to build a draft's preview URL
 * under the public (tailnet) base URL, or undefined — no preview links on any card — when preview
 * is not configured or the server could not start.
 */
export function startDraftPreview(config: EmailPreviewConfig | undefined, deps: StartDraftPreviewDeps): ((uid: number, token: string) => string) | undefined {
    if(config === undefined) {
        return undefined;
    }
    const handler = createDraftPreviewHandler({
        wildDuckClient: deps.wildDuckClient,
        ttlMs:          config.ttlHours * HOUR_MS,
        allowedLogins:  config.allowedLogins,
        now:            () => Date.now(),
    });
    const server = startDraftPreviewServer(config.port, handler, deps.serve);
    if(server === undefined) {
        return undefined;
    }
    deps.registerCleanup({ name: 'email preview server', run: () => server.stop() });
    return (uid, token) => `${config.publicBaseUrl}/d/${uid}/${token}`;
}

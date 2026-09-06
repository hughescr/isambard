/**
 * Health-gated poller (Q8) that raises an accumulate notification exactly once per batch of
 * newly-unread Bluesky DM conversations. Mirrors `presence/manager.ts`'s idempotent
 * `start()`/`stop()` shape: a second `start()` while running is a no-op, and `stop()` before any
 * `start()` is a no-op.
 *
 * Each tick is fully self-contained: skip entirely when `!healthRegistry.isAvailable('bluesky')`,
 * otherwise list unread conversations and hand them to
 * `BskyCheckpointManager.processDirectMessages` — which does the dedupe work AND persists the
 * checkpoint itself, so this module never touches the checkpoint directly. When the batch of
 * newly-unread conversations is non-empty, `notify()` is called exactly once (never per-convo),
 * keyed on the newest candidate's `lastMessage.id` (`bsky-dm:<id>`) so the bridge's dedupe set —
 * not this poller — decides whether a repeat of the very same newest message is worth another
 * notification. A tick that throws or rejects (a transient Bluesky API failure, most likely) is
 * caught and logged, never propagated into the `setInterval` callback.
 *
 * @module integrations/discord/setup/bsky-dm-poller
 */
import { logger as defaultLogger, type Logger } from '@hughescr/logger';
import type { NotifyFn } from '@/agent';
import type { BlueskyClient, BskyCheckpointManager, BskyConversation } from '@/integrations/bsky';
import type { ServiceHealthRegistry } from '@/services';

/** Default DM poll interval: 2 minutes. */
export const DEFAULT_DM_POLL_INTERVAL_MS = 120_000;

/** Dependencies for {@link createBskyDmPoller}. */
export interface BskyDmPollerOptions {
    client:            BlueskyClient
    checkpointManager: BskyCheckpointManager
    notify:            NotifyFn
    healthRegistry:    ServiceHealthRegistry
    /** Defaults to {@link DEFAULT_DM_POLL_INTERVAL_MS}. */
    intervalMs?:       number
    logger?:           Logger
}

/** An idempotently start/stoppable DM poller — see the module doc for the tick contract. */
export interface BskyDmPoller {
    start(): void
    stop(): void
}

/** A {@link BskyConversation} narrowed to guarantee it carries a `lastMessage`. */
type ConvoWithMessage = BskyConversation & { lastMessage: NonNullable<BskyConversation['lastMessage']> };

/**
 * The lexicographically newest candidate's `lastMessage.id` in a non-empty batch. Callers must
 * only invoke this when `convos.length > 0` — `processDirectMessages`'s own contract guarantees
 * every entry in `newConvos` carries a `lastMessage`, so there is no defensive empty/undefined
 * case to handle here.
 */
function newestMessageId(convos: ConvoWithMessage[]): string {
    return convos.toSorted((a, b) => a.lastMessage.sentAt.localeCompare(b.lastMessage.sentAt)).at(-1)!.lastMessage.id;
}

/**
 * Builds a health-gated Bluesky DM poller. Returned unstarted — the caller decides when to
 * `start()`/`stop()` it (mirrors `bskyReconnectionLoop`, built by `setupBsky` but started/stopped
 * by `src/index.ts`).
 */
export function createBskyDmPoller(options: BskyDmPollerOptions): BskyDmPoller {
    const { client, checkpointManager, notify, healthRegistry } = options;
    const intervalMs = options.intervalMs ?? DEFAULT_DM_POLL_INTERVAL_MS;
    const log = options.logger ?? defaultLogger;

    let intervalHandle: ReturnType<typeof setInterval> | null = null;

    async function tick(): Promise<void> {
        if(!healthRegistry.isAvailable('bluesky')) {
            return;
        }
        try {
            const { conversations } = await client.listConversations(undefined, undefined, 'unread');
            const { newConvos } = await checkpointManager.processDirectMessages(conversations);
            if(newConvos.length > 0) {
                const newestId = newestMessageId(newConvos);
                const delivered = notify({
                    source:    'bluesky-dm',
                    text:      `${newConvos.length} new unread Bluesky conversation(s)`,
                    wake:      false,
                    dedupeKey: `bsky-dm:${newestId}`,
                });
                // `processDirectMessages` already durably recorded this batch's ids as processed
                // before `notify()` was attempted. When delivery could not be attempted (the
                // conductor is attached but not yet open — see notification-bridge.ts's module
                // doc), undo that so the same batch is treated as new again on the next tick
                // instead of being silently lost forever (review finding).
                if(!delivered) {
                    await checkpointManager.unprocessDirectMessages(newConvos.map(c => c.lastMessage.id));
                }
            }
        } catch (err) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            log.error({ err, msg: 'Bluesky DM poll tick failed' });
        }
    }

    return {
        start(): void {
            if(intervalHandle) {
                return;
            }
            intervalHandle = setInterval(() => {
                void tick();
            }, intervalMs);
        },
        stop(): void {
            if(intervalHandle) {
                clearInterval(intervalHandle);
                intervalHandle = null;
            }
        },
    };
}

import type { TextChannel } from 'discord.js';
import type { ChannelId } from '@/config';
import { ChannelNotFoundByIdError } from '@/errors';
import { DISCORD_MAX_LENGTH, splitMessage } from '@/integrations/discord/messages';
import { classifyDiscordError, withDiscordRetry } from '@/integrations/discord/retry';
import { appendDeliveryCode, decodeDeliveryCode, maxContentLengthForDeliveryCode } from '@/integrations/discord/zero-width-delivery-code';
import { OutboxVerificationPendingError, type OutboxItem } from '@/services';

export interface OutboxReplayDeps {
    fetchChannel(channelId: ChannelId): Promise<TextChannel | null>
}

const DELIVERY_TOKEN_PREFIX = 'iz';
const DELIVERY_TOKEN_BASE_MAX_LENGTH = 18;
const DELIVERY_TOKEN_PART_LENGTH = 6;

/**
 * `deliveryTokenFor` bounds tokens to its prefix, base token, and part suffix. Consumers that
 * split before a code is appended must reserve space for this largest possible token.
 */
export const DELIVERY_TOKEN_MAX_LENGTH = DELIVERY_TOKEN_PREFIX.length + DELIVERY_TOKEN_BASE_MAX_LENGTH + DELIVERY_TOKEN_PART_LENGTH;

/** A compact token that is both a Discord nonce and invisible history correlation code. */
export function deliveryTokenFor(item: OutboxItem, part: number): string {
    const base = item.progress.deliveryToken ?? item.id.replaceAll('-', '').slice(0, 16);
    return `${DELIVERY_TOKEN_PREFIX}${base.slice(0, DELIVERY_TOKEN_BASE_MAX_LENGTH)}${part.toString(36).padStart(DELIVERY_TOKEN_PART_LENGTH, '0')}`;
}

function messageChunksFor(item: OutboxItem): string[] {
    if(!item.payload.text) {
        return [];
    }
    // The six-character chunk suffix makes every delivery token (and therefore every
    // invisible code) the same size, so this budget safely applies to every chunk.
    const maxContentLength = maxContentLengthForDeliveryCode(deliveryTokenFor(item, 0), DISCORD_MAX_LENGTH);
    return splitMessage(item.payload.text, maxContentLength);
}

async function hasPriorDelivery(channel: TextChannel, item: OutboxItem): Promise<boolean> {
    if(item.progress.outcome !== 'unknown') {
        return false;
    }
    const chunks = messageChunksFor(item);
    const hasRichPayload = (item.payload.embeds ?? []).length > 0 || (item.payload.components ?? []).length > 0;
    const parts = Math.max(1, chunks.length + Number(hasRichPayload));
    try {
        const history = await channel.messages.fetch({ limit: 100 });
        const messages = [...history.values()];
        return Array.from({ length: parts }, (_, part) => deliveryTokenFor(item, part))
            .every(token => messages.some(message => decodeDeliveryCode(message.content) === token));
    } catch{
        throw new OutboxVerificationPendingError();
    }
}

async function sendWithOutcomeVerification(channel: TextChannel, payload: Parameters<TextChannel['send']>[0]): Promise<void> {
    try {
        await withDiscordRetry(() => channel.send(payload));
    } catch (error: unknown) {
        const details = typeof error === 'object' && error !== null ? error as { status?: unknown } : {};
        if(classifyDiscordError(error).category === 'transient' || (typeof details.status === 'number' && details.status >= 500)) {
            throw new OutboxVerificationPendingError();
        }
        throw error;
    }
}

/** Creates the Discord delivery function used by the persistent outbox drainer. */
export function createOutboxReplayDeliverFn(deps: OutboxReplayDeps): (item: OutboxItem) => Promise<void> {
    return async (item) => {
        const channel = await deps.fetchChannel(item.destination);
        if(channel === null) {
            throw new ChannelNotFoundByIdError(item.destination);
        }
        if(await hasPriorDelivery(channel, item)) {
            return;
        }
        const chunks = messageChunksFor(item);
        for(const [part, chunk] of chunks.entries()) {
            const nonce = deliveryTokenFor(item, part);
            // eslint-disable-next-line no-await-in-loop -- chunks must be sent sequentially to preserve message order
            await sendWithOutcomeVerification(channel, { content: appendDeliveryCode(chunk, nonce), nonce, enforceNonce: true });
        }
        if((item.payload.embeds ?? []).length > 0 || (item.payload.components ?? []).length > 0) {
            const nonce = deliveryTokenFor(item, chunks.length);
            await sendWithOutcomeVerification(channel, {
                embeds:       item.payload.embeds,
                components:   item.payload.components,
                // An invisible content field tags component-only payloads for replay verification.
                content:      appendDeliveryCode('', nonce),
                nonce,
                enforceNonce: true,
            });
        }
    };
}

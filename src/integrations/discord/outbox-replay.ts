import type { TextChannel } from 'discord.js';
import { ChannelNotFoundByIdError } from '@/errors';
import { splitMessage } from '@/integrations/discord/messages';
import { withDiscordRetry } from '@/integrations/discord/retry';
import type { OutboxItem } from '@/services';

export interface OutboxReplayDeps {
    fetchChannel(channelId: string): Promise<TextChannel | null>
}

/** Creates the Discord delivery function used by the persistent outbox drainer. */
export function createOutboxReplayDeliverFn(deps: OutboxReplayDeps): (item: OutboxItem) => Promise<void> {
    return async (item) => {
        const channel = await deps.fetchChannel(item.destination);
        if(channel === null) {
            throw new ChannelNotFoundByIdError(item.destination);
        }
        if(item.payload.text) {
            const chunks = splitMessage(item.payload.text);
            for(const chunk of chunks) {
                // eslint-disable-next-line no-await-in-loop -- chunks must be sent sequentially to preserve message order
                await withDiscordRetry(() => channel.send(chunk));
            }
        }
        if((item.payload.embeds ?? []).length > 0 || (item.payload.components ?? []).length > 0) {
            await withDiscordRetry(() => channel.send({
                embeds:     item.payload.embeds,
                components: item.payload.components,
            }));
        }
    };
}

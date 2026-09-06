/**
 * Platform-agnostic input for one Discord message being turned into a conductor turn envelope
 * (P9, design section 3.1/6). This type lives in the agent layer (`src/agent/session`)
 * deliberately: no file under `src/agent` may import from `src/integrations/discord`, so
 * everything Discord-shaped about a message — the raw `discord.js` `Message`, its attachments,
 * per-channel mute state — is translated into this shape by
 * `src/integrations/discord/setup/discord-envelope-provider.ts` (P9's other half) before
 * `conductor-processor.ts` hands it to `./envelope`'s `buildDiscordEnvelope`.
 *
 * `channelList` rides on every envelope rather than being cached once at session start: mute
 * state can change between turns, so each turn carries its own snapshot of the channels visible
 * to it at the moment it was built.
 *
 * @module agent/session/discord-envelope-input
 */
import type { PlatformImage } from '../types';

/** One Discord message, translated to the shape the conductor's envelope builders consume. */
export interface DiscordEnvelopeInput {
    messageId:   string
    channelId:   string
    channelName: string
    guildName?:  string
    authorId:    string
    authorName:  string
    content:     string
    createdAt:   Date
    images?:     PlatformImage[]
    isDM:        boolean
    /**
     * Every channel visible to this turn, already formatted for display (unmuted only, a
     * `(guild)` suffix, `[well-known: type]` annotations — see
     * `discord-envelope-provider.ts::channelListProvider`).
     */
    channelList: string[]
}

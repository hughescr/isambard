import { ComponentType, type APIActionRowComponent, type APIComponentInMessageActionRow, type APIEmbed } from 'discord-api-types/v10';
import { z } from 'zod';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const apiEmbedSchema = z.custom<APIEmbed>(isRecord);
const apiActionRowSchema = z.custom<APIActionRowComponent<APIComponentInMessageActionRow>>(
    value => isRecord(value)
      && value.type === ComponentType.ActionRow
      && Array.isArray(value.components)
      && value.components.every(isRecord)
);

/** Durable Discord API payload stored in the generic outbox. */
export const serializedDiscordPayloadSchema = z.object({
    text:             z.string().optional(),
    embeds:           z.array(apiEmbedSchema).optional(),
    components:       z.array(apiActionRowSchema).optional(),
    /**
     * Discord message the first delivered text part replies to. Absent on legacy rows and on
     * non-reply items, so rows written before this field existed still parse unchanged.
     */
    replyToMessageId: z.string().min(1).optional(),
});
export type SerializedDiscordPayload = z.infer<typeof serializedDiscordPayloadSchema>;

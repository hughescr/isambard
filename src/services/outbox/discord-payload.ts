import { ComponentType, type APIActionRowComponent, type APIComponentInMessageActionRow, type APIEmbed } from 'discord.js';
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

const discordPayloadBaseSchema = z.object({
    text:       z.string().optional(),
    embeds:     z.array(apiEmbedSchema).optional(),
    components: z.array(apiActionRowSchema).optional(),
});

// Legacy pre-#49 outbox rows: can be safely deleted after 2026-09-25.
function unwrapLegacyEmbed(value: unknown): unknown {
    if(isRecord(value) && isRecord(value.data)) {
        return value.data;
    }
    return value;
}

// Legacy pre-#49 outbox rows: can be safely deleted after 2026-09-25.
function unwrapLegacyComponent(value: unknown): unknown {
    if(!isRecord(value) || !isRecord(value.data)) {
        return value;
    }

    const legacyComponents = value.components;
    return {
        ...value.data,
        components: Array.isArray(legacyComponents)
            ? legacyComponents.map(component => unwrapLegacyEmbed(component))
            : legacyComponents,
    };
}

// Legacy pre-#49 outbox rows: can be safely deleted after 2026-09-25.
function unwrapLegacyDiscordBuilders(value: unknown): unknown {
    if(!isRecord(value)) {
        return value;
    }

    const legacyEmbeds = value.embeds;
    const legacyComponents = value.components;
    return {
        ...value,
        embeds:     Array.isArray(legacyEmbeds) ? legacyEmbeds.map(embed => unwrapLegacyEmbed(embed)) : legacyEmbeds,
        components: Array.isArray(legacyComponents) ? legacyComponents.map(component => unwrapLegacyComponent(component)) : legacyComponents,
    };
}

/** Durable Discord API payload stored in the generic outbox. */
// Legacy pre-#49 outbox rows: can be safely deleted after 2026-09-25. Replace with discordPayloadBaseSchema.
export const serializedDiscordPayloadSchema = z.preprocess(unwrapLegacyDiscordBuilders, discordPayloadBaseSchema);
export type SerializedDiscordPayload = z.infer<typeof discordPayloadBaseSchema>;

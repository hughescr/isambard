import { z } from 'zod';

/**
 * CustomId is a branded type representing a Discord interaction customId encoded in the
 * `prefix:id[:value]` route grammar (see `encodeCustomId` / `parseCustomId`).
 */
export const customIdSchema = z
    .string()
    .min(1, 'CustomId cannot be empty')
    .brand<'CustomId'>();

export type CustomId = z.infer<typeof customIdSchema>;

/** A parsed Discord interaction route: the handler prefix, its id, and an optional trailing value. */
export interface ParsedCustomId {
    prefix: string
    id:     string
    value?: string
}

/**
 * A single route segment (`prefix` or `id`) must be non-empty and must not contain the `:`
 * delimiter — otherwise `parseCustomId` could not tell where that segment ends.
 */
const routeSegmentSchema = z.string().regex(/^[^:]+$/, 'must be non-empty and contain no \':\'');

interface EncodeCustomIdParams {
    prefix: string
    id:     string
    /** Written verbatim — may contain any characters, including `:` (e.g. a free-text answer). */
    value?: string
}

/**
 * Encode a Discord interaction route as `prefix:id` or `prefix:id:value`.
 *
 * `prefix` and `id` are each validated as a single route segment (non-empty, no embedded `:`)
 * so the result round-trips unambiguously through `parseCustomId` — an id containing a `:` would
 * otherwise be mistaken for an id/value split on decode. `value`, if given, is appended verbatim
 * and is never validated or re-split, since it is read directly by the handler that owns it (a
 * free-text question answer, an email folder name).
 *
 * @throws {z.ZodError} If `prefix` or `id` is empty or contains a `:`.
 */
export function encodeCustomId(params: EncodeCustomIdParams): CustomId {
    const prefix = routeSegmentSchema.parse(params.prefix);
    const id     = routeSegmentSchema.parse(params.id);
    const raw    = params.value === undefined ? `${prefix}:${id}` : `${prefix}:${id}:${params.value}`;
    return customIdSchema.parse(raw);
}

/**
 * Parse a raw Discord customId into `{ prefix, id, value? }`.
 *
 * Splits on the FIRST `:` (the prefix boundary) and then the SECOND `:` (the id boundary);
 * `value` is everything after the second `:`, taken verbatim and never re-split, which preserves
 * embedded colons in free-text values (e.g. a question's typed-in answer). Neither `id` nor
 * `value` is trimmed. Returns `undefined` when `raw` has no `:`, or when the prefix or id
 * segment it implies would be empty.
 */
export function parseCustomId(raw: string): ParsedCustomId | undefined {
    const firstColon = raw.indexOf(':');
    if(firstColon === -1) {
        return undefined;
    }
    const prefix = raw.slice(0, firstColon);
    if(!prefix) {
        return undefined;
    }

    const rest = raw.slice(firstColon + 1);
    const secondColon = rest.indexOf(':');
    if(secondColon === -1) {
        return rest ? { prefix, id: rest } : undefined;
    }

    const id = rest.slice(0, secondColon);
    if(!id) {
        return undefined;
    }
    const value = rest.slice(secondColon + 1);
    return { prefix, id, value };
}

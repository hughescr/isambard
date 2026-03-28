import { z } from 'zod';

/**
 * Known platform types for contact identifiers.
 * Extensible — new platforms can be added here as they are integrated.
 */
// Stryker disable all: Enum values are static definitions
export const platformTypeSchema = z.enum(['name', 'nickname', 'discord', 'email', 'bsky']);
// Stryker restore all

export type PlatformType = z.infer<typeof platformTypeSchema>;

/**
 * A single platform+value pair for a contact.
 * E.g., { platform: 'email', value: 'alice@example.com' }
 */
export const contactIdentifierSchema = z.object({
    platform: platformTypeSchema,
    value:    z.string().min(1).max(500),
});

export type ContactIdentifier = z.infer<typeof contactIdentifierSchema>;

/**
 * ContactId is a branded string representing a kebab-case person identifier.
 * E.g., "craig-hughes" or "alice-wonderland"
 */
// Stryker disable ObjectLiteral,StringLiteral: error message shape and text in refine are informational only
export const contactIdSchema = z
    .string()
    .min(1)
    .max(100)
    .refine(
        id => /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/.test(id),
        {
            message: 'ContactId must be lowercase alphanumeric with hyphens (kebab-case)',
        }
    )
    .brand<'ContactId'>();
// Stryker restore ObjectLiteral,StringLiteral

export type ContactId = z.infer<typeof contactIdSchema>;

/**
 * Creates a validated ContactId from a string.
 * @throws {z.ZodError} If the id is not a valid ContactId
 */
export function createContactId(id: string): ContactId {
    return contactIdSchema.parse(id);
}

/**
 * Type guard to check if a value is a valid ContactId.
 */
export function isContactId(value: unknown): value is ContactId {
    const result = contactIdSchema.safeParse(value);
    return result.success;
}

/**
 * Internal fields stored in DynamoDB but stripped before returning to the agent.
 * These hold platform-specific IDs that the agent should never see directly.
 */
const contactInternalSchema = z.object({
    discordUserId: z.string().optional(),
    bskyDid:       z.string().optional(),
}).optional();

/**
 * Full contact record schema.
 */
export const contactSchema = z.object({
    personId:    contactIdSchema,
    displayName: z.string().min(1).max(200),
    identifiers: z.array(contactIdentifierSchema).min(1),
    notes:       z.string().optional(),
    _internal:   contactInternalSchema,
    createdAt:   z.iso.datetime(),
    updatedAt:   z.iso.datetime(),
});

export type Contact = z.infer<typeof contactSchema>;

/**
 * DynamoDB item structure with PK/SK keys.
 */
export interface ContactProfileItem extends Contact {
    PK: string  // CONTACT#{personId}
    SK: string  // PROFILE
}

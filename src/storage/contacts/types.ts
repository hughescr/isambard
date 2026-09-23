import { z } from 'zod';

/**
 * Known platform types for contact identifiers.
 * Extensible — new platforms can be added here as they are integrated.
 */
export const platformTypeSchema = z.enum(['name', 'nickname', 'discord', 'email', 'bsky']);

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
 * THE identifier equivalence rule: two identifier values on the same platform denote the
 * same handle when their normalized forms are equal. Shared by the persisted lookup keys
 * (ContactKeyGenerator), in-memory identifier comparison and the person allowlist, so a
 * change to the rule (e.g. Unicode folding) is made here once.
 *
 * Today the rule is lowercase + trim, with no Unicode compatibility folding.
 */
export function normalizeIdentifierValue(value: string): string {
    return value.toLowerCase().trim();
}

declare const contactIdentifierKeyBrand: unique symbol;

/**
 * The serialized `{platform}#{normalizedValue}` form of a contact identifier, used as a
 * map key and as the tail of the DynamoDB lookup partition key. Only
 * {@link contactIdentifierKey} produces one.
 */
export type ContactIdentifierKey = string & { readonly [contactIdentifierKeyBrand]: 'ContactIdentifierKey' };

/**
 * Derives the {@link ContactIdentifierKey} for a platform+value pair.
 *
 * No {@link PlatformType} value contains `#`, so two keys are equal exactly when the
 * platforms are equal and the {@link normalizeIdentifierValue normalized} values are equal.
 */
export function contactIdentifierKey(platform: PlatformType, value: string): ContactIdentifierKey {
    return `${platform}#${normalizeIdentifierValue(value)}` as ContactIdentifierKey;
}

/**
 * PersonId is the canonical identity key for a person in the address book: a branded
 * kebab-case string (e.g. "craig-hughes" or "alice-wonderland"). A {@link Contact} is the
 * record stored under that key.
 */
const PERSON_ID_REGEX = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/;

export const personIdSchema = z
    .string()
    .min(1)
    .max(100)
    .refine(
        id => PERSON_ID_REGEX.test(id),
        {
            message: 'personId must be lowercase alphanumeric with hyphens (kebab-case)',
        }
    )
    .brand<'PersonId'>();

export type PersonId = z.infer<typeof personIdSchema>;

/**
 * A pending contact change that requires administrator approval.
 * Create requests define the new contact; update requests target an existing contact.
 */
interface ContactCreateRequest {
    action:         'create'
    displayName:    string
    addIdentifiers: ContactIdentifier[]
    notes?:         string
    personId?:      PersonId
};

interface ContactUpdateRequest {
    action:             'update'
    personId:           PersonId
    addIdentifiers?:    ContactIdentifier[]
    removeIdentifiers?: ContactIdentifier[]
    notes?:             string
};

export type ContactChangeRequest = ContactCreateRequest | ContactUpdateRequest;

/**
 * Creates a validated PersonId from a string.
 * @throws {z.ZodError} If the id is not a valid PersonId
 */
export function createPersonId(id: string): PersonId {
    return personIdSchema.parse(id);
}

/**
 * Type guard to check if a value is a valid PersonId.
 */
export function isPersonId(value: unknown): value is PersonId {
    const result = personIdSchema.safeParse(value);
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
    personId:    personIdSchema,
    displayName: z.string().min(1).max(200),
    identifiers: z.array(contactIdentifierSchema).min(1),
    notes:       z.string().optional(),
    _internal:   contactInternalSchema,
    createdAt:   z.iso.datetime(),
    updatedAt:   z.iso.datetime(),
});

export type Contact = z.infer<typeof contactSchema>;

/**
 * DynamoDB item structure with PK/SK keys and GSI2 keys for collection listing.
 */
export interface ContactProfileItem extends Contact {
    PK:     string      // CONTACT#{personId}
    SK:     string      // PROFILE
    GSI2PK: string  // CONTACTS
    GSI2SK: string  // CONTACT#{personId}
}

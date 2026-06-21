import { z } from 'zod';

// Stryker disable all: Schema values are static definitions

const allowlistSagaStateSchema = z.enum([
    'pending_name',      // waiting for admin to provide a display name
    'pending_review',    // showing a fuzzy match, waiting for admin decision
    'completed',         // person added to allowlist (terminal)
    'cancelled',         // flow abandoned (terminal)
]);

const allowlistSagaPlatformSchema = z.enum(['email', 'bsky']);
export type AllowlistSagaPlatform = z.infer<typeof allowlistSagaPlatformSchema>;

// Stryker restore all

export const allowlistSagaSchema = z.object({
    id:               z.uuid(),
    state:            allowlistSagaStateSchema,
    platform:         allowlistSagaPlatformSchema,
    identifierValue:  z.string(),              // the email address or bsky handle
    displayNameHint:  z.string().optional(),   // pre-filled from email headers or bsky profile
    adminDisplayName: z.string().optional(),   // what admin typed in the modal
    fuzzyMatches:     z.array(z.string()).optional(), // personId strings from fuzzy search
    matchIndex:       z.number().int().optional(),    // current match being reviewed
    resultPersonId:   z.string().optional(),   // the personId that was added to allowlist
    addedBy:          z.string(),              // 'outbound-approval'
    createdAt:        z.iso.datetime(),
    updatedAt:        z.iso.datetime(),
    ttl:              z.number().int().optional(),
});
export type AllowlistSaga = z.infer<typeof allowlistSagaSchema>;

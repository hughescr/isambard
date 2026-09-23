import { z } from 'zod';

// Branded type for CalendarServerId
const calendarServerIdSchema = z
    .string()
    .check(z.uuid({ error: 'Calendar server ID must be a valid UUID' }))
    .brand<'CalendarServerId'>();

type CalendarServerId = z.infer<typeof calendarServerIdSchema>;

export function createCalendarServerId(id: string): CalendarServerId {
    return calendarServerIdSchema.parse(id);
}

export function isCalendarServerId(value: unknown): value is CalendarServerId {
    return calendarServerIdSchema.safeParse(value).success;
}

// Calendar entry within a server
export const calendarEntrySchema = z.object({
    calendarPath: z.string().min(1),
    label:        z.string().min(1),
});

// Server entry with credentials and calendars
export const calendarServerEntrySchema = z.object({
    serverId:    calendarServerIdSchema,
    description: z.string().min(1),
    serverUrl:   z.url(),
    username:    z.string().min(1),
    password:    z.string().min(1),
    calendars:   z.array(calendarEntrySchema).min(1),
});

export type CalendarServerEntry = z.infer<typeof calendarServerEntrySchema>;

/**
 * Who a registry record belongs to: one user, or every user (shared/public calendars). The
 * persisted form lives in the key generator: the record's PK encodes the scope and is authoritative.
 */
export const calendarRegistryScopeSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('personal'), userId: z.string().min(1) }),
    z.strictObject({ kind: z.literal('shared') }),
]);
export type CalendarRegistryScope = z.infer<typeof calendarRegistryScopeSchema>;

// Full registry record for either scope
export const calendarRegistryRecordSchema = z.object({
    scope:     calendarRegistryScopeSchema,
    servers:   z.array(calendarServerEntrySchema),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
});

export type CalendarRegistryRecord = z.infer<typeof calendarRegistryRecordSchema>;

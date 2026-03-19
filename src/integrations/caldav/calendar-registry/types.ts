import { z } from 'zod';

// Branded type for CalendarServerId
// Stryker disable ObjectLiteral,StringLiteral: UUID validation error message is informational only
export const calendarServerIdSchema = z
    .string()
    .check(z.uuid({ error: 'Calendar server ID must be a valid UUID' }))
    // Stryker restore ObjectLiteral,StringLiteral
    .brand<'CalendarServerId'>();

export type CalendarServerId = z.infer<typeof calendarServerIdSchema>;

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

export type CalendarEntry = z.infer<typeof calendarEntrySchema>;

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

// Full registry record for a user
export const calendarRegistryRecordSchema = z.object({
    userId:    z.string().min(1),
    servers:   z.array(calendarServerEntrySchema),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
});

export type CalendarRegistryRecord = z.infer<typeof calendarRegistryRecordSchema>;

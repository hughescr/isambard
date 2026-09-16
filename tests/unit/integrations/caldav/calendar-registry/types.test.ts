import { describe, test, expect } from 'bun:test';
import {
    calendarEntrySchema,
    calendarServerEntrySchema,
    calendarRegistryRecordSchema,
    createCalendarServerId,
    isCalendarServerId
} from '@/integrations/caldav/calendar-registry/types';

const VALID_UUID_STRING = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID        = createCalendarServerId(VALID_UUID_STRING);
const VALID_URL         = 'https://caldav.example.com/';

describe('calendarEntrySchema', () => {
    test('should parse valid CalendarEntry', () => {
        const entry = calendarEntrySchema.parse({
            calendarPath: '/calendars/user/default/',
            label:        'Personal',
        });
        expect(entry.calendarPath).toBe('/calendars/user/default/');
        expect(entry.label).toBe('Personal');
    });

    test('should reject empty calendarPath', () => {
        expect(() => calendarEntrySchema.parse({
            calendarPath: '',
            label:        'Personal',
        })).toThrow();
    });

    test('should reject empty label', () => {
        expect(() => calendarEntrySchema.parse({
            calendarPath: '/calendars/user/default/',
            label:        '',
        })).toThrow();
    });

    test('should reject missing calendarPath', () => {
        expect(() => calendarEntrySchema.parse({
            label: 'Personal',
        })).toThrow();
    });

    test('should reject missing label', () => {
        expect(() => calendarEntrySchema.parse({
            calendarPath: '/calendars/user/default/',
        })).toThrow();
    });

    test('should accept single-character calendarPath', () => {
        const entry = calendarEntrySchema.parse({
            calendarPath: '/',
            label:        'Personal',
        });
        expect(entry.calendarPath).toBe('/');
    });

    test('should accept single-character label', () => {
        const entry = calendarEntrySchema.parse({
            calendarPath: '/calendars/user/default/',
            label:        'P',
        });
        expect(entry.label).toBe('P');
    });
});

describe('createCalendarServerId', () => {
    test('reports the UUID validation contract for an invalid server ID', () => {
        expect(() => createCalendarServerId('not-a-uuid')).toThrow('Calendar server ID must be a valid UUID');
    });
});

describe('calendarServerEntrySchema', () => {
    test('should parse valid CalendarServerEntry', () => {
        const entry = calendarServerEntrySchema.parse({
            serverId:    VALID_UUID,
            description: 'My CalDAV server',
            serverUrl:   VALID_URL,
            username:    'alice',
            password:    'secret',
            calendars:   [
                { calendarPath: '/calendars/alice/default/', label: 'Personal' },
            ],
        });
        expect(entry.serverId).toBe(VALID_UUID);
        expect(entry.description).toBe('My CalDAV server');
        expect(entry.serverUrl).toBe(VALID_URL);
        expect(entry.username).toBe('alice');
        expect(entry.password).toBe('secret');
        expect(entry.calendars).toHaveLength(1);
    });

    test('should parse entry with multiple calendars', () => {
        const entry = calendarServerEntrySchema.parse({
            serverId:    VALID_UUID,
            description: 'Work server',
            serverUrl:   VALID_URL,
            username:    'bob',
            password:    'pass',
            calendars:   [
                { calendarPath: '/calendars/bob/work/', label: 'Work' },
                { calendarPath: '/calendars/bob/personal/', label: 'Personal' },
            ],
        });
        expect(entry.calendars).toHaveLength(2);
    });

    test('should reject invalid UUID serverId', () => {
        expect(() => calendarServerEntrySchema.parse({
            serverId:    'not-a-uuid',
            description: 'Server',
            serverUrl:   VALID_URL,
            username:    'alice',
            password:    'secret',
            calendars:   [{ calendarPath: '/cal/', label: 'Cal' }],
        })).toThrow();
    });

    test('should reject invalid serverUrl', () => {
        expect(() => calendarServerEntrySchema.parse({
            serverId:    VALID_UUID,
            description: 'Server',
            serverUrl:   'not-a-url',
            username:    'alice',
            password:    'secret',
            calendars:   [{ calendarPath: '/cal/', label: 'Cal' }],
        })).toThrow();
    });

    test('should reject empty description', () => {
        expect(() => calendarServerEntrySchema.parse({
            serverId:    VALID_UUID,
            description: '',
            serverUrl:   VALID_URL,
            username:    'alice',
            password:    'secret',
            calendars:   [{ calendarPath: '/cal/', label: 'Cal' }],
        })).toThrow();
    });

    test('should reject empty username', () => {
        expect(() => calendarServerEntrySchema.parse({
            serverId:    VALID_UUID,
            description: 'Server',
            serverUrl:   VALID_URL,
            username:    '',
            password:    'secret',
            calendars:   [{ calendarPath: '/cal/', label: 'Cal' }],
        })).toThrow();
    });

    test('should reject empty password', () => {
        expect(() => calendarServerEntrySchema.parse({
            serverId:    VALID_UUID,
            description: 'Server',
            serverUrl:   VALID_URL,
            username:    'alice',
            password:    '',
            calendars:   [{ calendarPath: '/cal/', label: 'Cal' }],
        })).toThrow();
    });

    test('should reject empty calendars array', () => {
        expect(() => calendarServerEntrySchema.parse({
            serverId:    VALID_UUID,
            description: 'Server',
            serverUrl:   VALID_URL,
            username:    'alice',
            password:    'secret',
            calendars:   [],
        })).toThrow();
    });

    test('should reject missing required fields', () => {
        expect(() => calendarServerEntrySchema.parse({})).toThrow();
    });

    test('should accept single-character description', () => {
        const entry = calendarServerEntrySchema.parse({
            serverId:    VALID_UUID,
            description: 'S',
            serverUrl:   VALID_URL,
            username:    'alice',
            password:    'secret',
            calendars:   [{ calendarPath: '/cal/', label: 'Cal' }],
        });
        expect(entry.description).toBe('S');
    });

    test('should accept single-character username', () => {
        const entry = calendarServerEntrySchema.parse({
            serverId:    VALID_UUID,
            description: 'Server',
            serverUrl:   VALID_URL,
            username:    'a',
            password:    'secret',
            calendars:   [{ calendarPath: '/cal/', label: 'Cal' }],
        });
        expect(entry.username).toBe('a');
    });
});

describe('calendarRegistryRecordSchema', () => {
    test('should parse valid CalendarRegistryRecord with no servers', () => {
        const record = calendarRegistryRecordSchema.parse({
            userId:    'user-123',
            servers:   [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });
        expect(record.userId).toBe('user-123');
        expect(record.servers).toHaveLength(0);
        expect(record.createdAt).toBe('2026-01-01T00:00:00.000Z');
        expect(record.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    test('should parse valid CalendarRegistryRecord with servers', () => {
        const record = calendarRegistryRecordSchema.parse({
            userId:  'user-456',
            servers: [
                {
                    serverId:    VALID_UUID,
                    description: 'My server',
                    serverUrl:   VALID_URL,
                    username:    'alice',
                    password:    'secret',
                    calendars:   [{ calendarPath: '/cal/', label: 'Cal' }],
                },
            ],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        });
        expect(record.servers).toHaveLength(1);
    });

    test('should reject empty userId', () => {
        expect(() => calendarRegistryRecordSchema.parse({
            userId:    '',
            servers:   [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        })).toThrow();
    });

    test('should reject invalid createdAt', () => {
        expect(() => calendarRegistryRecordSchema.parse({
            userId:    'user-123',
            servers:   [],
            createdAt: 'not-a-date',
            updatedAt: '2026-01-01T00:00:00.000Z',
        })).toThrow();
    });

    test('should reject invalid updatedAt', () => {
        expect(() => calendarRegistryRecordSchema.parse({
            userId:    'user-123',
            servers:   [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: 'not-a-date',
        })).toThrow();
    });

    test('should reject missing required fields', () => {
        expect(() => calendarRegistryRecordSchema.parse({})).toThrow();
    });

    test('should accept single-character userId', () => {
        const record = calendarRegistryRecordSchema.parse({
            userId:    'u',
            servers:   [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });
        expect(record.userId).toBe('u');
    });
});

describe('createCalendarServerId', () => {
    test('should create a valid CalendarServerId from UUID', () => {
        const id = createCalendarServerId(VALID_UUID_STRING);
        expect(id).toBe(VALID_UUID);
    });

    test('should throw for non-UUID string', () => {
        expect(() => createCalendarServerId('not-a-uuid')).toThrow();
    });

    test('should throw for empty string', () => {
        expect(() => createCalendarServerId('')).toThrow();
    });
});

describe('isCalendarServerId', () => {
    test('should return true for valid UUID', () => {
        expect(isCalendarServerId(VALID_UUID_STRING)).toBe(true);
    });

    test('should return false for non-UUID string', () => {
        expect(isCalendarServerId('not-a-uuid')).toBe(false);
    });

    test('should return false for empty string', () => {
        expect(isCalendarServerId('')).toBe(false);
    });

    test('should return false for non-string', () => {
        expect(isCalendarServerId(42)).toBe(false);
        expect(isCalendarServerId(null)).toBe(false);
        expect(isCalendarServerId(undefined)).toBe(false);
    });
});

import { type Mock, describe, test, expect, beforeEach, mock } from 'bun:test';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { buildCalendarCommand, CalendarCommandHandler } from '@/integrations/caldav/calendar-commands';
import type { CalendarRegistryBackend } from '@/integrations/caldav/calendar-registry/backend';
import type { CalendarRegistryRecord } from '@/integrations/caldav/calendar-registry/types';
import type { CalDAVClient } from '@/integrations/caldav/client';

// Admin Discord user ID used in tests
// Stryker disable next-line StringLiteral: Test admin user ID is a test configuration constant
const ADMIN_USER_ID = '423276934781468692';
const USER_ID       = 'user-123';
const OTHER_USER_ID = 'other-user-456';

// Stryker disable next-line StringLiteral: Test UUID is a test configuration constant
const TEST_SERVER_UUID = '550e8400-e29b-41d4-a716-446655440001' as `${string}-${string}-${string}-${string}-${string}`;

interface MockInteraction {
    asChatInput:    ChatInputCommandInteraction
    reply:          Mock<(...args: unknown[]) => Promise<void>>
    editReply:      Mock<(...args: unknown[]) => Promise<unknown>>
    deferReply:     Mock<(...args: unknown[]) => Promise<void>>
    awaitComponent: Mock<(...args: unknown[]) => Promise<unknown>>
    deferUpdate:    Mock<(...args: unknown[]) => Promise<void>>
}

function createMockInteraction(
    userId:            string,
    subcommandGroup:   string | null,
    subcommand:        string,
    stringOptions:     Record<string, string | null> = {},
    targetUser?:       { id: string } | null
): MockInteraction {
    const replyMock:          Mock<(...args: unknown[]) => Promise<void>>    = mock(async () => {});
    const deferReplyMock:     Mock<(...args: unknown[]) => Promise<void>>    = mock(async () => {});
    const deferUpdateMock:    Mock<(...args: unknown[]) => Promise<void>>    = mock(async () => {});
    const awaitComponentMock: Mock<(...args: unknown[]) => Promise<unknown>> = mock(async () => ({ values: [], deferUpdate: deferUpdateMock }));

    const mockMessage = { awaitMessageComponent: awaitComponentMock };
    const editReplyMock: Mock<(...args: unknown[]) => Promise<unknown>> = mock(async () => mockMessage);

    const interaction = {
        id:      'interaction-id-123',
        user:    { id: userId },
        options: {
            getSubcommandGroup: mock(() => subcommandGroup),
            getSubcommand:      mock(() => subcommand),
            getString:          mock((name: string) => stringOptions[name] ?? null),
            getUser:            mock(() => targetUser ?? null),
        },
        reply:      replyMock,
        editReply:  editReplyMock,
        deferReply: deferReplyMock,
    } as unknown as ChatInputCommandInteraction;

    return {
        asChatInput:    interaction,
        reply:          replyMock,
        editReply:      editReplyMock,
        deferReply:     deferReplyMock,
        awaitComponent: awaitComponentMock,
        deferUpdate:    deferUpdateMock,
    };
}

function createMockRegistry(): {
    getUserRecord:        ReturnType<typeof mock>
    getSharedRecord:      ReturnType<typeof mock>
    addServer:            ReturnType<typeof mock>
    removeServer:         ReturnType<typeof mock>
    removeCalendar:       ReturnType<typeof mock>
    addSharedServer:      ReturnType<typeof mock>
    removeSharedServer:   ReturnType<typeof mock>
    removeSharedCalendar: ReturnType<typeof mock>
} {
    return {
        getUserRecord:        mock(async (): Promise<CalendarRegistryRecord | null> => null),
        getSharedRecord:      mock(async (): Promise<CalendarRegistryRecord | null> => null),
        addServer:            mock(async (): Promise<void> => {}),
        removeServer:         mock(async (): Promise<boolean> => false),
        removeCalendar:       mock(async (): Promise<boolean> => false),
        addSharedServer:      mock(async (): Promise<void> => {}),
        removeSharedServer:   mock(async (): Promise<boolean> => false),
        removeSharedCalendar: mock(async (): Promise<boolean> => false),
    };
}

function createMockCaldavClient(): {
    discoverCalendars: ReturnType<typeof mock>
} {
    return {
        discoverCalendars: mock(async (): Promise<{ path: string, displayName: string }[]> => []),
    };
}

// ─── buildCalendarCommand() ───────────────────────────────────────────────────

describe('buildCalendarCommand()', () => {
    test('returns a command with name "calendar"', () => {
        const cmd  = buildCalendarCommand();
        const json = cmd.toJSON();
        expect(json.name).toBe('calendar');
    });

    test('returns a command with correct description', () => {
        const cmd  = buildCalendarCommand();
        const json = cmd.toJSON();
        expect(json.description).toBe('Manage CalDAV calendar associations');
    });

    test('has add-server, list, remove-server, remove-calendar subcommands', () => {
        const cmd      = buildCalendarCommand();
        const json     = cmd.toJSON();
        const topLevel = (json.options ?? []).map(o => o.name);
        expect(topLevel).toContain('add-server');
        expect(topLevel).toContain('list');
        expect(topLevel).toContain('remove-server');
        expect(topLevel).toContain('remove-calendar');
    });

    test('has shared subcommand group', () => {
        const cmd      = buildCalendarCommand();
        const json     = cmd.toJSON();
        const topLevel = (json.options ?? []).map(o => o.name);
        expect(topLevel).toContain('shared');
    });

    test('add-server subcommand has required server_url, username, password, description options', () => {
        const cmd      = buildCalendarCommand();
        const json     = cmd.toJSON();
        const addSub   = (json.options ?? []).find(o => o.name === 'add-server');
        expect(addSub).toBeDefined();
        const opts: { name: string, required?: boolean }[] = (addSub as { options?: { name: string, required?: boolean }[] }).options ?? [];
        for(const name of ['server_url', 'username', 'password', 'description']) {
            const opt = opts.find(o => o.name === name);
            expect(opt).toBeDefined();
            expect(opt?.required).toBe(true);
        }
    });

    test('add-server subcommand has optional user option', () => {
        const cmd    = buildCalendarCommand();
        const json   = cmd.toJSON();
        const addSub = (json.options ?? []).find(o => o.name === 'add-server');
        const opts: { name: string, required?: boolean }[] = (addSub as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const userOpt = opts.find(o => o.name === 'user');
        expect(userOpt).toBeDefined();
        expect(userOpt?.required).toBeFalsy();
    });

    test('list subcommand has optional user option', () => {
        const cmd     = buildCalendarCommand();
        const json    = cmd.toJSON();
        const listSub = (json.options ?? []).find(o => o.name === 'list');
        const opts: { name: string, required?: boolean }[] = (listSub as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const userOpt = opts.find(o => o.name === 'user');
        expect(userOpt).toBeDefined();
        expect(userOpt?.required).toBeFalsy();
    });

    test('remove-server subcommand has required server_id option', () => {
        const cmd       = buildCalendarCommand();
        const json      = cmd.toJSON();
        const removeSub = (json.options ?? []).find(o => o.name === 'remove-server');
        const opts: { name: string, required?: boolean }[] = (removeSub as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const serverIdOpt = opts.find(o => o.name === 'server_id');
        expect(serverIdOpt).toBeDefined();
        expect(serverIdOpt?.required).toBe(true);
    });

    test('remove-server subcommand has optional user option', () => {
        const cmd       = buildCalendarCommand();
        const json      = cmd.toJSON();
        const removeSub = (json.options ?? []).find(o => o.name === 'remove-server');
        const opts: { name: string, required?: boolean }[] = (removeSub as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const userOpt = opts.find(o => o.name === 'user');
        expect(userOpt).toBeDefined();
        expect(userOpt?.required).toBeFalsy();
    });

    test('remove-calendar subcommand has required server_id and calendar_path options', () => {
        const cmd       = buildCalendarCommand();
        const json      = cmd.toJSON();
        const removeSub = (json.options ?? []).find(o => o.name === 'remove-calendar');
        const opts: { name: string, required?: boolean }[] = (removeSub as { options?: { name: string, required?: boolean }[] }).options ?? [];
        for(const name of ['server_id', 'calendar_path']) {
            const opt = opts.find(o => o.name === name);
            expect(opt).toBeDefined();
            expect(opt?.required).toBe(true);
        }
    });

    test('remove-calendar subcommand has optional user option', () => {
        const cmd       = buildCalendarCommand();
        const json      = cmd.toJSON();
        const removeSub = (json.options ?? []).find(o => o.name === 'remove-calendar');
        const opts: { name: string, required?: boolean }[] = (removeSub as { options?: { name: string, required?: boolean }[] }).options ?? [];
        const userOpt = opts.find(o => o.name === 'user');
        expect(userOpt).toBeDefined();
        expect(userOpt?.required).toBeFalsy();
    });

    test('shared group has add-server, list, remove-server, remove-calendar subcommands', () => {
        const cmd        = buildCalendarCommand();
        const json       = cmd.toJSON();
        const sharedGroup = (json.options ?? []).find(o => o.name === 'shared');
        expect(sharedGroup).toBeDefined();
        const subNames = ((sharedGroup as { options?: { name: string }[] }).options ?? []).map(o => o.name);
        expect(subNames).toContain('add-server');
        expect(subNames).toContain('list');
        expect(subNames).toContain('remove-server');
        expect(subNames).toContain('remove-calendar');
    });

    test('sets contexts to Guild, BotDM, and PrivateChannel', () => {
        const cmd  = buildCalendarCommand();
        const json = cmd.toJSON();
        expect(json.contexts).toEqual([0, 1, 2]);
    });

    test('sets integration types to GuildInstall only', () => {
        const cmd  = buildCalendarCommand();
        const json = cmd.toJSON();
        expect(json.integration_types).toEqual([0]);
    });
});

// ─── Permission checks ────────────────────────────────────────────────────────

describe('CalendarCommandHandler - permission checks', () => {
    let mockRegistry:    ReturnType<typeof createMockRegistry>;
    let mockCaldav:      ReturnType<typeof createMockCaldavClient>;
    let handler:         CalendarCommandHandler;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockCaldav   = createMockCaldavClient();
        handler = new CalendarCommandHandler(
            mockCaldav as unknown as CalDAVClient,
            mockRegistry as unknown as CalendarRegistryBackend,
            ADMIN_USER_ID
        );
        mockRegistry.getUserRecord.mockResolvedValue({ servers: [], userId: USER_ID, createdAt: '', updatedAt: '' });
    });

    test('user can manage their own calendars without error', async () => {
        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'list');
        await handler.handle(asChatInput);
        // Should not reject — should reach list logic
        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).not.toContain('Only the admin');
    });

    test('user specifying themselves as target can manage their own calendars', async () => {
        const { asChatInput, editReply } = createMockInteraction(
            USER_ID, null, 'list',
            {},
            { id: USER_ID }
        );
        await handler.handle(asChatInput);
        // Non-admin specifying themselves should not trigger the admin check
        expect(editReply).toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).not.toContain('Only the admin');
    });

    test('non-admin cannot manage another user\'s calendars', async () => {
        const { asChatInput, editReply } = createMockInteraction(
            USER_ID, null, 'list',
            {},
            { id: OTHER_USER_ID }
        );
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Only the admin can manage other users');
    });

    test('admin can manage another user\'s calendars', async () => {
        const { asChatInput, editReply } = createMockInteraction(
            ADMIN_USER_ID, null, 'list',
            {},
            { id: OTHER_USER_ID }
        );
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).not.toContain('Only the admin can manage other users');
    });

    test('non-admin cannot manage shared calendars (write ops)', async () => {
        const { asChatInput, editReply } = createMockInteraction(USER_ID, 'shared', 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'user',
            password:    'pass',
            description: 'My Server',
        });
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Only the admin can manage shared calendars');
    });

    test('non-admin CAN list shared calendars', async () => {
        const { asChatInput, editReply } = createMockInteraction(USER_ID, 'shared', 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).not.toContain('Only the admin can manage shared calendars');
    });

    test('defers reply before processing', async () => {
        const { asChatInput, deferReply } = createMockInteraction(USER_ID, null, 'list');
        await handler.handle(asChatInput);
        expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    });
});

// ─── /calendar add-server ─────────────────────────────────────────────────────

describe('CalendarCommandHandler - /calendar add-server', () => {
    let mockRegistry: ReturnType<typeof createMockRegistry>;
    let mockCaldav:   ReturnType<typeof createMockCaldavClient>;
    let handler:      CalendarCommandHandler;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockCaldav   = createMockCaldavClient();
        handler = new CalendarCommandHandler(
            mockCaldav as unknown as CalDAVClient,
            mockRegistry as unknown as CalendarRegistryBackend,
            ADMIN_USER_ID
        );
    });

    test('discovers calendars and adds server, replies with calendar list', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([
            { path: '/calendars/personal', displayName: 'Personal' },
            { path: '/calendars/work',     displayName: 'Work' },
        ]);

        const { asChatInput, editReply, awaitComponent } = createMockInteraction(USER_ID, null, 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'myuser',
            password:    'mypass',
            description: 'iCloud',
        });
        awaitComponent.mockResolvedValue({ values: ['0', '1'], deferUpdate: mock(async () => {}) });
        await handler.handle(asChatInput);

        expect(mockCaldav.discoverCalendars).toHaveBeenCalledWith('https://caldav.example.com', 'myuser', 'mypass');
        expect(mockRegistry.addServer).toHaveBeenCalledTimes(1);

        // Last editReply should be the success message
        const lastCall = editReply.mock.calls[editReply.mock.calls.length - 1]?.[0] as { content?: string };
        expect(lastCall.content).toContain('iCloud');
        expect(lastCall.content).toContain('2 calendar');
        expect(lastCall.content).toContain('Personal');
        expect(lastCall.content).toContain('Work');
    });

    test('replies "No calendars found" when server has no calendars', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([]);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'u',
            password:    'p',
            description: 'Empty server',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.addServer).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('No calendars found');
    });

    test('handles discoverCalendars error gracefully', async () => {
        mockCaldav.discoverCalendars.mockRejectedValue(new Error('Connection refused'));

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'add-server', {
            server_url:  'https://bad.example.com',
            username:    'u',
            password:    'p',
            description: 'Bad server',
        });
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to add server');
        expect(replyArg.content).toContain('Connection refused');
    });

    test('uses targetUser when admin specifies a different user', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([
            { path: '/cal', displayName: 'Calendar' },
        ]);

        const { asChatInput, awaitComponent } = createMockInteraction(
            ADMIN_USER_ID, null, 'add-server',
            {
                server_url:  'https://caldav.example.com',
                username:    'u',
                password:    'p',
                description: 'Server',
            },
            { id: OTHER_USER_ID }
        );
        // Single calendar — auto-add, awaitComponent not called
        await handler.handle(asChatInput);

        expect(awaitComponent).not.toHaveBeenCalled();
        expect(mockRegistry.addServer).toHaveBeenCalledTimes(1);
        const [userId] = mockRegistry.addServer.mock.calls[0] as [string, unknown];
        expect(userId).toBe(OTHER_USER_ID);
    });

    test('presents select menu and stores only selected calendars', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([
            { path: '/cal/a', displayName: 'Calendar A' },
            { path: '/cal/b', displayName: 'Calendar B' },
            { path: '/cal/c', displayName: 'Calendar C' },
        ]);

        const { asChatInput, editReply, awaitComponent } = createMockInteraction(USER_ID, null, 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'u',
            password:    'p',
            description: 'Server',
        });
        awaitComponent.mockResolvedValue({ values: ['0', '2'], deferUpdate: mock(async () => {}) });
        await handler.handle(asChatInput);

        // First editReply = select menu prompt
        const promptArg = editReply.mock.calls[0]?.[0] as { content?: string, components?: unknown[] };
        expect(promptArg.content).toContain('Found 3 calendar(s)');
        expect(promptArg.components).toBeDefined();

        // addServer called with only selected calendars
        expect(mockRegistry.addServer).toHaveBeenCalledTimes(1);
        const serverArg = mockRegistry.addServer.mock.calls[0]?.[1] as { calendars: { calendarPath: string }[] };
        expect(serverArg.calendars).toHaveLength(2);
        expect(serverArg.calendars.map((c: { calendarPath: string }) => c.calendarPath)).toEqual(['/cal/a', '/cal/c']);

        // Success reply clears the select menu components
        const successArg = editReply.mock.calls[editReply.mock.calls.length - 1]?.[0] as { components?: unknown[] };
        expect(successArg.components).toEqual([]);
    });

    test('handles select menu timeout gracefully', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([
            { path: '/cal/a', displayName: 'A' },
            { path: '/cal/b', displayName: 'B' },
        ]);

        const { asChatInput, editReply, awaitComponent } = createMockInteraction(USER_ID, null, 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'u',
            password:    'p',
            description: 'Server',
        });
        awaitComponent.mockRejectedValue(new Error('Collector received no interactions before ending with reason: time'));
        await handler.handle(asChatInput);

        expect(mockRegistry.addServer).not.toHaveBeenCalled();
        const lastCall = editReply.mock.calls[editReply.mock.calls.length - 1]?.[0] as { content?: string };
        expect(lastCall.content).toContain('timed out');
        expect(lastCall.content).toContain('again to retry');
    });

    test('handles non-timeout select menu errors with generic message', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([
            { path: '/cal/a', displayName: 'A' },
            { path: '/cal/b', displayName: 'B' },
        ]);

        const { asChatInput, editReply, awaitComponent } = createMockInteraction(USER_ID, null, 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'u',
            password:    'p',
            description: 'Server',
        });
        awaitComponent.mockRejectedValue(new Error('Unknown component error'));
        await handler.handle(asChatInput);

        expect(mockRegistry.addServer).not.toHaveBeenCalled();
        const lastCall = editReply.mock.calls[editReply.mock.calls.length - 1]?.[0] as { content?: string, components?: unknown[] };
        expect(lastCall.content).toContain('selection failed');
        expect(lastCall.content).toContain('again to retry');
        expect(lastCall.components).toEqual([]);
    });

    test('auto-adds single calendar without showing select menu', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([
            { path: '/cal/only', displayName: 'Only Calendar' },
        ]);

        const { asChatInput, awaitComponent } = createMockInteraction(USER_ID, null, 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'u',
            password:    'p',
            description: 'Server',
        });
        await handler.handle(asChatInput);

        expect(awaitComponent).not.toHaveBeenCalled();
        expect(mockRegistry.addServer).toHaveBeenCalledTimes(1);
    });

    test('truncates to 25 and warns when more than 25 calendars discovered', async () => {
        const manyCals = Array.from({ length: 30 }, (_, i) => ({
            path:        `/cal/${i}`,
            displayName: `Calendar ${i}`,
        }));
        mockCaldav.discoverCalendars.mockResolvedValue(manyCals);

        const { asChatInput, editReply, awaitComponent } = createMockInteraction(USER_ID, null, 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'u',
            password:    'p',
            description: 'Server',
        });
        awaitComponent.mockResolvedValue({ values: ['0', '1'], deferUpdate: mock(async () => {}) });
        await handler.handle(asChatInput);

        const promptArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(promptArg.content).toContain('30');
        expect(promptArg.content).toContain('25');
    });

    test('does NOT warn when exactly 25 calendars discovered (boundary)', async () => {
        const exactly25 = Array.from({ length: 25 }, (_, i) => ({
            path:        `/cal/${i}`,
            displayName: `Calendar ${i}`,
        }));
        mockCaldav.discoverCalendars.mockResolvedValue(exactly25);

        const { asChatInput, editReply, awaitComponent } = createMockInteraction(USER_ID, null, 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'u',
            password:    'p',
            description: 'Server',
        });
        awaitComponent.mockResolvedValue({ values: ['0'], deferUpdate: mock(async () => {}) });
        await handler.handle(asChatInput);

        const promptArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(promptArg.content).not.toContain('Only showing the first 25');
        expect(promptArg.content).not.toContain('Discord limit');
    });

    test('select menu prompt includes components array with one action row', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([
            { path: '/cal/a', displayName: 'Calendar A' },
            { path: '/cal/b', displayName: 'Calendar B' },
        ]);

        const { asChatInput, editReply, awaitComponent } = createMockInteraction(USER_ID, null, 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'u',
            password:    'p',
            description: 'Server',
        });
        awaitComponent.mockResolvedValue({ values: ['0'], deferUpdate: mock(async () => {}) });
        await handler.handle(asChatInput);

        const promptArg = editReply.mock.calls[0]?.[0] as { content?: string, components?: unknown[] };
        expect(promptArg.components).toBeDefined();
        expect(promptArg.components).toHaveLength(1);
    });

    test('acknowledges select menu interaction with deferUpdate', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([
            { path: '/cal/a', displayName: 'A' },
            { path: '/cal/b', displayName: 'B' },
        ]);

        const deferUpdateFn: Mock<(...args: unknown[]) => Promise<void>> = mock(async () => {});
        const { asChatInput, awaitComponent } = createMockInteraction(USER_ID, null, 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'u',
            password:    'p',
            description: 'S',
        });
        awaitComponent.mockResolvedValue({ values: ['0'], deferUpdate: deferUpdateFn });
        await handler.handle(asChatInput);

        expect(deferUpdateFn).toHaveBeenCalledTimes(1);
    });
});

// ─── /calendar list ───────────────────────────────────────────────────────────

describe('CalendarCommandHandler - /calendar list', () => {
    let mockRegistry: ReturnType<typeof createMockRegistry>;
    let mockCaldav:   ReturnType<typeof createMockCaldavClient>;
    let handler:      CalendarCommandHandler;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockCaldav   = createMockCaldavClient();
        handler = new CalendarCommandHandler(
            mockCaldav as unknown as CalDAVClient,
            mockRegistry as unknown as CalendarRegistryBackend,
            ADMIN_USER_ID
        );
    });

    test('replies "No calendars configured" when user has no servers', async () => {
        mockRegistry.getUserRecord.mockResolvedValue(null);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toBe('No calendars configured.');
    });

    test('replies "No calendars configured" when user has empty servers array', async () => {
        mockRegistry.getUserRecord.mockResolvedValue({ servers: [], userId: USER_ID, createdAt: '', updatedAt: '' });

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toBe('No calendars configured.');
    });

    test('lists servers with calendars grouped by server', async () => {
        mockRegistry.getUserRecord.mockResolvedValue({
            userId:    USER_ID,
            createdAt: '',
            updatedAt: '',
            servers:   [
                {
                    serverId:    'aabbccdd-1111-2222-3333-444455556666' as `${string}-${string}-${string}-${string}-${string}`,
                    description: 'iCloud',
                    serverUrl:   'https://caldav.icloud.com',
                    username:    'user@icloud.com',
                    password:    'secret',
                    calendars:   [
                        { calendarPath: '/cal/home',   label: 'Home' },
                        { calendarPath: '/cal/family', label: 'Family' },
                    ],
                },
            ],
        });

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('iCloud');
        expect(replyArg.content).toContain('Home');
        expect(replyArg.content).toContain('/cal/home');
        expect(replyArg.content).toContain('Family');
        expect(replyArg.content).toContain('/cal/family');
    });

    test('handles list error gracefully', async () => {
        mockRegistry.getUserRecord.mockRejectedValue(new Error('DynamoDB timeout'));

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to list calendars');
    });
});

// ─── /calendar remove-server ──────────────────────────────────────────────────

describe('CalendarCommandHandler - /calendar remove-server', () => {
    let mockRegistry: ReturnType<typeof createMockRegistry>;
    let mockCaldav:   ReturnType<typeof createMockCaldavClient>;
    let handler:      CalendarCommandHandler;

    const testServerRecord = {
        userId:    USER_ID,
        createdAt: '',
        updatedAt: '',
        servers:   [{
            serverId:    TEST_SERVER_UUID,
            description: 'iCloud',
            serverUrl:   'https://caldav.icloud.com',
            username:    'user@icloud.com',
            password:    'secret',
            calendars:   [{ calendarPath: '/cal/home', label: 'Home' }],
        }],
    };

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockCaldav   = createMockCaldavClient();
        handler = new CalendarCommandHandler(
            mockCaldav as unknown as CalDAVClient,
            mockRegistry as unknown as CalendarRegistryBackend,
            ADMIN_USER_ID
        );
    });

    test('removes server by exact UUID and replies with success', async () => {
        mockRegistry.getUserRecord.mockResolvedValue(testServerRecord);
        mockRegistry.removeServer.mockResolvedValue(true);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-server', {
            server_id: TEST_SERVER_UUID,
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeServer).toHaveBeenCalledWith(USER_ID, TEST_SERVER_UUID);
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Removed server');
        expect(replyArg.content).toContain('iCloud');
        expect(replyArg.content).toContain(TEST_SERVER_UUID);
    });

    test('removes server by description name and replies with success', async () => {
        mockRegistry.getUserRecord.mockResolvedValue(testServerRecord);
        mockRegistry.removeServer.mockResolvedValue(true);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-server', {
            server_id: 'icloud',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeServer).toHaveBeenCalledWith(USER_ID, TEST_SERVER_UUID);
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Removed server');
    });

    test('replies "not found" when server does not match any entry', async () => {
        mockRegistry.getUserRecord.mockResolvedValue(testServerRecord);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-server', {
            server_id: 'nonexistent-server',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeServer).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('not found');
    });

    test('replies "No calendars configured" when user has no record', async () => {
        mockRegistry.getUserRecord.mockResolvedValue(null);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-server', {
            server_id: 'iCloud',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeServer).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('No calendars configured');
    });

    test('replies "No calendars configured" when user has empty servers', async () => {
        mockRegistry.getUserRecord.mockResolvedValue({ userId: USER_ID, createdAt: '', updatedAt: '', servers: [] });

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-server', {
            server_id: 'iCloud',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeServer).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('No calendars configured');
    });

    test('replies ambiguity error when description matches multiple servers', async () => {
        const ambigRecord = {
            userId:    USER_ID,
            createdAt: '',
            updatedAt: '',
            servers:   [
                {
                    serverId:    TEST_SERVER_UUID,
                    description: 'iCloud',
                    serverUrl:   'https://caldav.icloud.com',
                    username:    'user1',
                    password:    'pass1',
                    calendars:   [{ calendarPath: '/cal/personal', label: 'Personal' }],
                },
                {
                    // Stryker disable next-line StringLiteral: Test UUID is a test configuration constant
                    serverId:    '550e8400-e29b-41d4-a716-446655440002' as `${string}-${string}-${string}-${string}-${string}`,
                    description: 'iCloud',
                    serverUrl:   'https://caldav.icloud.com',
                    username:    'user2',
                    password:    'pass2',
                    calendars:   [{ calendarPath: '/cal/work', label: 'Work' }],
                },
            ],
        };
        mockRegistry.getUserRecord.mockResolvedValue(ambigRecord);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-server', {
            server_id: 'icloud',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeServer).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Multiple servers match');
        expect(replyArg.content).toContain('icloud');
    });

    test('replies "already removed" when removeServer returns false (race condition)', async () => {
        mockRegistry.getUserRecord.mockResolvedValue(testServerRecord);
        // removeServer returns false (default mock), simulating concurrent deletion

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-server', {
            server_id: TEST_SERVER_UUID,
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeServer).toHaveBeenCalledWith(USER_ID, TEST_SERVER_UUID);
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toBe('Server was already removed.');
    });

    test('handles remove-server error gracefully', async () => {
        mockRegistry.getUserRecord.mockRejectedValue(new Error('Write failed'));

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-server', {
            server_id: TEST_SERVER_UUID,
        });
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to remove server');
    });

    test('admin can remove another user\'s server via user option', async () => {
        const otherUserRecord = { ...testServerRecord, userId: OTHER_USER_ID };
        mockRegistry.getUserRecord.mockResolvedValue(otherUserRecord);
        mockRegistry.removeServer.mockResolvedValue(true);

        const { asChatInput } = createMockInteraction(
            ADMIN_USER_ID, null, 'remove-server',
            { server_id: TEST_SERVER_UUID },
            { id: OTHER_USER_ID }
        );
        await handler.handle(asChatInput);

        expect(mockRegistry.removeServer).toHaveBeenCalledWith(OTHER_USER_ID, TEST_SERVER_UUID);
    });

    test('non-admin cannot remove another user\'s server via user option', async () => {
        const { asChatInput, editReply } = createMockInteraction(
            USER_ID, null, 'remove-server',
            { server_id: TEST_SERVER_UUID },
            { id: OTHER_USER_ID }
        );
        await handler.handle(asChatInput);

        expect(mockRegistry.removeServer).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Only the admin can manage other users');
    });
});

// ─── /calendar remove-calendar ────────────────────────────────────────────────

describe('CalendarCommandHandler - /calendar remove-calendar', () => {
    let mockRegistry: ReturnType<typeof createMockRegistry>;
    let mockCaldav:   ReturnType<typeof createMockCaldavClient>;
    let handler:      CalendarCommandHandler;

    const testServerRecord = {
        userId:    USER_ID,
        createdAt: '',
        updatedAt: '',
        servers:   [{
            serverId:    TEST_SERVER_UUID,
            description: 'iCloud',
            serverUrl:   'https://caldav.icloud.com',
            username:    'user@icloud.com',
            password:    'secret',
            calendars:   [
                { calendarPath: '/calendars/home',   label: 'Home' },
                { calendarPath: '/calendars/family', label: 'Family' },
            ],
        }],
    };

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockCaldav   = createMockCaldavClient();
        handler = new CalendarCommandHandler(
            mockCaldav as unknown as CalDAVClient,
            mockRegistry as unknown as CalendarRegistryBackend,
            ADMIN_USER_ID
        );
    });

    test('removes calendar by exact path and replies with success', async () => {
        mockRegistry.getUserRecord.mockResolvedValue(testServerRecord);
        mockRegistry.removeCalendar.mockResolvedValue(true);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: '/calendars/home',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeCalendar).toHaveBeenCalledWith(USER_ID, TEST_SERVER_UUID, '/calendars/home');
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Removed calendar');
        expect(replyArg.content).toContain('Home');
    });

    test('removes calendar by label name and replies with success', async () => {
        mockRegistry.getUserRecord.mockResolvedValue(testServerRecord);
        mockRegistry.removeCalendar.mockResolvedValue(true);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: 'family',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeCalendar).toHaveBeenCalledWith(USER_ID, TEST_SERVER_UUID, '/calendars/family');
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Removed calendar');
        expect(replyArg.content).toContain('Family');
    });

    test('replies "not found" when calendar path does not match any entry', async () => {
        mockRegistry.getUserRecord.mockResolvedValue(testServerRecord);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: '/calendars/nonexistent',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeCalendar).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('not found');
    });

    test('replies "not found" when server does not match', async () => {
        mockRegistry.getUserRecord.mockResolvedValue(testServerRecord);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-calendar', {
            server_id:     'nonexistent-server',
            calendar_path: '/calendars/home',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeCalendar).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('not found');
    });

    test('replies "No calendars configured" when user has no record', async () => {
        mockRegistry.getUserRecord.mockResolvedValue(null);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-calendar', {
            server_id:     'iCloud',
            calendar_path: 'Home',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeCalendar).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('No calendars configured');
    });

    test('replies "No calendars configured" when user has empty servers array', async () => {
        mockRegistry.getUserRecord.mockResolvedValue({ userId: USER_ID, createdAt: '', updatedAt: '', servers: [] });

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-calendar', {
            server_id:     'iCloud',
            calendar_path: 'Home',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeCalendar).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('No calendars configured');
    });

    test('replies ambiguity error when calendar label matches multiple entries', async () => {
        const ambigRecord = {
            userId:    USER_ID,
            createdAt: '',
            updatedAt: '',
            servers:   [{
                serverId:    TEST_SERVER_UUID,
                description: 'iCloud',
                serverUrl:   'https://caldav.icloud.com',
                username:    'user',
                password:    'pass',
                calendars:   [
                    { calendarPath: '/cal/home-1', label: 'Home' },
                    { calendarPath: '/cal/home-2', label: 'Home' },
                ],
            }],
        };
        mockRegistry.getUserRecord.mockResolvedValue(ambigRecord);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: 'home',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeCalendar).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Multiple calendars match');
    });

    test('replies "already removed" when removeCalendar returns false (race condition)', async () => {
        mockRegistry.getUserRecord.mockResolvedValue(testServerRecord);
        // removeCalendar returns false (default mock), simulating concurrent deletion

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: '/calendars/home',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeCalendar).toHaveBeenCalledWith(USER_ID, TEST_SERVER_UUID, '/calendars/home');
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toBe('Calendar was already removed.');
    });

    test('handles remove-calendar error gracefully', async () => {
        mockRegistry.getUserRecord.mockRejectedValue(new Error('Write failed'));

        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: '/calendars/home',
        });
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to remove calendar');
    });

    test('admin can remove another user\'s calendar via user option', async () => {
        const otherUserRecord = { ...testServerRecord, userId: OTHER_USER_ID };
        mockRegistry.getUserRecord.mockResolvedValue(otherUserRecord);
        mockRegistry.removeCalendar.mockResolvedValue(true);

        const { asChatInput } = createMockInteraction(
            ADMIN_USER_ID, null, 'remove-calendar',
            {
                server_id:     TEST_SERVER_UUID,
                calendar_path: '/calendars/home',
            },
            { id: OTHER_USER_ID }
        );
        await handler.handle(asChatInput);

        expect(mockRegistry.removeCalendar).toHaveBeenCalledWith(OTHER_USER_ID, TEST_SERVER_UUID, '/calendars/home');
    });

    test('non-admin cannot remove another user\'s calendar via user option', async () => {
        const { asChatInput, editReply } = createMockInteraction(
            USER_ID, null, 'remove-calendar',
            {
                server_id:     TEST_SERVER_UUID,
                calendar_path: '/calendars/home',
            },
            { id: OTHER_USER_ID }
        );
        await handler.handle(asChatInput);

        expect(mockRegistry.removeCalendar).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Only the admin can manage other users');
    });
});

// ─── /calendar shared add-server ─────────────────────────────────────────────

describe('CalendarCommandHandler - /calendar shared add-server', () => {
    let mockRegistry: ReturnType<typeof createMockRegistry>;
    let mockCaldav:   ReturnType<typeof createMockCaldavClient>;
    let handler:      CalendarCommandHandler;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockCaldav   = createMockCaldavClient();
        handler = new CalendarCommandHandler(
            mockCaldav as unknown as CalDAVClient,
            mockRegistry as unknown as CalendarRegistryBackend,
            ADMIN_USER_ID
        );
    });

    test('admin can add shared server', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([
            { path: '/shared/holidays', displayName: 'Holidays' },
        ]);

        const { asChatInput, editReply, awaitComponent } = createMockInteraction(ADMIN_USER_ID, 'shared', 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'admin',
            password:    'pass',
            description: 'Company Shared',
        });
        // Single calendar — auto-add, no menu
        await handler.handle(asChatInput);

        expect(awaitComponent).not.toHaveBeenCalled();
        expect(mockRegistry.addSharedServer).toHaveBeenCalledTimes(1);
        const replyArg = editReply.mock.calls[editReply.mock.calls.length - 1]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Company Shared');
        expect(replyArg.content).toContain('Holidays');
    });

    test('replies "No calendars found" for shared add-server with no calendars', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([]);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'u',
            password:    'p',
            description: 'Empty',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.addSharedServer).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('No calendars found');
    });

    test('handles shared add-server error gracefully', async () => {
        mockCaldav.discoverCalendars.mockRejectedValue(new Error('Auth failed'));

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'add-server', {
            server_url:  'https://bad.example.com',
            username:    'u',
            password:    'p',
            description: 'Bad',
        });
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to add shared server');
        expect(replyArg.content).toContain('Auth failed');
    });

    test('shared: presents select menu and stores only selected calendars', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([
            { path: '/shared/a', displayName: 'Shared A' },
            { path: '/shared/b', displayName: 'Shared B' },
            { path: '/shared/c', displayName: 'Shared C' },
        ]);

        const { asChatInput, editReply, awaitComponent } = createMockInteraction(ADMIN_USER_ID, 'shared', 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'u',
            password:    'p',
            description: 'Shared Server',
        });
        awaitComponent.mockResolvedValue({ values: ['0', '2'], deferUpdate: mock(async () => {}) });
        await handler.handle(asChatInput);

        // First editReply = select menu prompt
        const promptArg = editReply.mock.calls[0]?.[0] as { content?: string, components?: unknown[] };
        expect(promptArg.content).toContain('Found 3 calendar(s)');
        expect(promptArg.components).toBeDefined();

        // addSharedServer called with only selected calendars
        expect(mockRegistry.addSharedServer).toHaveBeenCalledTimes(1);
        const serverArg = mockRegistry.addSharedServer.mock.calls[0]?.[0] as { calendars: { calendarPath: string }[] };
        expect(serverArg.calendars).toHaveLength(2);
        expect(serverArg.calendars.map((c: { calendarPath: string }) => c.calendarPath)).toEqual(['/shared/a', '/shared/c']);

        // Success reply clears the select menu components
        const successArg = editReply.mock.calls[editReply.mock.calls.length - 1]?.[0] as { components?: unknown[] };
        expect(successArg.components).toEqual([]);
    });

    test('shared: handles select menu timeout gracefully', async () => {
        mockCaldav.discoverCalendars.mockResolvedValue([
            { path: '/shared/a', displayName: 'A' },
            { path: '/shared/b', displayName: 'B' },
        ]);

        const { asChatInput, editReply, awaitComponent } = createMockInteraction(ADMIN_USER_ID, 'shared', 'add-server', {
            server_url:  'https://caldav.example.com',
            username:    'u',
            password:    'p',
            description: 'Shared Server',
        });
        awaitComponent.mockRejectedValue(new Error('Collector received no interactions before ending with reason: time'));
        await handler.handle(asChatInput);

        expect(mockRegistry.addSharedServer).not.toHaveBeenCalled();
        const lastCall = editReply.mock.calls[editReply.mock.calls.length - 1]?.[0] as { content?: string, components?: unknown[] };
        expect(lastCall.content).toContain('timed out');
        expect(lastCall.content).toContain('/calendar shared add-server');
        expect(lastCall.components).toEqual([]);
    });
});

// ─── /calendar shared list ────────────────────────────────────────────────────

describe('CalendarCommandHandler - /calendar shared list', () => {
    let mockRegistry: ReturnType<typeof createMockRegistry>;
    let mockCaldav:   ReturnType<typeof createMockCaldavClient>;
    let handler:      CalendarCommandHandler;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockCaldav   = createMockCaldavClient();
        handler = new CalendarCommandHandler(
            mockCaldav as unknown as CalDAVClient,
            mockRegistry as unknown as CalendarRegistryBackend,
            ADMIN_USER_ID
        );
    });

    test('lists shared calendars', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue({
            userId:    'SHARED',
            createdAt: '',
            updatedAt: '',
            servers:   [
                {
                    serverId:    'aabbccdd-1111-2222-3333-444455556666' as `${string}-${string}-${string}-${string}-${string}`,
                    description: 'Holidays',
                    serverUrl:   'https://caldav.example.com',
                    username:    'admin',
                    password:    'pass',
                    calendars:   [
                        { calendarPath: '/shared/holidays', label: 'Holidays' },
                    ],
                },
            ],
        });

        const { asChatInput, editReply } = createMockInteraction(USER_ID, 'shared', 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Holidays');
        expect(replyArg.content).toContain('/shared/holidays');
    });

    test('replies "No shared calendars configured" when none exist (null record)', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue(null);

        const { asChatInput, editReply } = createMockInteraction(USER_ID, 'shared', 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toBe('No shared calendars configured.');
    });

    test('replies "No shared calendars configured" when record has empty servers array', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue({
            userId:    'SHARED',
            createdAt: '',
            updatedAt: '',
            servers:   [],
        });

        const { asChatInput, editReply } = createMockInteraction(USER_ID, 'shared', 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toBe('No shared calendars configured.');
    });

    test('handles shared list error gracefully', async () => {
        mockRegistry.getSharedRecord.mockRejectedValue(new Error('DB error'));

        const { asChatInput, editReply } = createMockInteraction(USER_ID, 'shared', 'list');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to list shared calendars');
    });
});

// ─── /calendar shared remove-server ──────────────────────────────────────────

describe('CalendarCommandHandler - /calendar shared remove-server', () => {
    let mockRegistry: ReturnType<typeof createMockRegistry>;
    let mockCaldav:   ReturnType<typeof createMockCaldavClient>;
    let handler:      CalendarCommandHandler;

    const sharedServerRecord = {
        userId:    'SHARED',
        createdAt: '',
        updatedAt: '',
        servers:   [{
            serverId:    TEST_SERVER_UUID,
            description: 'Holidays',
            serverUrl:   'https://caldav.example.com',
            username:    'admin',
            password:    'pass',
            calendars:   [{ calendarPath: '/shared/holidays', label: 'Holidays' }],
        }],
    };

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockCaldav   = createMockCaldavClient();
        handler = new CalendarCommandHandler(
            mockCaldav as unknown as CalDAVClient,
            mockRegistry as unknown as CalendarRegistryBackend,
            ADMIN_USER_ID
        );
    });

    test('admin removes shared server by exact UUID and replies with success', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue(sharedServerRecord);
        mockRegistry.removeSharedServer.mockResolvedValue(true);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-server', {
            server_id: TEST_SERVER_UUID,
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedServer).toHaveBeenCalledWith(TEST_SERVER_UUID);
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Removed shared server');
        expect(replyArg.content).toContain('Holidays');
    });

    test('admin removes shared server by description name', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue(sharedServerRecord);
        mockRegistry.removeSharedServer.mockResolvedValue(true);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-server', {
            server_id: 'holidays',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedServer).toHaveBeenCalledWith(TEST_SERVER_UUID);
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Removed shared server');
    });

    test('replies "not found" when shared server does not match any entry', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue(sharedServerRecord);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-server', {
            server_id: 'nonexistent',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedServer).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('not found');
    });

    test('replies "No shared calendars configured" when no shared record exists', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue(null);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-server', {
            server_id: 'Holidays',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedServer).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('No shared calendars configured');
    });

    test('replies "No shared calendars configured" when shared record has empty servers', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue({ userId: 'SHARED', createdAt: '', updatedAt: '', servers: [] });

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-server', {
            server_id: 'Holidays',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedServer).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('No shared calendars configured');
    });

    test('non-admin cannot remove shared server', async () => {
        const { asChatInput, editReply } = createMockInteraction(USER_ID, 'shared', 'remove-server', {
            server_id: TEST_SERVER_UUID,
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedServer).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Only the admin can manage shared calendars');
    });

    test('replies "already removed" when removeSharedServer returns false (race condition)', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue(sharedServerRecord);
        // removeSharedServer returns false (default mock), simulating concurrent deletion

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-server', {
            server_id: TEST_SERVER_UUID,
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedServer).toHaveBeenCalledWith(TEST_SERVER_UUID);
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toBe('Shared server was already removed.');
    });

    test('handles shared remove-server error gracefully', async () => {
        mockRegistry.getSharedRecord.mockRejectedValue(new Error('Write failed'));

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-server', {
            server_id: TEST_SERVER_UUID,
        });
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to remove shared server');
    });

    test('replies ambiguity error when shared server description matches multiple entries', async () => {
        const ambigRecord = {
            userId:    'SHARED',
            createdAt: '',
            updatedAt: '',
            servers:   [
                {
                    serverId:    TEST_SERVER_UUID,
                    description: 'Holidays',
                    serverUrl:   'https://caldav.example.com',
                    username:    'admin1',
                    password:    'pass1',
                    calendars:   [{ calendarPath: '/shared/holidays-1', label: 'Holidays 1' }],
                },
                {
                    // Stryker disable next-line StringLiteral: Test UUID is a test configuration constant
                    serverId:    '550e8400-e29b-41d4-a716-446655440002' as `${string}-${string}-${string}-${string}-${string}`,
                    description: 'Holidays',
                    serverUrl:   'https://caldav.example.com',
                    username:    'admin2',
                    password:    'pass2',
                    calendars:   [{ calendarPath: '/shared/holidays-2', label: 'Holidays 2' }],
                },
            ],
        };
        mockRegistry.getSharedRecord.mockResolvedValue(ambigRecord);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-server', {
            server_id: 'holidays',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedServer).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Multiple servers match');
        expect(replyArg.content).toContain('holidays');
    });
});

// ─── Unknown subcommands ──────────────────────────────────────────────────────

describe('CalendarCommandHandler - unknown subcommands', () => {
    let mockRegistry: ReturnType<typeof createMockRegistry>;
    let mockCaldav:   ReturnType<typeof createMockCaldavClient>;
    let handler:      CalendarCommandHandler;

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockCaldav   = createMockCaldavClient();
        handler = new CalendarCommandHandler(
            mockCaldav as unknown as CalDAVClient,
            mockRegistry as unknown as CalendarRegistryBackend,
            ADMIN_USER_ID
        );
    });

    test('replies with error for unknown user subcommand', async () => {
        const { asChatInput, editReply } = createMockInteraction(USER_ID, null, 'unknown-cmd');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toBe('Unknown subcommand: unknown-cmd');
    });

    test('replies with error for unknown shared subcommand', async () => {
        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'unknown-cmd');
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toBe('Unknown shared subcommand: unknown-cmd');
    });
});

// ─── /calendar shared remove-calendar ────────────────────────────────────────

describe('CalendarCommandHandler - /calendar shared remove-calendar', () => {
    let mockRegistry: ReturnType<typeof createMockRegistry>;
    let mockCaldav:   ReturnType<typeof createMockCaldavClient>;
    let handler:      CalendarCommandHandler;

    const sharedServerRecord = {
        userId:    'SHARED',
        createdAt: '',
        updatedAt: '',
        servers:   [{
            serverId:    TEST_SERVER_UUID,
            description: 'Holidays',
            serverUrl:   'https://caldav.example.com',
            username:    'admin',
            password:    'pass',
            calendars:   [
                { calendarPath: '/shared/holidays', label: 'Holidays' },
                { calendarPath: '/shared/birthdays', label: 'Birthdays' },
            ],
        }],
    };

    beforeEach(() => {
        mockRegistry = createMockRegistry();
        mockCaldav   = createMockCaldavClient();
        handler = new CalendarCommandHandler(
            mockCaldav as unknown as CalDAVClient,
            mockRegistry as unknown as CalendarRegistryBackend,
            ADMIN_USER_ID
        );
    });

    test('admin removes shared calendar by exact path and replies with success', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue(sharedServerRecord);
        mockRegistry.removeSharedCalendar.mockResolvedValue(true);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: '/shared/holidays',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedCalendar).toHaveBeenCalledWith(TEST_SERVER_UUID, '/shared/holidays');
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Removed shared calendar');
        expect(replyArg.content).toContain('Holidays');
    });

    test('admin removes shared calendar by label name', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue(sharedServerRecord);
        mockRegistry.removeSharedCalendar.mockResolvedValue(true);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: 'birthdays',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedCalendar).toHaveBeenCalledWith(TEST_SERVER_UUID, '/shared/birthdays');
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Removed shared calendar');
        expect(replyArg.content).toContain('Birthdays');
    });

    test('replies "not found" when shared calendar path does not match', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue(sharedServerRecord);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: '/shared/nonexistent',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedCalendar).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('not found');
    });

    test('replies "No shared calendars configured" when no shared record exists', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue(null);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: '/shared/holidays',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedCalendar).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('No shared calendars configured');
    });

    test('replies "No shared calendars configured" when shared record has empty servers', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue({ userId: 'SHARED', createdAt: '', updatedAt: '', servers: [] });

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: '/shared/holidays',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedCalendar).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('No shared calendars configured');
    });

    test('non-admin cannot remove shared calendar', async () => {
        const { asChatInput, editReply } = createMockInteraction(USER_ID, 'shared', 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: '/shared/holidays',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedCalendar).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Only the admin can manage shared calendars');
    });

    test('replies "already removed" when removeSharedCalendar returns false (race condition)', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue(sharedServerRecord);
        // removeSharedCalendar returns false (default mock), simulating concurrent deletion

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: '/shared/holidays',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedCalendar).toHaveBeenCalledWith(TEST_SERVER_UUID, '/shared/holidays');
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toBe('Shared calendar was already removed.');
    });

    test('handles shared remove-calendar error gracefully', async () => {
        mockRegistry.getSharedRecord.mockRejectedValue(new Error('Write failed'));

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-calendar', {
            server_id:     TEST_SERVER_UUID,
            calendar_path: '/shared/holidays',
        });
        await handler.handle(asChatInput);

        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Failed to remove shared calendar');
    });

    test('replies "not found" when shared server does not match in remove-calendar', async () => {
        mockRegistry.getSharedRecord.mockResolvedValue(sharedServerRecord);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-calendar', {
            server_id:     'nonexistent-server',
            calendar_path: '/shared/holidays',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedCalendar).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('not found');
    });

    test('replies ambiguity error when shared server description matches multiple entries in remove-calendar', async () => {
        const ambigRecord = {
            userId:    'SHARED',
            createdAt: '',
            updatedAt: '',
            servers:   [
                {
                    serverId:    TEST_SERVER_UUID,
                    description: 'Holidays',
                    serverUrl:   'https://caldav.example.com',
                    username:    'admin1',
                    password:    'pass1',
                    calendars:   [{ calendarPath: '/shared/holidays-1', label: 'Holidays 1' }],
                },
                {
                    // Stryker disable next-line StringLiteral: Test UUID is a test configuration constant
                    serverId:    '550e8400-e29b-41d4-a716-446655440002' as `${string}-${string}-${string}-${string}-${string}`,
                    description: 'Holidays',
                    serverUrl:   'https://caldav.example.com',
                    username:    'admin2',
                    password:    'pass2',
                    calendars:   [{ calendarPath: '/shared/holidays-2', label: 'Holidays 2' }],
                },
            ],
        };
        mockRegistry.getSharedRecord.mockResolvedValue(ambigRecord);

        const { asChatInput, editReply } = createMockInteraction(ADMIN_USER_ID, 'shared', 'remove-calendar', {
            server_id:     'holidays',
            calendar_path: '/shared/holidays-1',
        });
        await handler.handle(asChatInput);

        expect(mockRegistry.removeSharedCalendar).not.toHaveBeenCalled();
        const replyArg = editReply.mock.calls[0]?.[0] as { content?: string };
        expect(replyArg.content).toContain('Multiple servers match');
        expect(replyArg.content).toContain('holidays');
    });
});

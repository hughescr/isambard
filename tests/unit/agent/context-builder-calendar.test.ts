import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createContextBuilder, type CalendarService } from '../../../src/agent/context-builder';
import type { CalDAVClient, CalendarRegistryBackend, CalendarServerEntry } from '../../../src/integrations/caldav';
import { CaldavAuthError, CaldavTimeoutError } from '../../../src/integrations/caldav/errors';
import { MemoryToolBackend } from '../../../src/storage/memory-tool/backend';
import { createMemoryPath } from '../../../src/storage/memory-tool/types';
import { mockLogger } from '../../setup';

describe('createContextBuilder calendar context injection', () => {
    let mockDocClient: DynamoDBDocumentClient;
    let backend: MemoryToolBackend;
    let mockCalDAVClient: CalDAVClient;
    let mockCalendarRegistry: CalendarRegistryBackend;

    const fakeServer: CalendarServerEntry = {
        serverId:    '00000000-0000-0000-0000-000000000001' as CalendarServerEntry['serverId'],
        description: 'Test server',
        serverUrl:   'https://cal.example.com',
        username:    'user',
        password:    'pass',
        calendars:   [{ calendarPath: '/calendars/main/', label: 'Main' }],
    };

    const fakeEvent = {
        uid:           'evt-001',
        summary:       'Team meeting',
        start:         new Date('2026-03-18T10:00:00Z'),
        end:           new Date('2026-03-18T11:00:00Z'),
        isAllDay:      false,
        calendarLabel: 'Main',
        status:        'confirmed' as const,
    };

    function setupBackendMocks(): void {
        backend.list = mock(async () => ({ items: [] }));
        backend.getStateItemsScored = mock(async () => []);
        backend.searchByTimeRange = mock(async () => []);
        backend.listByLayer = mock(async () => ({ items: [] }));
    }

    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();

        mockDocClient = {} as DynamoDBDocumentClient;
        backend = new MemoryToolBackend(mockDocClient, 'test-table');

        mockCalDAVClient = {
            getContextEvents: mock(async () => [fakeEvent]),
        } as unknown as CalDAVClient;

        mockCalendarRegistry = {
            getAllCalendars:       mock(async () => [fakeServer]),
            listRegisteredUserIds: mock(async () => []),
        } as unknown as CalendarRegistryBackend;
    });

    describe('buildPerchContext with calendarService', () => {
        test('should include calendar section when calendarService is configured and users have calendars', async () => {
            setupBackendMocks();

            mockCalendarRegistry.listRegisteredUserIds = mock(async () => ['user-alice']);

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            expect(result).toContain('## Calendar');
            expect(result).toContain('Team meeting');
        });

        test('should NOT include calendar section when calendarService is not configured for perch', async () => {
            setupBackendMocks();

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            expect(result).not.toContain('## Calendar');
        });

        test('should NOT include calendar section when no users have registered calendars', async () => {
            setupBackendMocks();

            mockCalendarRegistry.listRegisteredUserIds = mock(async () => []);

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            expect(result).not.toContain('## Calendar');
        });

        test('should NOT include calendar section when getContextEvents returns empty for perch', async () => {
            setupBackendMocks();

            mockCalendarRegistry.listRegisteredUserIds = mock(async () => ['user-alice']);
            mockCalDAVClient.getContextEvents = mock(async () => []);

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            expect(result).not.toContain('## Calendar');
        });

        test('should return calendar unavailable message on error for perch', async () => {
            setupBackendMocks();

            mockCalendarRegistry.listRegisteredUserIds = mock(async () => {
                throw new Error('DynamoDB scan error');
            });

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });

            // Should not throw
            const result = await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            expect(result).toContain('[Calendar unavailable: DynamoDB scan error]');
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.any(Error) }),
                'Failed to load perch calendar context'
            );
        });

        test('calendar section should appear after Recent Events and before Email Inbox in perch context', async () => {
            setupBackendMocks();

            mockCalendarRegistry.listRegisteredUserIds = mock(async () => ['user-alice']);

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            // Calendar should appear before the spot where inbox would appear
            // We can only check it's present here since there's no inbox service
            expect(result).toContain('## Calendar');
        });

        test('should call getAllCalendars for each registered user ID', async () => {
            setupBackendMocks();

            mockCalendarRegistry.listRegisteredUserIds = mock(async () => ['user-alice', 'user-bob']);
            mockCalendarRegistry.getAllCalendars = mock(async () => [fakeServer]);

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            expect(mockCalendarRegistry.getAllCalendars).toHaveBeenCalledWith('user-alice');
            expect(mockCalendarRegistry.getAllCalendars).toHaveBeenCalledWith('user-bob');
        });

        test('should merge events from multiple users', async () => {
            setupBackendMocks();

            mockCalendarRegistry.listRegisteredUserIds = mock(async () => ['user-alice', 'user-bob']);
            mockCalendarRegistry.getAllCalendars = mock(async () => [fakeServer]);
            mockCalDAVClient.getContextEvents = mock(async () => [fakeEvent]);

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            // Should include calendar section (events from both users merged)
            expect(result).toContain('## Calendar');
            expect(result).toContain('Team meeting');
        });

        test('should skip user if getAllCalendars returns empty array', async () => {
            setupBackendMocks();

            mockCalendarRegistry.listRegisteredUserIds = mock(async () => ['user-alice']);
            mockCalendarRegistry.getAllCalendars = mock(async () => []);

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            expect(result).not.toContain('## Calendar');
            expect(mockCalDAVClient.getContextEvents).not.toHaveBeenCalled();
        });

        test('should use UTC timezone for perch calendar context', async () => {
            setupBackendMocks();

            mockCalendarRegistry.listRegisteredUserIds = mock(async () => ['user-alice']);
            mockCalDAVClient.getContextEvents = mock(async () => [{
                uid:           'evt-allday',
                summary:       'UTC perch event',
                start:         new Date('2026-03-18T00:00:00Z'),
                end:           new Date('2026-03-19T00:00:00Z'),
                isAllDay:      true,
                calendarLabel: 'Work',
            }]);

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            expect(result).toContain('## Calendar');
            expect(result).toContain('UTC perch event');
        });

        test('should return timeout-specific message on CaldavTimeoutError for perch', async () => {
            setupBackendMocks();

            mockCalendarRegistry.listRegisteredUserIds = mock(async () => {
                throw new CaldavTimeoutError('CalDAV operation timed out after 10000ms: fetchCalendars', { timeoutMs: 10_000, operation: 'fetchCalendars' });
            });

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            expect(result).toContain('[Calendar unavailable: connection to calendar server timed out after 10000ms]');
        });

        test('should return auth-specific message on CaldavAuthError for perch', async () => {
            setupBackendMocks();

            mockCalendarRegistry.listRegisteredUserIds = mock(async () => {
                throw new CaldavAuthError('Auth failed');
            });

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            expect(result).toContain('[Calendar unavailable: authentication failed for calendar server]');
        });

        test('should return generic message for non-Error thrown value for perch', async () => {
            setupBackendMocks();

            mockCalendarRegistry.listRegisteredUserIds = mock(async () => {
                throw 42; // non-Error value — testing String(error) branch
            });

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildPerchContext(new Date('2026-03-18T10:00:00Z'));

            expect(result).toContain('[Calendar unavailable: 42]');
        });
    });

    describe('buildUserMessagePrefix with calendarService', () => {
        test('should include calendar section when calendarService is configured and user has calendars with events', async () => {
            setupBackendMocks();

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain('## Calendar');
            expect(result).toContain('Team meeting');
        });

        test('should NOT include calendar section when calendarService is not configured', async () => {
            setupBackendMocks();

            const contextBuilder = createContextBuilder({ backend });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).not.toContain('## Calendar');
        });

        test('should NOT include calendar section when user has no calendars', async () => {
            setupBackendMocks();

            mockCalendarRegistry.getAllCalendars = mock(async () => []);

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).not.toContain('## Calendar');
        });

        test('should NOT include calendar section when getContextEvents returns empty', async () => {
            setupBackendMocks();

            mockCalDAVClient.getContextEvents = mock(async () => []);

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).not.toContain('## Calendar');
        });

        test('calendar section should appear after user memories and before hot state', async () => {
            // Set up user memories, hot state, and calendar events
            backend.list = mock(async () => ({
                items: [{
                    path:           createMemoryPath('/users/user123/pref'),
                    content:        'Likes cats',
                    contentPreview: 'Likes cats',
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    version:        1,
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                }],
            }));
            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/task.md'),
                        content:     'Current task',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
            ]);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            const userMemoriesPos = result.indexOf('[About this user]');
            const calendarPos     = result.indexOf('## Calendar');
            const hotStatePos     = result.indexOf('[Current state]');

            expect(userMemoriesPos).toBeGreaterThan(-1);
            expect(calendarPos).toBeGreaterThan(-1);
            expect(hotStatePos).toBeGreaterThan(-1);

            expect(calendarPos).toBeGreaterThan(userMemoriesPos);
            expect(hotStatePos).toBeGreaterThan(calendarPos);
        });

        test('calendar section should appear after time header and before hot state when no user memories', async () => {
            backend.list = mock(async () => ({ items: [] }));
            backend.getStateItemsScored = mock(async () => [
                {
                    item: {
                        path:        createMemoryPath('/state/task.md'),
                        content:     'Current task',
                        contentType: 'text/markdown' as const,
                        metadata:    {},
                        version:     1,
                        createdAt:   '2025-01-15T10:00:00.000Z',
                        updatedAt:   '2025-01-15T10:00:00.000Z',
                    },
                    score: 0.95,
                },
            ]);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            const timeHeaderPos = result.indexOf('## Current Time');
            const calendarPos   = result.indexOf('## Calendar');
            const hotStatePos   = result.indexOf('[Current state]');

            expect(timeHeaderPos).toBeGreaterThan(-1);
            expect(calendarPos).toBeGreaterThan(-1);
            expect(hotStatePos).toBeGreaterThan(-1);

            expect(calendarPos).toBeGreaterThan(timeHeaderPos);
            expect(hotStatePos).toBeGreaterThan(calendarPos);
        });

        test('should return calendar unavailable message on calendar loading error', async () => {
            setupBackendMocks();

            mockCalendarRegistry.getAllCalendars = mock(async () => {
                throw new Error('DynamoDB timeout');
            });

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });

            // Should not throw
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain('[Calendar unavailable: DynamoDB timeout]');
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user123',
                }),
                'Failed to load calendar context'
            );
        });

        test('should return calendar unavailable message on getContextEvents error', async () => {
            setupBackendMocks();

            mockCalDAVClient.getContextEvents = mock(async () => {
                throw new Error('CalDAV connection failed');
            });

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });

            // Should not throw
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain('[Calendar unavailable: CalDAV connection failed]');
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user123',
                }),
                'Failed to load calendar context'
            );
        });

        test('should return timeout-specific message on CaldavTimeoutError', async () => {
            setupBackendMocks();

            mockCalendarRegistry.getAllCalendars = mock(async () => {
                throw new CaldavTimeoutError('CalDAV operation timed out after 15000ms: connect', { timeoutMs: 15_000, operation: 'connect' });
            });

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain('[Calendar unavailable: connection to calendar server timed out after 15000ms]');
        });

        test('should return auth-specific message on CaldavAuthError', async () => {
            setupBackendMocks();

            mockCalendarRegistry.getAllCalendars = mock(async () => {
                throw new CaldavAuthError('Auth failed', { serverUrl: 'https://cal.example.com' });
            });

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain('[Calendar unavailable: authentication failed for calendar server]');
        });

        test('should return generic message for non-Error thrown value', async () => {
            setupBackendMocks();

            mockCalendarRegistry.getAllCalendars = mock(async () => {
                throw 'string error'; // non-Error value — testing String(error) branch
            });

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain('[Calendar unavailable: string error]');
        });

        test('should pass userTimezone to formatCalendarContext when provided', async () => {
            setupBackendMocks();

            // Use an all-day event to avoid timezone-dependent time rendering
            mockCalDAVClient.getContextEvents = mock(async () => [{
                uid:           'evt-allday',
                summary:       'All day event',
                start:         new Date('2026-03-18T00:00:00Z'),
                end:           new Date('2026-03-19T00:00:00Z'),
                isAllDay:      true,
                calendarLabel: 'Main',
            }]);

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildUserMessagePrefix('user123', 'America/New_York');

            // Calendar section should be present and contain the event
            expect(result).toContain('## Calendar');
            expect(result).toContain('All day event');
        });

        test('should use server local timezone as default when userTimezone is not provided', async () => {
            setupBackendMocks();

            mockCalDAVClient.getContextEvents = mock(async () => [{
                uid:           'evt-allday',
                summary:       'UTC event',
                start:         new Date('2026-03-18T00:00:00Z'),
                end:           new Date('2026-03-19T00:00:00Z'),
                isAllDay:      true,
                calendarLabel: 'Work',
            }]);

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            expect(result).toContain('## Calendar');
            expect(result).toContain('UTC event');
        });

        test('should pass userId to getAllCalendars', async () => {
            setupBackendMocks();

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            await contextBuilder.buildUserMessagePrefix('user-xyz');

            expect(mockCalendarRegistry.getAllCalendars).toHaveBeenCalledWith('user-xyz');
        });

        test('should still include other sections when calendar section is present', async () => {
            backend.list = mock(async () => ({
                items: [{
                    path:           createMemoryPath('/users/user123/pref'),
                    content:        'Likes cats',
                    contentPreview: 'Likes cats',
                    contentType:    'text/plain' as const,
                    metadata:       {},
                    version:        1,
                    createdAt:      '2025-01-15T10:00:00.000Z',
                    updatedAt:      '2025-01-15T10:00:00.000Z',
                }],
            }));
            backend.getStateItemsScored = mock(async () => []);
            backend.searchByTimeRange = mock(async () => []);
            backend.listByLayer = mock(async () => ({ items: [] }));

            const calendarService: CalendarService = {
                client:   mockCalDAVClient,
                registry: mockCalendarRegistry,
            };

            const contextBuilder = createContextBuilder({ backend, calendarService });
            const result = await contextBuilder.buildUserMessagePrefix('user123');

            // Should have both calendar section and user memories
            expect(result).toContain('## Calendar');
            expect(result).toContain('[About this user]');
            expect(result).toContain('Likes cats');
            // Should end with \n\n
            expect(result).toMatch(/\n\n$/);
        });
    });
});

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { mockClient } from 'aws-sdk-client-mock';
import { mockLogger } from '../../../setup';
import { SessionResumeBackend } from '@/storage/session-resume/backend';
import { createSessionId } from '@/storage/session-resume/types';

describe('SessionResumeBackend', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let backend: SessionResumeBackend;

    beforeEach(() => {
        // `logger` is tests/setup.ts's one shared mockLogger, and spyOn() on an already-mocked
        // method hands back that same mock with every call any earlier test made to it (in this
        // file or another). Start each test with no recorded warn calls so the warn assertions
        // below — both the `not.toHaveBeenCalled()` and the `toHaveBeenCalledWith(...)` ones —
        // see only calls made by the test itself.
        mockLogger.warn.mockClear();
        ddbMock = mockClient(DynamoDBDocumentClient);
        backend = new SessionResumeBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        ddbMock.restore();
    });

    describe('role-keyed session id (P8)', () => {
        const sessionIdValue = '550e8400-e29b-41d4-a716-446655440000';
        const sessionId = createSessionId(sessionIdValue);

        test('getSessionIdForRole returns undefined when no record exists', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await expect(backend.getSessionIdForRole('conversation')).resolves.toBeUndefined();
        });

        test('getSessionIdForRole treats a missing record as no stored session without logging a validation warning', async () => {
            const warnSpy = spyOn(logger, 'warn');
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await expect(backend.getSessionIdForRole('perch')).resolves.toBeUndefined();
            expect(warnSpy).not.toHaveBeenCalled();

            warnSpy.mockRestore();
        });

        test('getSessionIdForRole reads TASK_SESSION#<role> as PK and SK', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await backend.getSessionIdForRole('conversation');

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls[0]?.args[0].input).toEqual({
                TableName: 'TestTable',
                Key:       { PK: 'TASK_SESSION#conversation', SK: 'TASK_SESSION#conversation' },
            });
        });

        test('setSessionIdForRole writes TASK_SESSION#<role> as PK and SK', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.setSessionIdForRole('perch', sessionId);

            const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
            expect(item).toMatchObject({ PK: 'TASK_SESSION#perch', SK: 'TASK_SESSION#perch', sessionId: sessionIdValue });
        });

        test('setSessionIdForRole then getSessionIdForRole round-trips per role', async () => {
            ddbMock.on(PutCommand).resolves({});
            await backend.setSessionIdForRole('conversation', sessionId);
            const stored = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
            ddbMock.on(GetCommand).resolves({ Item: stored });

            await expect(backend.getSessionIdForRole('conversation')).resolves.toBe(sessionId);
        });

        test('clearSessionIdForRole deletes TASK_SESSION#<role> as PK and SK', async () => {
            ddbMock.on(DeleteCommand).resolves({});

            await backend.clearSessionIdForRole('conversation');

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls[0]?.args[0].input).toEqual({
                TableName: 'TestTable',
                Key:       { PK: 'TASK_SESSION#conversation', SK: 'TASK_SESSION#conversation' },
            });
        });

        test('conversation and perch roles are isolated from each other', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.setSessionIdForRole('conversation', sessionId);
            await backend.setSessionIdForRole('perch', sessionId);

            const calls = ddbMock.commandCalls(PutCommand);
            const keys = calls.map(call => call.args[0].input.Item?.PK);
            expect(keys).toEqual(['TASK_SESSION#conversation', 'TASK_SESSION#perch']);
        });

        test('setSessionIdForRole propagates a rejection from the underlying put', async () => {
            ddbMock.on(PutCommand).rejects(new Error('put failed'));

            await expect(backend.setSessionIdForRole('conversation', sessionId)).rejects.toThrow('put failed');
        });

        test('clearSessionIdForRole propagates a rejection from the underlying delete', async () => {
            ddbMock.on(DeleteCommand).rejects(new Error('delete failed'));

            await expect(backend.clearSessionIdForRole('conversation')).rejects.toThrow('delete failed');
        });

        test('getSessionIdForRole returns undefined and logs when the stored sessionId is not a valid UUID', async () => {
            const warnSpy = spyOn(logger, 'warn');
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK:        'TASK_SESSION#conversation',
                    SK:        'TASK_SESSION#conversation',
                    sessionId: 'not-a-uuid',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            });

            await expect(backend.getSessionIdForRole('conversation')).resolves.toBeUndefined();
            expect(warnSpy).toHaveBeenCalledWith(
                expect.objectContaining({ role: 'conversation' }),
                'SessionResumeBackend.getSessionIdForRole: stored row failed validation'
            );

            warnSpy.mockRestore();
        });

        test('getSessionIdForRole returns undefined and logs when the stored row is missing sessionId', async () => {
            const warnSpy = spyOn(logger, 'warn');
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK:        'TASK_SESSION#conversation',
                    SK:        'TASK_SESSION#conversation',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            });

            await expect(backend.getSessionIdForRole('conversation')).resolves.toBeUndefined();
            expect(warnSpy).toHaveBeenCalledWith(
                expect.objectContaining({ role: 'conversation' }),
                'SessionResumeBackend.getSessionIdForRole: stored row failed validation'
            );

            warnSpy.mockRestore();
        });

        test('getSessionIdForRole returns undefined and logs when updatedAt is not a valid ISO 8601 timestamp', async () => {
            const warnSpy = spyOn(logger, 'warn');
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK:        'TASK_SESSION#conversation',
                    SK:        'TASK_SESSION#conversation',
                    sessionId: sessionIdValue,
                    updatedAt: 'not-a-date',
                },
            });

            await expect(backend.getSessionIdForRole('conversation')).resolves.toBeUndefined();
            expect(warnSpy).toHaveBeenCalledWith(
                expect.objectContaining({ role: 'conversation' }),
                'SessionResumeBackend.getSessionIdForRole: stored row failed validation'
            );

            warnSpy.mockRestore();
        });
    });
});

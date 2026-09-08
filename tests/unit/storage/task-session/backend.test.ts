import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { TaskSessionBackend } from '@/storage/task-session/backend';
import { createSessionId } from '@/storage/task-session/types';

describe('TaskSessionBackend', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let backend: TaskSessionBackend;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);
        backend = new TaskSessionBackend(
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
    });
});

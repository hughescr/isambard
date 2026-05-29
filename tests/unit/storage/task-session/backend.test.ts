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

    describe('getCurrentSessionId', () => {
        test('should return undefined when no record exists', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            const result = await backend.getCurrentSessionId();

            expect(result).toBeUndefined();
        });

        test('should return SessionId when record exists', async () => {
            const sessionIdValue = '550e8400-e29b-41d4-a716-446655440000';
            const expectedSessionId = createSessionId(sessionIdValue);
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK:        'TASK_SESSION#CURRENT',
                    SK:        'TASK_SESSION#CURRENT',
                    sessionId: sessionIdValue,
                    updatedAt: '2024-01-15T10:30:00.000Z',
                },
            });

            const result = await backend.getCurrentSessionId();

            expect(result).toBe(expectedSessionId);
        });

        test('should call GetCommand with singleton key', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            await backend.getCurrentSessionId();

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Key:       {
                    PK: 'TASK_SESSION#CURRENT',
                    SK: 'TASK_SESSION#CURRENT',
                },
            });
        });

        test('should throw error if sessionId in DB is invalid UUID', () => {
            ddbMock.on(GetCommand).resolves({
                Item: {
                    PK:        'TASK_SESSION#CURRENT',
                    SK:        'TASK_SESSION#CURRENT',
                    sessionId: 'not-a-uuid',
                    updatedAt: '2024-01-15T10:30:00.000Z',
                },
            });

            expect(backend.getCurrentSessionId()).rejects.toThrow();
        });
    });

    describe('setCurrentSessionId', () => {
        test('should store session ID with correct structure', async () => {
            const sessionIdValue = '550e8400-e29b-41d4-a716-446655440000';
            const sessionId = createSessionId(sessionIdValue);
            ddbMock.on(PutCommand).resolves({});

            await backend.setCurrentSessionId(sessionId);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item;
            expect(item).toMatchObject({
                PK:        'TASK_SESSION#CURRENT',
                SK:        'TASK_SESSION#CURRENT',
                sessionId: sessionIdValue,
            });
            expect(item).toHaveProperty('updatedAt');
            expect(typeof item?.updatedAt).toBe('string');
        });

        test('should use singleton key pattern', async () => {
            const sessionIdValue = '550e8400-e29b-41d4-a716-446655440000';
            const sessionId = createSessionId(sessionIdValue);
            ddbMock.on(PutCommand).resolves({});

            await backend.setCurrentSessionId(sessionId);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls[0].args[0].input.TableName).toBe('TestTable');
            expect(calls[0].args[0].input.Item?.PK).toBe('TASK_SESSION#CURRENT');
            expect(calls[0].args[0].input.Item?.SK).toBe('TASK_SESSION#CURRENT');
        });

        test('should update updatedAt timestamp on subsequent calls', async () => {
            const sessionIdValue = '550e8400-e29b-41d4-a716-446655440000';
            const sessionId = createSessionId(sessionIdValue);
            ddbMock.on(PutCommand).resolves({});

            await backend.setCurrentSessionId(sessionId);
            await backend.setCurrentSessionId(sessionId);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(2);
            expect(calls[0].args[0].input.Item?.updatedAt).toBeDefined();
            expect(calls[1].args[0].input.Item?.updatedAt).toBeDefined();
        });
    });

    describe('clearCurrentSessionId', () => {
        test('should call DeleteCommand with singleton key', async () => {
            ddbMock.on(DeleteCommand).resolves({});

            await backend.clearCurrentSessionId();

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Key:       {
                    PK: 'TASK_SESSION#CURRENT',
                    SK: 'TASK_SESSION#CURRENT',
                },
            });
        });

        test('should succeed even if no record exists', () => {
            ddbMock.on(DeleteCommand).resolves({});

            expect(backend.clearCurrentSessionId()).resolves.toBeUndefined();
        });
    });
});

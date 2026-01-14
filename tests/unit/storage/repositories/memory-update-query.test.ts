import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { assign as _assign, keys as _keys } from 'lodash';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { MemoryRepository } from '@/storage/repositories/memory';
import { ItemNotFoundError, ConflictError, ValidationError } from '@/storage/errors';
import type { MemoryItem } from '@/storage/models/memory';

describe.concurrent('MemoryRepository', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let repository: MemoryRepository;

    beforeEach(() => {
        ddbMock.reset();
        repository = new MemoryRepository(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        ddbMock.reset();
    });

    describe('update', () => {
        const testId = '550e8400-e29b-41d4-a716-446655440001';
        const existingItem: MemoryItem = {
            PK:          `MEMORY#${testId}`,
            SK:          'TYPE#identity',
            GSI1PK:      'TYPE#identity',
            GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
            id:          testId,
            memory_type: 'identity',
            content:     'Original content',
            metadata:    {},
            version:     0,
            createdAt:   '2024-01-01T00:00:00.000Z',
            updatedAt:   '2024-01-01T00:00:00.000Z',
        };

        test('should update memory with new timestamp and version', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            const before = new Date().toISOString();
            const result = await repository.update(testId, 'identity', {
                content: 'Updated content',
            });

            expect(result.content).toBe('Updated content');
            expect(result.updatedAt >= before).toBe(true);
            expect(result.createdAt).toBe('2024-01-01T00:00:00.000Z'); // unchanged
            expect(result.version).toBe(1);
        });

        test('should throw ItemNotFoundError if memory does not exist', async () => {
            ddbMock.on(GetCommand).resolves({ Item: undefined });

            expect(
                repository.update('550e8400-e29b-41d4-a716-446655440002', 'identity', { content: 'New' })
            ).rejects.toThrow(ItemNotFoundError);
        });

        test('should throw ConflictError on concurrent update (version mismatch)', async () => {
            // Setup: First GetCommand returns version 0, second returns version 5
            ddbMock.on(GetCommand)
                .resolvesOnce({ Item: existingItem })
                .resolvesOnce({ Item: { ...existingItem, version: 5 } });

            // Put fails with ConditionalCheckFailedException
            const conditionalError = new Error('Conditional check failed');
            _assign(conditionalError, { name: 'ConditionalCheckFailedException' });
            ddbMock.on(PutCommand).rejectsOnce(conditionalError);

            expect(
                repository.update(testId, 'identity', { content: 'Updated' })
            ).rejects.toThrow(ConflictError);
        });

        test('should use correct PutCommand parameters', async () => {
            ddbMock.on(GetCommand).resolves({ Item: existingItem });
            ddbMock.on(PutCommand).resolves({});

            await repository.update(testId, 'identity', {
                content: 'Updated content',
            });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const input = calls[0].args[0].input;

            // Verify all PutCommand parameters in one test
            expect(input.TableName).toBe('TestTable');
            expect(input.ConditionExpression).toBe('#version = :expectedVersion');
            expect(input.ExpressionAttributeNames).toEqual({ '#version': 'version' });
            expect(input.ExpressionAttributeValues).toEqual({ ':expectedVersion': 0 });

            // Verify business data and DynamoDB keys are merged
            const item = input.Item as MemoryItem;
            expect(item.id).toBe(testId);
            expect(item.content).toBe('Updated content');
            expect(item.memory_type).toBe('identity');
            expect(item.version).toBe(1);
            expect(item.PK).toBe(`MEMORY#${testId}`);
            expect(item.SK).toBe('TYPE#identity');
            expect(item.GSI1PK).toBe('TYPE#identity');
            expect(item.GSI1SK).toBeDefined();
        });

        describe('optional field conditionals', () => {
            const itemWithAllFields: MemoryItem = {
                PK:          `MEMORY#${testId}`,
                SK:          'TYPE#identity',
                GSI1PK:      'TYPE#identity',
                GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                id:          testId,
                memory_type: 'identity',
                content:     'Original content',
                metadata:    { key: 'original' },
                TTL:         1000,
                version:     0,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            };

            test.each([
                ['content only', { content: 'New content' }, { content: 'New content', metadata: { key: 'original' }, TTL: 1000 }],
                ['metadata only', { metadata: { key: 'new' } }, { content: 'Original content', metadata: { key: 'new' }, TTL: 1000 }],
                ['TTL only', { TTL: 2000 }, { content: 'Original content', metadata: { key: 'original' }, TTL: 2000 }],
                ['all fields', { content: 'New content', metadata: { key: 'new' }, TTL: 2000 }, { content: 'New content', metadata: { key: 'new' }, TTL: 2000 }],
                ['empty update', {}, { content: 'Original content', metadata: { key: 'original' }, TTL: 1000 }],
            ])('should update %s correctly', async (_label, updateData, expected) => {
                ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', updateData);

                expect(result.content).toBe(expected.content);
                expect(result.metadata).toEqual(expected.metadata);
                expect(result.TTL).toBe(expected.TTL);
                if(_keys(updateData).length > 0) {
                    expect(result.version).toBe(1); // version always increments on update
                }
            });

            test.each([
                ['content undefined', { content: undefined }, 'Original content'],
                ['metadata undefined', { metadata: undefined }, { key: 'original' }],
                ['TTL undefined', { TTL: undefined }, 1000],
            ])('should NOT update when %s', async (_label, updateData, expectedValue) => {
                ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', updateData);

                const field = _keys(updateData)[0] as 'content' | 'metadata' | 'TTL';

                const actualValue = result[field];
                expect(actualValue).toEqual(expectedValue);
            });

            test('should allow clearing metadata to empty object', async () => {
                ddbMock.on(GetCommand).resolves({ Item: itemWithAllFields });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    metadata: {},
                });

                expect(result.metadata).toEqual({}); // changed to empty
            });

            test.each([
                ['existing TTL', { ...existingItem, TTL: 5000 }, 5000],
                ['absent TTL', existingItem, undefined],
            ])('should preserve %s when not updating TTL', async (_label, item, expectedTTL) => {
                ddbMock.on(GetCommand).resolves({ Item: item });
                ddbMock.on(PutCommand).resolves({});

                const result = await repository.update(testId, 'identity', {
                    content: 'New content',
                });

                expect(result.TTL).toBe(expectedTTL);
            });
        });

        describe('error handling', () => {
            test('should throw ValidationError with Zod issues when validation fails', async () => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });

                // Invalid content - empty string
                const error = await repository.update(testId, 'identity', { content: '' }).catch((e: unknown) => e);
                expect(error).toBeInstanceOf(ValidationError);
                expect((error as ValidationError).issues).toBeDefined();
                // eslint-disable-next-line lodash/prefer-lodash-method -- Native Array.isArray is idiomatic
                expect(Array.isArray((error as ValidationError).issues)).toBe(true);
            });

            test('should include correct version info in ConflictError', async () => {
                const itemWithVersion3 = { ...existingItem, version: 3 };
                ddbMock.on(GetCommand)
                    .resolvesOnce({ Item: itemWithVersion3 })
                    .resolvesOnce({ Item: { ...itemWithVersion3, version: 7 } });

                const conditionalError = new Error('Conditional check failed');
                _assign(conditionalError, { name: 'ConditionalCheckFailedException' });
                ddbMock.on(PutCommand).rejectsOnce(conditionalError);

                const error = await repository.update(testId, 'identity', { content: 'Updated' }).catch((e: unknown) => e);
                expect(error).toBeInstanceOf(ConflictError);
                expect((error as ConflictError).expectedVersion).toBe(3);
                expect((error as ConflictError).actualVersion).toBe(7);
            });

            test('should use version -1 in ConflictError when current item is undefined', async () => {
                ddbMock.on(GetCommand)
                    .resolvesOnce({ Item: existingItem })
                    .resolvesOnce({ Item: undefined });

                const conditionalError = new Error('Conditional check failed');
                _assign(conditionalError, { name: 'ConditionalCheckFailedException' });
                ddbMock.on(PutCommand).rejectsOnce(conditionalError);

                const error = await repository.update(testId, 'identity', { content: 'Updated' }).catch((e: unknown) => e);
                expect(error).toBeInstanceOf(ConflictError);
                expect((error as ConflictError).actualVersion).toBe(-1);
            });

            test.each([
                ['network error', { name: 'NetworkingError' }],
                ['different error name', { name: 'ConditionalCheckFailedExceptionTypo' }],
            ])('should re-throw non-ConditionalCheckFailed errors: %s', async (_label, errorProps) => {
                ddbMock.on(GetCommand).resolves({ Item: existingItem });

                const otherError = new Error('Other error');
                _assign(otherError, errorProps);
                ddbMock.on(PutCommand).rejectsOnce(otherError);

                // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
                await expect(repository.update(testId, 'identity', { content: 'Updated' })).rejects.toBe(otherError);
            });

            // Tests to kill remaining mutants at line 122
            // These tests use spyOn to directly mock docClient.send(), bypassing aws-sdk-client-mock normalization

            test.each([
                ['primitive undefined', undefined],
                ['primitive number', 42],
                ['object without name', { foo: 'bar' }],
                ['object with wrong name', { name: 'DifferentError', message: 'Wrong error' }],
            ])('should re-throw when error is %s', async (_label, throwValue) => {
                // Spy on docClient.send to intercept both GetCommand and PutCommand
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/dot-notation -- Need private access and any type to bypass mock library error normalization
                const sendSpy = spyOn(repository['docClient'] as any, 'send');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Command can be any DynamoDB command type
                sendSpy.mockImplementation((command: any) => {
                    if(command instanceof GetCommand) {
                        return Promise.resolve({ Item: existingItem });
                    }
                    if(command instanceof PutCommand) {
                        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Intentionally testing behavior when non-Error values are thrown
                        throw throwValue;
                    }
                    return Promise.resolve({});
                });

                // Should re-throw value as-is
                // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects returns a promise
                await expect(repository.update(testId, 'identity', { content: 'Updated' })).rejects.toBe(throwValue);

                sendSpy.mockRestore();
            });
        });
    });

    describe('queryByType', () => {
        test('should query with correct parameters and return memories', async () => {
            const testId = '550e8400-e29b-41d4-a716-446655440006';
            const items: MemoryItem[] = [
                {
                    PK:          `MEMORY#${testId}`, SK:          'TYPE#identity', GSI1PK:      'TYPE#identity',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    id:          testId, memory_type: 'identity', content:     'First',
                    metadata:    {}, version:     0,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await repository.queryByType('identity', { limit: 10 });

            expect(result.items).toHaveLength(1);
            expect(result.items[0].content).toBe('First');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.IndexName).toBe('GSI1');
            expect(calls[0].args[0].input.ExpressionAttributeValues?.[':pk']).toBe('TYPE#identity');
            expect(calls[0].args[0].input.KeyConditionExpression).toBe('GSI1PK = :pk');
            expect(calls[0].args[0].input.ScanIndexForward).toBe(false);
            expect(calls[0].args[0].input.Limit).toBe(10);
        });

        test('should strip DynamoDB keys from returned items', async () => {
            const testId = '550e8400-e29b-41d4-a716-446655440008';
            const items: MemoryItem[] = [
                {
                    PK:          `MEMORY#${testId}`, SK:          'TYPE#identity', GSI1PK:      'TYPE#identity',
                    GSI1SK:      'CREATED#2024-01-01T00:00:00.000Z',
                    id:          testId, memory_type: 'identity', content:     'Test',
                    metadata:    {}, version:     0,
                    createdAt:   '2024-01-01T00:00:00.000Z',
                    updatedAt:   '2024-01-01T00:00:00.000Z',
                },
            ];
            ddbMock.on(QueryCommand).resolves({ Items: items });

            const result = await repository.queryByType('identity');

            expect(result.items[0]).not.toHaveProperty('PK');
            expect(result.items[0]).not.toHaveProperty('GSI1PK');
        });

        test.each([
            ['with cursor', true, true],
            ['without cursor', false, false],
        ])('should handle cursor pagination %s', async (_label, provideCursor, expectStartKey) => {
            const testId = '550e8400-e29b-41d4-a716-446655440009';
            const lastEvaluatedKey = { PK: `MEMORY#${testId}`, SK: 'TYPE#identity' };
            const cursor = provideCursor ? Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64') : undefined;

            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await repository.queryByType('identity', cursor ? { cursor } : {});

            const calls = ddbMock.commandCalls(QueryCommand);
            if(expectStartKey) {
                expect(calls[0].args[0].input.ExclusiveStartKey).toEqual(lastEvaluatedKey);
            } else {
                expect(calls[0].args[0].input.ExclusiveStartKey).toBeUndefined();
            }
        });

        test.each([
            ['with LastEvaluatedKey', { PK: 'MEMORY#test', SK: 'TYPE#event' }, true],
            ['without LastEvaluatedKey', undefined, false],
        ])('should return nextCursor %s', async (_label, lastEvaluatedKey, expectCursor) => {
            ddbMock.on(QueryCommand).resolves({
                Items:            [],
                LastEvaluatedKey: lastEvaluatedKey,
            });

            const result = await repository.queryByType('event');

            if(expectCursor) {
                expect(result.nextCursor).toBeDefined();
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Decoding cursor from JSON
                const decodedCursor = JSON.parse(
                    Buffer.from(result.nextCursor!, 'base64').toString('utf-8')
                );
                expect(decodedCursor).toEqual(lastEvaluatedKey);
            } else {
                expect(result.nextCursor).toBeUndefined();
            }
        });

        test('should handle cursor pagination round-trip correctly', async () => {
            const testId = '550e8400-e29b-41d4-a716-446655440011';
            const firstPageKey = { PK: `MEMORY#${testId}`, SK: 'TYPE#identity' };

            // Reset mock to control responses
            ddbMock.reset();

            // First query returns a nextCursor
            ddbMock.on(QueryCommand)
                .resolvesOnce({
                    Items:            [],
                    LastEvaluatedKey: firstPageKey,
                })
                .resolvesOnce({ Items: [] });

            const firstResult = await repository.queryByType('identity');
            const cursor = firstResult.nextCursor!;

            // Second query uses that cursor
            await repository.queryByType('identity', { cursor });

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls.length).toBe(2);
            expect(calls[1].args[0].input.ExclusiveStartKey).toEqual(firstPageKey);
        });
    });
});

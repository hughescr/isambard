import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { createDynamoDBMemoryHandlers, createMemoryTool } from '@/agent/claude';
import * as handlers from '@/storage/memory-tool/handlers';

describe('createDynamoDBMemoryHandlers', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    const tableName = 'TestMemoryTable';

    beforeEach(() => {
        ddbMock.reset();
    });

    it('should return an object with all 6 handler methods', () => {
        const memoryHandlers = createDynamoDBMemoryHandlers(
            ddbMock as unknown as DynamoDBDocumentClient,
            tableName
        );

        expect(memoryHandlers).toHaveProperty('view');
        expect(memoryHandlers).toHaveProperty('create');
        expect(memoryHandlers).toHaveProperty('str_replace');
        expect(memoryHandlers).toHaveProperty('insert');
        expect(memoryHandlers).toHaveProperty('delete');
        expect(memoryHandlers).toHaveProperty('rename');
    });

    it('should return functions for each handler', () => {
        const memoryHandlers = createDynamoDBMemoryHandlers(
            ddbMock as unknown as DynamoDBDocumentClient,
            tableName
        );

        expect(typeof memoryHandlers.view).toBe('function');
        expect(typeof memoryHandlers.create).toBe('function');
        expect(typeof memoryHandlers.str_replace).toBe('function');
        expect(typeof memoryHandlers.insert).toBe('function');
        expect(typeof memoryHandlers.delete).toBe('function');
        expect(typeof memoryHandlers.rename).toBe('function');
    });

    it('should create handlers with the correct backend instance', () => {
        const memoryHandlers = createDynamoDBMemoryHandlers(
            ddbMock as unknown as DynamoDBDocumentClient,
            tableName
        );

        // Verify handlers are callable (basic smoke test)
        expect(memoryHandlers.view).toBeDefined();
        expect(memoryHandlers.create).toBeDefined();
    });

    describe('view handler', () => {
        it('should convert view_range array to tuple when provided', async () => {
            // Spy on the view handler function
            const viewSpy = spyOn(handlers, 'view').mockResolvedValue('mocked content');

            const memoryHandlers = createDynamoDBMemoryHandlers(
                ddbMock as unknown as DynamoDBDocumentClient,
                tableName
            );

            await memoryHandlers.view({
                command:    'view',
                path:       '/memories/test.xml',
                view_range: [1, 10]
            });

            // Verify the handler was called with the correct parameters
            expect(viewSpy).toHaveBeenCalledTimes(1);
            const call = viewSpy.mock.calls[0];
            expect(call[1]).toEqual({
                path:       '/memories/test.xml',
                view_range: [1, 10]
            });

            viewSpy.mockRestore();
        });

        it('should pass undefined view_range when not provided', async () => {
            const viewSpy = spyOn(handlers, 'view').mockResolvedValue('mocked content');

            const memoryHandlers = createDynamoDBMemoryHandlers(
                ddbMock as unknown as DynamoDBDocumentClient,
                tableName
            );

            await memoryHandlers.view({
                command: 'view',
                path:    '/memories/test.xml'
            });

            expect(viewSpy).toHaveBeenCalledTimes(1);
            const call = viewSpy.mock.calls[0];
            expect(call[1]).toEqual({
                path:       '/memories/test.xml',
                view_range: undefined
            });

            viewSpy.mockRestore();
        });

        it('should use the backend when calling view', async () => {
            // Setup DynamoDB mock to return a memory item
            ddbMock.on(GetCommand).resolves({
                Item: {
                    path:        '/memories/test.xml',
                    content:     'line1\nline2\nline3',
                    contentType: 'text/plain',
                    createdAt:   new Date().toISOString(),
                    updatedAt:   new Date().toISOString()
                }
            });

            const memoryHandlers = createDynamoDBMemoryHandlers(
                ddbMock as unknown as DynamoDBDocumentClient,
                tableName
            );

            const result = await memoryHandlers.view({
                command: 'view',
                path:    '/memories/test.xml'
            });

            // Verify the result is formatted with line numbers
            expect(result).toContain('1:line1');
            expect(result).toContain('2:line2');
            expect(result).toContain('3:line3');
        });
    });

    describe('rename handler', () => {
        it('should map old_path to path in rename', async () => {
            const renameSpy = spyOn(handlers, 'rename').mockResolvedValue('renamed successfully');

            const memoryHandlers = createDynamoDBMemoryHandlers(
                ddbMock as unknown as DynamoDBDocumentClient,
                tableName
            );

            await memoryHandlers.rename({
                command:  'rename',
                old_path: '/memories/old.xml',
                new_path: '/memories/new.xml'
            });

            expect(renameSpy).toHaveBeenCalledTimes(1);
            const call = renameSpy.mock.calls[0];
            // Verify parameter mapping: old_path -> path
            expect(call[1]).toEqual({
                path:     '/memories/old.xml',
                new_path: '/memories/new.xml'
            });

            renameSpy.mockRestore();
        });

        it('should use the backend when calling rename', async () => {
            // Setup mocks for rename operation (get source exists, dest doesn't exist, create dest, delete source)
            ddbMock.on(GetCommand)
                .resolvesOnce({
                    Item: {
                        path:        '/memories/old.xml',
                        content:     'test content',
                        contentType: 'text/plain',
                        createdAt:   new Date().toISOString(),
                        updatedAt:   new Date().toISOString()
                    }
                })
                .resolvesOnce({ Item: undefined }); // Destination doesn't exist
            ddbMock.on(PutCommand).resolves({});
            ddbMock.on(DeleteCommand).resolves({});

            const memoryHandlers = createDynamoDBMemoryHandlers(
                ddbMock as unknown as DynamoDBDocumentClient,
                tableName
            );

            const result = await memoryHandlers.rename({
                command:  'rename',
                old_path: '/memories/old.xml',
                new_path: '/memories/new.xml'
            });

            expect(result).toContain('renamed');
            expect(result).toContain('/memories/old.xml');
            expect(result).toContain('/memories/new.xml');
        });
    });

    describe('create handler', () => {
        it('should use the backend when calling create', async () => {
            const createSpy = spyOn(handlers, 'create').mockResolvedValue('created successfully');

            const memoryHandlers = createDynamoDBMemoryHandlers(
                ddbMock as unknown as DynamoDBDocumentClient,
                tableName
            );

            await memoryHandlers.create({
                command:   'create',
                path:      '/memories/new.xml',
                file_text: 'new content'
            });

            expect(createSpy).toHaveBeenCalledTimes(1);
            const call = createSpy.mock.calls[0];
            expect(call[1]).toMatchObject({
                path:      '/memories/new.xml',
                file_text: 'new content'
            });

            createSpy.mockRestore();
        });
    });

    describe('str_replace handler', () => {
        it('should use the backend when calling str_replace', async () => {
            const strReplaceSpy = spyOn(handlers, 'str_replace').mockResolvedValue('replaced successfully');

            const memoryHandlers = createDynamoDBMemoryHandlers(
                ddbMock as unknown as DynamoDBDocumentClient,
                tableName
            );

            await memoryHandlers.str_replace({
                command: 'str_replace',
                path:    '/memories/test.xml',
                old_str: 'old text',
                new_str: 'new text'
            });

            expect(strReplaceSpy).toHaveBeenCalledTimes(1);
            const call = strReplaceSpy.mock.calls[0];
            expect(call[1]).toMatchObject({
                path:    '/memories/test.xml',
                old_str: 'old text',
                new_str: 'new text'
            });

            strReplaceSpy.mockRestore();
        });
    });

    describe('insert handler', () => {
        it('should use the backend when calling insert', async () => {
            const insertSpy = spyOn(handlers, 'insert').mockResolvedValue('inserted successfully');

            const memoryHandlers = createDynamoDBMemoryHandlers(
                ddbMock as unknown as DynamoDBDocumentClient,
                tableName
            );

            await memoryHandlers.insert({
                command:     'insert',
                path:        '/memories/test.xml',
                insert_line: 5,
                insert_text: 'new line'
            });

            expect(insertSpy).toHaveBeenCalledTimes(1);
            const call = insertSpy.mock.calls[0];
            expect(call[1]).toMatchObject({
                path:        '/memories/test.xml',
                insert_line: 5,
                insert_text: 'new line'
            });

            insertSpy.mockRestore();
        });
    });

    describe('delete handler', () => {
        it('should use the backend when calling delete', async () => {
            const deleteSpy = spyOn(handlers, 'delete_memory').mockResolvedValue('deleted successfully');

            const memoryHandlers = createDynamoDBMemoryHandlers(
                ddbMock as unknown as DynamoDBDocumentClient,
                tableName
            );

            await memoryHandlers.delete({
                command: 'delete',
                path:    '/memories/test.xml'
            });

            expect(deleteSpy).toHaveBeenCalledTimes(1);
            const call = deleteSpy.mock.calls[0];
            expect(call[1]).toMatchObject({
                path: '/memories/test.xml'
            });

            deleteSpy.mockRestore();
        });
    });
});

describe('createMemoryTool', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    const tableName = 'TestMemoryTable';

    beforeEach(() => {
        ddbMock.reset();
    });

    it('should return a memory tool object', () => {
        const tool = createMemoryTool(
            ddbMock as unknown as DynamoDBDocumentClient,
            tableName
        );

        expect(tool).toBeDefined();
        expect(typeof tool).toBe('object');
    });

    it('should return an object with tool properties', () => {
        const tool = createMemoryTool(
            ddbMock as unknown as DynamoDBDocumentClient,
            tableName
        );

        // betaMemoryTool should return an object with at minimum a type or name property
        // The exact structure depends on the SDK, but it should be an object
        expect(tool).toHaveProperty('type');
    });

    it('should create tool with DynamoDB-backed handlers', () => {
        const tool = createMemoryTool(
            ddbMock as unknown as DynamoDBDocumentClient,
            tableName
        );

        // Verify the tool was created (basic smoke test)
        expect(tool).toBeTruthy();
    });
});

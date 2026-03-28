import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createContactsMCPServer, type ContactChangeRequest } from '../../../src/agent/contacts-mcp-server';
import type { Contact, ContactId } from '../../../src/storage/contacts';
import { textContent } from '../../setup';

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: { shape: Record<string, unknown> }
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool>, server: { _serverInfo: { version: string } } }

// Helper to build test contacts
const makeContact = (overrides: Partial<Contact> = {}): Contact => ({
    personId:    'alice-wonderland' as ContactId,
    displayName: 'Alice Wonderland',
    identifiers: [
        { platform: 'email', value: 'alice@example.com' },
        { platform: 'bsky',  value: 'alice.bsky.social' },
    ],
    notes:     'Test contact',
    _internal: { discordUserId: '123456789', bskyDid: 'did:plc:abc123' },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    ...overrides,
});

interface MockBackend {
    getContact:        ReturnType<typeof mock>
    putContact:        ReturnType<typeof mock>
    deleteContact:     ReturnType<typeof mock>
    resolveIdentifier: ReturnType<typeof mock>
    addIdentifier:     ReturnType<typeof mock>
    removeIdentifier:  ReturnType<typeof mock>
    listContacts:      ReturnType<typeof mock>
    fuzzyLookup:       ReturnType<typeof mock>
}

/** Cast mock backend to the ContactBackend interface type for server creation. */
function asBackend(b: MockBackend): Parameters<typeof createContactsMCPServer>[0]['backend'] {
    return b as unknown as Parameters<typeof createContactsMCPServer>[0]['backend'];
}

describe.concurrent('createContactsMCPServer', () => {
    let mockBackend: MockBackend;

    beforeEach(() => {
        mockBackend = {
            getContact:        mock(async (): Promise<Contact | undefined> => makeContact()),
            putContact:        mock(async (): Promise<void> => { /* intentionally empty */ }),
            deleteContact:     mock(async (): Promise<void> => { /* intentionally empty */ }),
            resolveIdentifier: mock(async (): Promise<Contact[]> => [makeContact()]),
            addIdentifier:     mock(async (): Promise<void> => { /* intentionally empty */ }),
            removeIdentifier:  mock(async (): Promise<void> => { /* intentionally empty */ }),
            listContacts:      mock(async (): Promise<Contact[]> => [makeContact()]),
            fuzzyLookup:       mock(async (): Promise<Contact[]> => [makeContact()]),
        };
    });

    // Helper to get tool handler
    const getToolHandler = (server: ReturnType<typeof createContactsMCPServer>, toolName: string): ((...args: unknown[]) => Promise<CallToolResult>) => {
        return (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName].handler;
    };

    describe('server creation', () => {
        test('should create MCP server with correct properties', () => {
            const server = createContactsMCPServer({ backend: asBackend(mockBackend) });

            expect(server).toBeDefined();
            expect(server.name).toBe('contacts');
            expect(server.instance).toBeDefined();
            expect(server.type).toBe('sdk');
            expect((server.instance as unknown as RegisteredToolInstance).server._serverInfo.version).toBe('1.0.0');
        });

        test.each([
            ['lookupContact',         'Look up contacts by any identifier: name, email, handle, nickname, etc. Returns ranked results.'],
            ['lookupContactId',       'Get the identifier value(s) for a specific contact on a given platform (e.g., their email address or Bluesky handle).'],
            ['requestContactCreate',  'Request creation of a new contact. Requires admin approval before the contact is saved.'],
            ['requestContactUpdate',  'Request an update to an existing contact. Requires admin approval before changes are saved.'],
            ['listContacts',          'List all known contacts in the address book.'],
        ])('should have %s tool with correct description', (toolName, expectedDescription) => {
            const server = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(registeredTool.description).toBe(expectedDescription);
        });

        test.each([
            ['lookupContact',        ['query']],
            ['lookupContactId',      ['personId', 'platform']],
            ['requestContactCreate', ['displayName', 'identifiers', 'notes']],
            ['requestContactUpdate', ['personId', 'addIdentifiers', 'removeIdentifiers', 'notes']],
        ])('should have %s tool with correct input schema fields', (toolName, expectedFields) => {
            const server = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            for(const field of expectedFields) {
                expect(registeredTool.inputSchema.shape[field]).toBeDefined();
            }
        });
    });

    describe('lookupContact tool', () => {
        test('should return matching contacts as JSON with _internal stripped', async () => {
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'lookupContact');

            const result = await handler({ query: 'alice' });

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as { displayName: string, personId: string, _internal?: unknown }[];
            expect(parsed).toHaveLength(1);
            expect(parsed[0].displayName).toBe('Alice Wonderland');
            expect(parsed[0].personId).toBe('alice-wonderland');
            // _internal must be stripped
            expect(parsed[0]._internal).toBeUndefined();
            expect(mockBackend.fuzzyLookup).toHaveBeenCalledWith('alice');
        });

        test('should return text message when no contacts found', async () => {
            mockBackend.fuzzyLookup.mockImplementation(async () => []);
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'lookupContact');

            const result = await handler({ query: 'nobody' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('No contacts found matching that query.');
        });

        test('should return error result when backend throws', async () => {
            mockBackend.fuzzyLookup.mockImplementation(async () => {
                throw new Error('DynamoDB error');
            });
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'lookupContact');

            const result = await handler({ query: 'alice' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('DynamoDB error');
        });
    });

    describe('lookupContactId tool', () => {
        test('should return matching identifier values for the platform', async () => {
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'lookupContactId');

            const result = await handler({ personId: 'alice-wonderland', platform: 'email' });

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as { personId: string, platform: string, values: string[] };
            expect(parsed.personId).toBe('alice-wonderland');
            expect(parsed.platform).toBe('email');
            expect(parsed.values).toEqual(['alice@example.com']);
        });

        test('should return text message when contact not found', async () => {
            mockBackend.getContact.mockImplementation(async () => undefined);
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'lookupContactId');

            const result = await handler({ personId: 'nobody', platform: 'email' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe("Contact 'nobody' not found.");
        });

        test('should return text message when contact has no identifier for the platform', async () => {
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'lookupContactId');

            const result = await handler({ personId: 'alice-wonderland', platform: 'discord' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe("Contact 'alice-wonderland' has no discord identifier.");
        });

        test('should return error result when backend throws', async () => {
            mockBackend.getContact.mockImplementation(async () => {
                throw new Error('DynamoDB error');
            });
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'lookupContactId');

            const result = await handler({ personId: 'alice-wonderland', platform: 'email' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('DynamoDB error');
        });
    });

    describe('requestContactCreate tool', () => {
        test('should call approval callback and return success message', async () => {
            const approvalCallback = mock(async (): Promise<void> => { /* intentionally empty */ });
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend), sendContactApprovalRequest: approvalCallback });
            const handler = getToolHandler(server, 'requestContactCreate');

            const result = await handler({
                displayName: 'Bob Builder',
                identifiers: [{ platform: 'email', value: 'bob@example.com' }],
            });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('Contact creation request sent to admin for approval.');
            expect(approvalCallback).toHaveBeenCalledTimes(1);
            const callArgs = approvalCallback.mock.calls[0] as unknown as [string, ContactChangeRequest];
            expect(callArgs[0]).toBe('create');
            expect(callArgs[1].action).toBe('create');
            expect(callArgs[1].displayName).toBe('Bob Builder');
            expect(callArgs[1].addIdentifiers).toEqual([{ platform: 'email', value: 'bob@example.com' }]);
        });

        test('should include notes in approval request when provided', async () => {
            const approvalCallback = mock(async (): Promise<void> => { /* intentionally empty */ });
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend), sendContactApprovalRequest: approvalCallback });
            const handler = getToolHandler(server, 'requestContactCreate');

            await handler({
                displayName: 'Bob Builder',
                identifiers: [{ platform: 'email', value: 'bob@example.com' }],
                notes:       'Met at conference',
            });

            const callArgs = approvalCallback.mock.calls[0] as unknown as [string, ContactChangeRequest];
            expect(callArgs[1].notes).toBe('Met at conference');
        });

        test('should return error when no approval callback configured', async () => {
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'requestContactCreate');

            const result = await handler({
                displayName: 'Bob Builder',
                identifiers: [{ platform: 'email', value: 'bob@example.com' }],
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Contact creation requires admin approval but no approval channel is configured');
        });

        test('should return error result when callback throws', async () => {
            const approvalCallback = mock(async (): Promise<void> => {
                throw new Error('Discord error');
            });
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend), sendContactApprovalRequest: approvalCallback });
            const handler = getToolHandler(server, 'requestContactCreate');

            const result = await handler({
                displayName: 'Bob Builder',
                identifiers: [{ platform: 'email', value: 'bob@example.com' }],
            });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Discord error');
        });
    });

    describe('requestContactUpdate tool', () => {
        test('should call approval callback and return success message', async () => {
            const approvalCallback = mock(async (): Promise<void> => { /* intentionally empty */ });
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend), sendContactApprovalRequest: approvalCallback });
            const handler = getToolHandler(server, 'requestContactUpdate');

            const result = await handler({
                personId:       'alice-wonderland',
                addIdentifiers: [{ platform: 'discord', value: 'Alice#1234' }],
            });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe("Contact update request for 'alice-wonderland' sent to admin for approval.");
            expect(approvalCallback).toHaveBeenCalledTimes(1);
            const callArgs = approvalCallback.mock.calls[0] as unknown as [string, ContactChangeRequest];
            expect(callArgs[0]).toBe('update');
            expect(callArgs[1].action).toBe('update');
            expect(callArgs[1].personId).toBe('alice-wonderland');
            expect(callArgs[1].addIdentifiers).toEqual([{ platform: 'discord', value: 'Alice#1234' }]);
            expect(callArgs[1].removeIdentifiers).toBeUndefined();
        });

        test('should include removeIdentifiers in approval request separately', async () => {
            const approvalCallback = mock(async (): Promise<void> => { /* intentionally empty */ });
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend), sendContactApprovalRequest: approvalCallback });
            const handler = getToolHandler(server, 'requestContactUpdate');

            await handler({
                personId:          'alice-wonderland',
                removeIdentifiers: [{ platform: 'email', value: 'alice@example.com' }],
            });

            const callArgs = approvalCallback.mock.calls[0] as unknown as [string, ContactChangeRequest];
            expect(callArgs[1].addIdentifiers).toBeUndefined();
            expect(callArgs[1].removeIdentifiers).toEqual([{ platform: 'email', value: 'alice@example.com' }]);
        });

        test('should pass both addIdentifiers and removeIdentifiers separately', async () => {
            const approvalCallback = mock(async (): Promise<void> => { /* intentionally empty */ });
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend), sendContactApprovalRequest: approvalCallback });
            const handler = getToolHandler(server, 'requestContactUpdate');

            await handler({
                personId:          'alice-wonderland',
                addIdentifiers:    [{ platform: 'discord', value: 'Alice#1234' }],
                removeIdentifiers: [{ platform: 'email', value: 'alice@example.com' }],
            });

            const callArgs = approvalCallback.mock.calls[0] as unknown as [string, ContactChangeRequest];
            expect(callArgs[1].addIdentifiers).toEqual([{ platform: 'discord', value: 'Alice#1234' }]);
            expect(callArgs[1].removeIdentifiers).toEqual([{ platform: 'email', value: 'alice@example.com' }]);
        });

        test('should send no identifiers when neither add nor remove provided', async () => {
            const approvalCallback = mock(async (): Promise<void> => { /* intentionally empty */ });
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend), sendContactApprovalRequest: approvalCallback });
            const handler = getToolHandler(server, 'requestContactUpdate');

            await handler({
                personId: 'alice-wonderland',
                notes:    'Updated notes only',
            });

            const callArgs = approvalCallback.mock.calls[0] as unknown as [string, ContactChangeRequest];
            expect(callArgs[1].addIdentifiers).toBeUndefined();
            expect(callArgs[1].removeIdentifiers).toBeUndefined();
            expect(callArgs[1].notes).toBe('Updated notes only');
        });

        test('should return text message when contact not found', async () => {
            mockBackend.getContact.mockImplementation(async () => undefined);
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'requestContactUpdate');

            const result = await handler({ personId: 'nobody', notes: 'test' });

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe("Contact 'nobody' not found.");
        });

        test('should return error when no approval callback configured', async () => {
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'requestContactUpdate');

            const result = await handler({ personId: 'alice-wonderland', notes: 'test' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Contact updates require admin approval but no approval channel is configured');
        });

        test('should return error result when backend throws', async () => {
            mockBackend.getContact.mockImplementation(async () => {
                throw new Error('DynamoDB error');
            });
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'requestContactUpdate');

            const result = await handler({ personId: 'alice-wonderland', notes: 'test' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('DynamoDB error');
        });

        test('should return error result when approval callback throws', async () => {
            const approvalCallback = mock(async (): Promise<void> => {
                throw new Error('Discord error');
            });
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend), sendContactApprovalRequest: approvalCallback });
            const handler = getToolHandler(server, 'requestContactUpdate');

            const result = await handler({ personId: 'alice-wonderland', notes: 'test' });

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('Discord error');
        });
    });

    describe('listContacts tool', () => {
        test('should return all contacts as JSON with _internal stripped', async () => {
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'listContacts');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as Contact[];
            expect(parsed).toHaveLength(1);
            expect(parsed[0].displayName).toBe('Alice Wonderland');
            // _internal must be stripped
            expect(parsed[0]._internal).toBeUndefined();
        });

        test('should return text message when no contacts exist', async () => {
            mockBackend.listContacts.mockImplementation(async () => []);
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'listContacts');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            expect(textContent(result.content[0])).toBe('No contacts in the address book.');
        });

        test('should return error result when backend throws', async () => {
            mockBackend.listContacts.mockImplementation(async () => {
                throw new Error('DynamoDB error');
            });
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'listContacts');

            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(textContent(result.content[0])).toContain('DynamoDB error');
        });

        test('should return multiple contacts with _internal stripped from all', async () => {
            const contact2 = makeContact({
                personId:    'bob-builder' as ContactId,
                displayName: 'Bob Builder',
                identifiers: [{ platform: 'email', value: 'bob@example.com' }],
                _internal:   { discordUserId: '987654321' },
            });
            mockBackend.listContacts.mockImplementation(async () => [makeContact(), contact2]);
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'listContacts');

            const result = await handler({});

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as Contact[];
            expect(parsed).toHaveLength(2);
            expect(parsed[0]._internal).toBeUndefined();
            expect(parsed[1]._internal).toBeUndefined();
        });
    });

    describe('stripInternal behavior', () => {
        test('should work for contacts without _internal field', async () => {
            const contactWithoutInternal = makeContact({ _internal: undefined });
            mockBackend.fuzzyLookup.mockImplementation(async () => [contactWithoutInternal]);
            const server  = createContactsMCPServer({ backend: asBackend(mockBackend) });
            const handler = getToolHandler(server, 'lookupContact');

            const result = await handler({ query: 'alice' });

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(textContent(result.content[0])) as Contact[];
            expect(parsed[0].displayName).toBe('Alice Wonderland');
            expect(parsed[0]._internal).toBeUndefined();
        });
    });
});

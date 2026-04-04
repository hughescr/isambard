/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Test assertions use optional chaining on mock call args for defensive access; casts are non-nullable but ?. provides safety */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createEmailMCPServer, type RestrictedMailboxNotification } from '../../../src/agent/email-mcp-server';
import type { EmailAllowlist } from '../../../src/integrations/email/allowlist';
import type { SendRateLimiter } from '../../../src/integrations/email/send-rate-limiter';
import type { WildDuckClient, WildDuckSearchParams } from '../../../src/integrations/email/wildduck-client';
import { mockLogger, mockFsPromises, resetMockFs } from '../../setup';

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: {
        shape:          Record<string, unknown>
        safeParseAsync: (args: unknown) => Promise<{ success: boolean }>
    }
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool>, server: { _serverInfo: { version: string } } }

describe('createEmailMCPServer', () => {
    let mockSendAdminNotification: ReturnType<typeof mock<(msg: unknown) => Promise<void>>>;
    let mockWildDuck: WildDuckClient;

    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();

        mockFsPromises.access.mockClear();
        mockFsPromises.mkdir.mockClear();
        mockFsPromises.writeFile.mockClear();

        mockSendAdminNotification = mock(async () => { /* intentionally empty */ });

        // Minimal WildDuck mock used by tests that don't exercise WildDuck directly
        mockWildDuck = {
            getUserAddresses: mock(() => Promise.resolve([])),
            search:           mock(() => Promise.resolve([])),
            uploadMessage:    mock(() => Promise.resolve(1)),
            submitMessage:    mock(async () => { /* intentionally empty */ }),
            getMailboxId:     mock(() => undefined),
            getMailboxCounts: mock(async () => ({ total: 5, unseen: 2 })),
        } as unknown as WildDuckClient;

        // WildDuck methods used in email operations (in addition to the base methods above)
        mockWildDuck.listMessages    = mock(async () => []);
        mockWildDuck.getFullMessage  = mock(async () => ({
            uid:            1,
            messageId:      '<test@example.com>',
            from:           { name: 'Sender', address: 'sender@example.com' },
            to:             [{ address: 'recipient@example.com' }],
            cc:             [],
            subject:        'Test Subject',
            date:           new Date('2025-01-01T10:00:00.000Z'),
            bodyText:       'Hello world',
            hasAttachments: false,
            headers:        {},
            attachments:    [],
            attachmentMeta: [],
        }));
        mockWildDuck.updateMessageFlags = mock(async () => { /* intentionally empty */ });
        mockWildDuck.moveMessage        = mock(async () => { /* intentionally empty */ });
        mockWildDuck.getAttachment      = mock(async () => Buffer.from('attachment-data'));
    });

    afterEach(() => {
        resetMockFs();
    });

    // Helper to get tool handler from server instance
    const getToolHandler = (server: ReturnType<typeof createEmailMCPServer>, toolName: string): ((...args: unknown[]) => Promise<CallToolResult>) => {
        return (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName].handler;
    };

    // Helper to extract text from CallToolResult
    const getText = (result: CallToolResult): string => {
        const content = result.content[0];
        const record = content as Record<string, unknown>;
        if(record && 'text' in record && typeof record.text === 'string') {
            return record.text;
        }
        return '';
    };

    describe('createEmailMCPServer function', () => {
        test('should create MCP server with correct properties', () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });

            expect(server).toBeDefined();
            expect(server.name).toBe('email');
            expect(server.instance).toBeDefined();
            expect(server.type).toBe('sdk');
            expect((server.instance as unknown as RegisteredToolInstance).server._serverInfo.version).toBe('1.0.0');
        });

        test.each([
            ['checkInbox',      'Check CleanInbox for emails. Returns counter state and message summaries. By default only unread; set showSeen to include read messages.'],
            ['getEmailContent', 'Fetch the full content of an email by UID. Marks the email as read.'],
            ['archiveEmail',    'Move an email from CleanInbox to Archive.'],
        ])('should have %s tool with correct description', (toolName, expectedDescription) => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const toolDef = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(toolDef.description).toBe(expectedDescription);
        });

        test.each([
            ['checkInbox',      { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }],
            ['getEmailContent', { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
            ['archiveEmail',    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
        ])('should have %s tool with correct annotations', (toolName, expectedAnnotations) => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const toolDef = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(toolDef.annotations).toEqual(expectedAnnotations);
        });
    });

    describe('checkInbox tool', () => {
        test('should return counters and message list when there are unread messages', async () => {
            mockWildDuck.getMailboxCounts = mock(async () => ({ total: 10, unseen: 3 }));
            mockWildDuck.listMessages = mock(async () => [
                { id: 1, from: { name: 'Alice', address: 'alice@example.com' }, subject: 'Hello', date: '2025-01-01T10:00:00.000Z', intro: 'Hello there', attachments: [] },
                { id: 2, from: { address: 'bob@example.com' },                  subject: 'World', date: '2025-01-01T11:00:00.000Z', intro: 'World message', attachments: [{ filename: 'doc.pdf', contentType: 'application/pdf', sizeKb: 12 }] },
            ]);

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({});

            expect(result.content).toBeDefined();
            expect(result.content[0]?.type).toBe('text');
            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(getText(result)) as {
                counters: { total: number, unread: number }
                messages: { uid: string, from: string, subject: string, date: string, intro: string, attachments: unknown[] }[]
            };
            expect(parsed.counters.total).toBe(10);
            expect(parsed.counters.unread).toBe(3);
            expect(parsed.messages).toHaveLength(2);
            // uid is now in Mailbox:UID format
            expect(parsed.messages[0]?.uid).toBe('CleanInbox:1');
            expect(parsed.messages[0]?.subject).toBe('Hello');
            expect(parsed.messages[0]?.intro).toBe('Hello there');
            expect(parsed.messages[0]?.attachments).toEqual([]);
            expect(parsed.messages[1]?.uid).toBe('CleanInbox:2');
            expect(parsed.messages[1]?.subject).toBe('World');
            expect(parsed.messages[1]?.intro).toBe('World message');
            expect(parsed.messages[1]?.attachments).toHaveLength(1);
        });

        test('should return empty messages list when no unread messages', async () => {
            mockWildDuck.getMailboxCounts = mock(async () => ({ total: 5, unseen: 0 }));
            mockWildDuck.listMessages = mock(async () => []);

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBeUndefined();
            const parsed = JSON.parse(getText(result)) as {
                counters: { total: number, unread: number }
                messages: unknown[]
            };
            expect(parsed.counters.total).toBe(5);
            expect(parsed.counters.unread).toBe(0);
            expect(parsed.messages).toHaveLength(0);
        });

        test('should handle listMessages error gracefully', async () => {
            mockWildDuck.listMessages = mock(async () => {
                throw new Error('listMessages connection failed');
            });

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Error: listMessages connection failed');
        });

        test('should handle WildDuck getMailboxCounts error gracefully', async () => {
            mockWildDuck.getMailboxCounts = mock(async () => {
                throw new Error('WildDuck timeout');
            });

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Error: WildDuck timeout');
        });

        test('should handle non-Error listMessages failure gracefully', async () => {
            mockWildDuck.listMessages = mock(async () => {
                throw 'listMessages error string';
            });

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('listMessages error string');
        });

        test('should call listMessages with unseen filter when showSeen is false', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'checkInbox');

            await handler({ showSeen: false });

            expect(mockWildDuck.listMessages).toHaveBeenCalledWith('CleanInbox', { unseen: true });
        });

        test('should call listMessages with unseen filter when showSeen is omitted', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'checkInbox');

            await handler({});

            expect(mockWildDuck.listMessages).toHaveBeenCalledWith('CleanInbox', { unseen: true });
        });

        test('should call listMessages without unseen filter when showSeen is true', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'checkInbox');

            await handler({ showSeen: true });

            expect(mockWildDuck.listMessages).toHaveBeenCalledWith('CleanInbox', { unseen: false });
        });

        test('should return both read and unread messages when showSeen is true', async () => {
            mockWildDuck.listMessages = mock(async () => [
                { id: 1, from: { address: 'a@example.com' }, subject: 'Read',   date: '2025-01-01T00:00:00.000Z', intro: 'Already read',  attachments: [] },
                { id: 2, from: { address: 'b@example.com' }, subject: 'Unread', date: '2025-01-02T00:00:00.000Z', intro: 'Not read yet', attachments: [] },
            ]);

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({ showSeen: true });

            const parsed = JSON.parse(getText(result)) as { messages: { uid: string }[] };
            expect(parsed.messages).toHaveLength(2);
            expect(parsed.messages[0]?.uid).toBe('CleanInbox:1');
            expect(parsed.messages[1]?.uid).toBe('CleanInbox:2');
        });

        test('should format uid as CleanInbox:UID for each message', async () => {
            mockWildDuck.listMessages = mock(async () => [
                { id: 42, from: { address: 'test@example.com' }, subject: 'Test', date: '2025-01-01T00:00:00.000Z', intro: 'Test intro', attachments: [] },
            ]);

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({});

            const parsed = JSON.parse(getText(result)) as { messages: { uid: string, intro: string, attachments: unknown[] }[] };
            expect(parsed.messages[0]?.uid).toBe('CleanInbox:42');
            expect(parsed.messages[0]?.intro).toBe('Test intro');
            expect(parsed.messages[0]?.attachments).toEqual([]);
        });
    });

    describe('getEmailContent tool', () => {
        test('should fetch email and return formatted content using Mailbox:UID format', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            42,
                messageId:      '<msg42@example.com>',
                from:           { name: 'Alice Smith', address: 'alice@example.com' },
                to:             [{ name: 'Bob', address: 'bob@example.com' }],
                cc:             [],
                subject:        'Meeting tomorrow',
                date:           new Date('2025-01-15T09:00:00.000Z'),
                bodyText:       'Let us meet at noon.',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42' });

            expect(result.isError).toBeUndefined();
            const text = getText(result);
            expect(text).toContain('From: Alice Smith <alice@example.com>');
            expect(text).toContain('To: Bob <bob@example.com>');
            expect(text).toContain('Subject: Meeting tomorrow');
            expect(text).toContain('Let us meet at noon.');
        });

        test('should mark email as Seen using Mailbox:UID', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            await handler({ message: 'CleanInbox:42' });

            expect(mockWildDuck.getFullMessage).toHaveBeenCalledWith('CleanInbox', 42);
            expect(mockWildDuck.updateMessageFlags).toHaveBeenCalledWith('CleanInbox', 42, { addFlags: [String.raw`\Seen`] });
        });

        test('should return email content from Archive mailbox', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'Archive:15' });

            expect(result.isError).toBeUndefined();
            expect(mockWildDuck.getFullMessage).toHaveBeenCalledWith('Archive', 15);
        });

        test('should allow access to Drafts mailbox', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'Drafts:4' });

            expect(result.isError).toBeUndefined();
            expect(mockWildDuck.getFullMessage).toHaveBeenCalledWith('Drafts', 4);
            expect(mockSendAdminNotification).not.toHaveBeenCalled();
        });

        test('should deny access to Quarantine mailbox and send admin notification', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck, sendAdminNotification: mockSendAdminNotification });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'Quarantine:7' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Quarantine');
            expect(getText(result)).toContain('admin review');
            expect(mockSendAdminNotification).toHaveBeenCalledTimes(1);
            // Should NOT have fetched the message
            expect(mockWildDuck.getFullMessage).not.toHaveBeenCalled();
        });

        test('should deny access to Junk mailbox and send admin notification', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck, sendAdminNotification: mockSendAdminNotification });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'Junk:99' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Junk');
            expect(getText(result)).toContain('admin review');
            expect(mockSendAdminNotification).toHaveBeenCalledTimes(1);
        });

        test('should deny access to Trash mailbox and send admin notification', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck, sendAdminNotification: mockSendAdminNotification });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'Trash:3' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Trash');
            expect(getText(result)).toContain('admin review');
            expect(mockSendAdminNotification).toHaveBeenCalledTimes(1);
        });

        test('should deny access and not crash when sendAdminNotification is not configured', async () => {
            // No sendAdminNotification provided
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'Quarantine:7' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Quarantine');
            expect(getText(result)).toContain('admin review');
        });

        test('should deny access and not crash when sendAdminNotification fails', async () => {
            mockSendAdminNotification = mock(async () => {
                throw new Error('Discord channel send failed');
            });
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck, sendAdminNotification: mockSendAdminNotification });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'Quarantine:7' });

            // Still returns error to agent even if notification fails
            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Quarantine');
        });

        test('should include message reference in admin notification', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck, sendAdminNotification: mockSendAdminNotification });
            const handler = getToolHandler(server, 'getEmailContent');

            await handler({ message: 'Quarantine:42' });

            const callArg = mockSendAdminNotification.mock.calls[0]?.[0] as RestrictedMailboxNotification;
            expect(callArg).toBeDefined();
            expect(callArg.mailboxName).toBe('Quarantine');
            expect(callArg.uid).toBe(42);
            expect(callArg.reference).toBe('Quarantine:42');
        });

        test('should handle missing email (getFullMessage returns null) gracefully', async () => {
            mockWildDuck.getFullMessage = mock(() => Promise.resolve(null));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:99' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('CleanInbox:99');
            expect(getText(result)).toContain('not found');
        });

        test('should handle non-Error getFullMessage failure gracefully', async () => {
            mockWildDuck.getFullMessage = mock(async () => {
                throw { code: 'IMAP_ERR' };
            });

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Error:');
        });

        test('should include date in formatted output', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            1,
                messageId:      '<test@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [],
                cc:             [],
                subject:        'Test',
                date:           new Date('2025-06-15T14:30:00.000Z'),
                bodyText:       'Body text',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            const text = getText(result);
            expect(text).toContain('Date:');
            expect(text).toContain('2025');
        });

        test('should format From without name when name is absent', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            1,
                messageId:      '<test@example.com>',
                from:           { address: 'noname@example.com' },
                to:             [],
                cc:             [],
                subject:        'Test',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            const text = getText(result);
            expect(text).toContain('noname@example.com');
            // Should NOT include angle-bracket format when name is absent
            expect(text).not.toContain(' <noname@example.com>');
        });

        test('should format From with name when name is present', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            1,
                messageId:      '<test@example.com>',
                from:           { name: 'Alice Smith', address: 'alice@example.com' },
                to:             [],
                cc:             [],
                subject:        'Test',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            const text = getText(result);
            expect(text).toContain('From: Alice Smith <alice@example.com>');
        });

        test('should join multiple To addresses with comma and space', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:       1,
                messageId: '<test@example.com>',
                from:      { address: 'sender@example.com' },
                to:        [
                    { name: 'Alice', address: 'alice@example.com' },
                    { address: 'bob@example.com' },
                ],
                cc:             [],
                subject:        'Multi-recipient',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            const text = getText(result);
            expect(text).toContain('To: Alice <alice@example.com>, bob@example.com');
        });

        test('should include Cc header when cc is non-empty', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            1,
                messageId:      '<test@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [{ name: 'Carol', address: 'carol@example.com' }],
                subject:        'CC Test',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body with CC',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            const text = getText(result);
            expect(text).toContain('Cc: Carol <carol@example.com>');
        });

        test('should omit Cc header when cc is empty', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            1,
                messageId:      '<test@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'No CC',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body without CC',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            const text = getText(result);
            expect(text).not.toContain('Cc:');
        });

        test('should include multiple Cc addresses comma-separated', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:       1,
                messageId: '<test@example.com>',
                from:      { address: 'sender@example.com' },
                to:        [{ address: 'recipient@example.com' }],
                cc:        [
                    { address: 'cc1@example.com' },
                    { name: 'CC Two', address: 'cc2@example.com' },
                ],
                subject:        'Multi CC',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            const text = getText(result);
            expect(text).toContain('Cc: cc1@example.com, CC Two <cc2@example.com>');
        });

        test('should have a blank line between headers and body', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            1,
                messageId:      '<test@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Header Body Sep',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body content here',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            const text = getText(result);
            // Blank line between headers and body means two consecutive newlines
            expect(text).toContain('\n\nBody content here');
        });

        test('should not have leading newline when cc is empty', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            1,
                messageId:      '<test@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'No Leading Newline',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            const text = getText(result);
            expect(text.startsWith('\n')).toBe(false);
            expect(text.startsWith('From:')).toBe(true);
        });

        test('should not have leading newline when cc is non-empty', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            1,
                messageId:      '<test@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [{ address: 'cc@example.com' }],
                subject:        'No Leading Newline With CC',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            const text = getText(result);
            expect(text.startsWith('\n')).toBe(false);
            expect(text.startsWith('From:')).toBe(true);
        });

        test('should have Subject immediately after To when cc is empty (no spurious blank line)', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            1,
                messageId:      '<test@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'No Blank Line',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            const text = getText(result);
            const lines: string[] = text.split('\n');
            const lineIndex = new Map(lines.map((l, i) => [l, i] as [string, number]));
            const toIndex = lineIndex.get('To: recipient@example.com') ?? -1;
            const subjectIndex = lineIndex.get('Subject: No Blank Line') ?? -1;
            expect(toIndex).toBeGreaterThanOrEqual(0);
            expect(subjectIndex).toBe(toIndex + 1);
        });

        test('should not include extra text in output when cc is empty', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            1,
                messageId:      '<test@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'No CC Test',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body text here',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            const text = getText(result);
            // When cc is empty, the undefined sentinel is filtered out — no blank line between To: and Subject:
            const splitLines: string[] = text.split('\n');
            const splitLineIndex = new Map(splitLines.map((l, i) => [l, i] as [string, number]));
            const toIndex = splitLineIndex.get('To: recipient@example.com') ?? -1;
            const subjectIndex = splitLineIndex.get('Subject: No CC Test') ?? -1;
            expect(toIndex).toBeGreaterThanOrEqual(0);
            expect(subjectIndex).toBeGreaterThanOrEqual(0);
            // Subject: immediately follows To: (no blank line between them when cc is absent)
            expect(subjectIndex).toBe(toIndex + 1);
        });
    });

    describe('getEmailContent attachment saving', () => {
        test('should not write files when email has no attachments', async () => {
            // Default mockWildDuck.getFullMessage returns attachments: []
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:1' });

            expect(result.isError).toBeUndefined();
            expect(mockFsPromises.mkdir).not.toHaveBeenCalled();
            expect(mockFsPromises.writeFile).not.toHaveBeenCalled();
            // No attachments section in output
            expect(getText(result)).not.toContain('Attachments:');
        });

        test('should save single attachment and include it in output', async () => {
            const pdfData = Buffer.from('pdf-content');
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            42,
                messageId:      '<msg42@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'With Attachment',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'See attached',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [{ id: 'att-1', filename: 'report.pdf', contentType: 'application/pdf', sizeKb: 10 }],
            }));
            mockWildDuck.getAttachment = mock(async () => pdfData);
            // access throws (file does not exist) — mkdir and writeFile succeed by default
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT: file not found'));
            mockFsPromises.mkdir.mockResolvedValueOnce(undefined);
            mockFsPromises.writeFile.mockResolvedValueOnce(undefined);

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42' });

            expect(result.isError).toBeUndefined();
            expect(mockFsPromises.mkdir).toHaveBeenCalledTimes(1);
            expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(1);
            // Check that getAttachment was called with correct params
            expect(mockWildDuck.getAttachment).toHaveBeenCalledWith('CleanInbox', 42, 'att-1');
            // Check that writeFile was called with correct path and data
            const writeFileCall = mockFsPromises.writeFile.mock.calls[0];
            expect(writeFileCall?.[0]).toContain('report.pdf');
            expect(writeFileCall?.[0]).toContain('email-');
            expect(writeFileCall?.[1] as unknown as Buffer).toEqual(pdfData);
            // Attachment section in output
            const text = getText(result);
            expect(text).toContain('Attachments:');
            expect(text).toContain('report.pdf');
            expect(text).toContain('application/pdf');
        });

        test('should skip writing file if it already exists', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            42,
                messageId:      '<msg42@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Duplicate',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [{ id: 'att-1', filename: 'existing.pdf', contentType: 'application/pdf', sizeKb: 5 }],
            }));
            // access resolves (file exists)
            mockFsPromises.access.mockResolvedValueOnce(undefined);

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42' });

            expect(result.isError).toBeUndefined();
            // mkdir and writeFile should NOT be called (file already exists)
            expect(mockFsPromises.mkdir).not.toHaveBeenCalled();
            expect(mockFsPromises.writeFile).not.toHaveBeenCalled();
            // Attachment should still appear in output even when not written
            const text = getText(result);
            expect(text).toContain('Attachments:');
            expect(text).toContain('existing.pdf');
        });

        test('should save multiple attachments and list all in output', async () => {
            const pdfData  = Buffer.from('pdf-bytes');
            const jpegData = Buffer.from('jpeg-bytes');
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            10,
                messageId:      '<multi@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Multi Attachments',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'See attached files',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [
                    { id: 'att-1', filename: 'report.pdf', contentType: 'application/pdf', sizeKb: 50 },
                    { id: 'att-2', filename: 'photo.jpg',  contentType: 'image/jpeg',      sizeKb: 30 },
                ],
            }));
            mockWildDuck.getAttachment = mock(async (_mailbox: string, _uid: number, attId: string) => {
                return attId === 'att-1' ? pdfData : jpegData;
            });
            // Both files don't exist
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:10' });

            expect(result.isError).toBeUndefined();
            expect(mockFsPromises.mkdir).toHaveBeenCalledTimes(2);
            expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(2);
            const text = getText(result);
            expect(text).toContain('Attachments:');
            expect(text).toContain('report.pdf');
            expect(text).toContain('photo.jpg');
            expect(text).toContain('application/pdf');
            expect(text).toContain('image/jpeg');
        });

        test('should use sha1 of messageId for attachment directory name', async () => {
            const { createHash } = await import('node:crypto');
            const messageId = '<unique-msg-id@example.com>';
            const expectedHash = createHash('sha1').update(messageId).digest('hex');
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            99,
                messageId,
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Hash Test',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [{ id: 'att-1', filename: 'test.pdf', contentType: 'application/pdf', sizeKb: 5 }],
            }));
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            await handler({ message: 'CleanInbox:99' });

            const mkdirCall = mockFsPromises.mkdir.mock.calls[0];
            expect(mkdirCall?.[0]).toContain(`email-${expectedHash}`);
        });

        test('should include email- prefix in attachment path in output text', async () => {
            const { createHash } = await import('node:crypto');
            const messageId = '<prefix-test@example.com>';
            const expectedHash = createHash('sha1').update(messageId).digest('hex');
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            77,
                messageId,
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Prefix Test',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [{ id: 'att-1', filename: 'doc.pdf', contentType: 'application/pdf', sizeKb: 1 }],
            }));
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:77' });

            const text = getText(result);
            expect(text).toContain(`attachments/email-${expectedHash}/doc.pdf`);
        });

        test('should sanitize path-traversal characters in attachment filename', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            50,
                messageId:      '<traversal@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Traversal Test',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [{ id: 'att-1', filename: '../../../etc/passwd', contentType: 'text/plain', sizeKb: 1 }],
            }));
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:50' });

            expect(result.isError).toBeUndefined();
            // The path written to disk should NOT contain the path-traversal sequence
            const writeFileCall = mockFsPromises.writeFile.mock.calls[0];
            const writtenPath = writeFileCall?.[0];
            expect(writtenPath).toBeDefined();
            expect(writtenPath).not.toContain('..');
            expect(writtenPath).not.toContain('/etc/passwd');
        });

        test('should deduplicate attachment filenames when two attachments have the same sanitized name', async () => {
            const pdfData1 = Buffer.from('pdf1');
            const pdfData2 = Buffer.from('pdf2');
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            55,
                messageId:      '<dedup@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Dedup Test',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [
                    { id: 'att-1', filename: 'report.pdf', contentType: 'application/pdf', sizeKb: 10 },
                    { id: 'att-2', filename: 'report.pdf', contentType: 'application/pdf', sizeKb: 10 },
                ],
            }));
            mockWildDuck.getAttachment = mock(async (_mailbox: string, _uid: number, attId: string) => {
                return attId === 'att-1' ? pdfData1 : pdfData2;
            });
            // Both files don't exist
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:55' });

            expect(result.isError).toBeUndefined();
            expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(2);
            // First file: report.pdf
            const firstPath  = mockFsPromises.writeFile.mock.calls[0]?.[0];
            // Second file: report-(1).pdf
            const secondPath = mockFsPromises.writeFile.mock.calls[1]?.[0];
            expect(firstPath).toContain('report.pdf');
            expect(secondPath).toContain('report-(1).pdf');
        });

        test('should deduplicate attachment filenames when three attachments have the same sanitized name', async () => {
            const pdfData1 = Buffer.from('pdf1');
            const pdfData2 = Buffer.from('pdf2');
            const pdfData3 = Buffer.from('pdf3');
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            56,
                messageId:      '<dedup3@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Triple Dedup Test',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [
                    { id: 'att-1', filename: 'data.csv', contentType: 'text/csv', sizeKb: 1 },
                    { id: 'att-2', filename: 'data.csv', contentType: 'text/csv', sizeKb: 1 },
                    { id: 'att-3', filename: 'data.csv', contentType: 'text/csv', sizeKb: 1 },
                ],
            }));
            const attDataMap: Record<string, Buffer> = { 'att-1': pdfData1, 'att-2': pdfData2, 'att-3': pdfData3 };
            mockWildDuck.getAttachment = mock(async (_mailbox: string, _uid: number, attId: string) => {
                return attDataMap[attId] ?? pdfData3;
            });
            // All three files don't exist
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:56' });

            expect(result.isError).toBeUndefined();
            expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(3);
            // First file: data.csv
            const firstPath  = mockFsPromises.writeFile.mock.calls[0]?.[0];
            // Second file: data-(1).csv
            const secondPath = mockFsPromises.writeFile.mock.calls[1]?.[0];
            // Third file: data-(2).csv (requires loop to iterate past candidate-(1))
            const thirdPath  = mockFsPromises.writeFile.mock.calls[2]?.[0];
            expect(firstPath).toContain('data.csv');
            expect(secondPath).toContain('data-(1).csv');
            expect(thirdPath).toContain('data-(2).csv');
        });

        test('should return email content even when attachment write fails (best-effort)', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            42,
                messageId:      '<failwrite@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Write Fail Test',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body text',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [{ id: 'att-1', filename: 'report.pdf', contentType: 'application/pdf', sizeKb: 10 }],
            }));
            mockWildDuck.getAttachment = mock(async () => Buffer.from('pdf-content'));
            // access check fails (file doesn't exist)
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));
            // mkdir fails
            mockFsPromises.mkdir.mockRejectedValueOnce(new Error('EACCES: permission denied'));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42' });

            // Should NOT be an error — email content still returned
            expect(result.isError).toBeUndefined();
            // Body should still be present
            expect(getText(result)).toContain('Body text');
            // Note about failure should be included
            expect(getText(result)).toContain('could not save attachment');
            expect(getText(result)).toContain('report.pdf');
        });

        test('should return email content even when writeFile fails (best-effort)', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            43,
                messageId:      '<failwrite2@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Write Fail Test 2',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body content',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [{ id: 'att-1', filename: 'data.pdf', contentType: 'application/pdf', sizeKb: 10 }],
            }));
            mockWildDuck.getAttachment = mock(async () => Buffer.from('pdf-content'));
            // access check fails (file doesn't exist)
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));
            // mkdir succeeds, writeFile fails
            mockFsPromises.mkdir.mockResolvedValueOnce(undefined);
            mockFsPromises.writeFile.mockRejectedValueOnce(new Error('disk full'));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:43' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('Body content');
            expect(getText(result)).toContain('could not save attachment');
            expect(getText(result)).toContain('data.pdf');
        });

        test('should continue processing remaining attachments when one fails', async () => {
            const pdfData2 = Buffer.from('pdf2');
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            44,
                messageId:      '<failfirst@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Partial Fail',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'Body',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [
                    { id: 'att-1', filename: 'fail.pdf',    contentType: 'application/pdf', sizeKb: 5 },
                    { id: 'att-2', filename: 'success.txt', contentType: 'text/plain',      sizeKb: 1 },
                ],
            }));
            mockWildDuck.getAttachment = mock(async (_mailbox: string, _uid: number, attId: string) => {
                return attId === 'att-2' ? pdfData2 : Buffer.from('fail-data');
            });
            // First file: access check fails, mkdir fails
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));
            mockFsPromises.mkdir.mockRejectedValueOnce(new Error('error'));
            // Second file: access check fails, mkdir and writeFile succeed
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));
            mockFsPromises.mkdir.mockResolvedValueOnce(undefined);
            mockFsPromises.writeFile.mockResolvedValueOnce(undefined);

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ message: 'CleanInbox:44' });

            expect(result.isError).toBeUndefined();
            const text = getText(result);
            // First attachment failed — note in output
            expect(text).toContain('could not save attachment');
            expect(text).toContain('fail.pdf');
            // Second attachment succeeded — path in output
            expect(text).toContain('success.txt');
        });
    });

    describe('archiveEmail tool', () => {
        test('should move email and sync counters from IMAP using Mailbox:UID format', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:7' });

            expect(result.isError).toBeUndefined();
            expect(mockWildDuck.moveMessage).toHaveBeenCalledWith('CleanInbox', 7, 'Archive');
            const text = getText(result);
            expect(text).toContain('7');
            expect(text).toContain('archived');
        });

        test('should handle move error gracefully', async () => {
            mockWildDuck.moveMessage = mock(async () => {
                throw new Error('Move failed: folder not found');
            });

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:7' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Error: Move failed: folder not found');
        });

        test('should handle non-Error move failure gracefully', async () => {
            mockWildDuck.moveMessage = mock(async () => {
                throw 'Network timeout';
            });

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:3' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Network timeout');
        });

        test('should archive from any accessible mailbox (not just CleanInbox)', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:15' });

            expect(result.isError).toBeUndefined();
            expect(mockWildDuck.moveMessage).toHaveBeenCalledWith('CleanInbox', 15, 'Archive');
        });

        test('should deny archive from Quarantine mailbox', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'Quarantine:7' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Access denied');
            expect(getText(result)).toContain('Quarantine');
            expect(getText(result)).toContain('Restricted mailboxes require admin review');
            expect(mockWildDuck.moveMessage).not.toHaveBeenCalled();
        });

        test('should deny archive from Junk mailbox', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'Junk:3' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Access denied');
            expect(getText(result)).toContain('Junk');
            expect(mockWildDuck.moveMessage).not.toHaveBeenCalled();
        });

        test('should deny archive from Trash mailbox', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'Trash:5' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Access denied');
            expect(getText(result)).toContain('Trash');
            expect(mockWildDuck.moveMessage).not.toHaveBeenCalled();
        });

        test('should deny archive from Drafts mailbox', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'Drafts:2' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Access denied');
            expect(getText(result)).toContain('Drafts');
            expect(mockWildDuck.moveMessage).not.toHaveBeenCalled();
        });

        test('should allow archive from Archive mailbox', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'Archive:8' });

            expect(result.isError).toBeUndefined();
            expect(mockWildDuck.moveMessage).toHaveBeenCalledWith('Archive', 8, 'Archive');
        });
    });

    describe('searchEmail tool', () => {
        // Typed mock so we can access .mock.calls without unsafe member access
        let mockSearch: ReturnType<typeof mock<(params: WildDuckSearchParams) => Promise<never[]>>>;
        let mockSearchWildDuck: WildDuckClient;

        const getRegisteredTool = (server: ReturnType<typeof createEmailMCPServer>, toolName: string): RegisteredTool => {
            return (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];
        };

        beforeEach(() => {
            mockSearch      = mock(async (_params: WildDuckSearchParams) => []);
            mockSearchWildDuck = { search: mockSearch } as unknown as WildDuckClient;
        });

        test('should be registered on the MCP server', () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });

            const toolDef = getRegisteredTool(server, 'searchEmail') as { description: string };

            expect(toolDef).toBeDefined();
            expect(toolDef.description).toBe('Search emails across mailboxes using WildDuck API');
        });

        test('should have readOnlyHint annotation', () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });

            const toolDef = getRegisteredTool(server, 'searchEmail') as { annotations: Record<string, unknown> };

            expect(toolDef.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        });

        test('should return "no emails found" when search returns empty results', async () => {
            mockSearch         = mock(async () => []);
            mockSearchWildDuck = { search: mockSearch } as unknown as WildDuckClient;

            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('No emails found');
        });

        test('should use searchable=true and no mailbox when no mailbox specified (all-regular default)', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            await handler({});

            expect(mockSearch).toHaveBeenCalledTimes(1);
            const params = mockSearch.mock.calls[0]?.[0];
            expect(params.searchable).toBe(true);
            expect(params.mailbox).toBeUndefined();
        });

        test("should use searchable=true and no mailbox when mailbox is 'all-regular'", async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            await handler({ mailbox: 'all-regular' });

            const params = mockSearch.mock.calls[0]?.[0];
            expect(params.searchable).toBe(true);
            expect(params.mailbox).toBeUndefined();
        });

        test("should omit mailbox and searchable when mailbox is 'all'", async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            await handler({ mailbox: 'all' });

            const params = mockSearch.mock.calls[0]?.[0];
            expect(params.mailbox).toBeUndefined();
            expect(params.searchable).toBeUndefined();
        });

        test('should search only specified mailbox when a specific folder name is provided', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            await handler({ mailbox: 'Archive' });

            const params = mockSearch.mock.calls[0]?.[0];
            expect(params.mailbox).toBe('Archive');
            expect(params.searchable).toBeUndefined();
        });

        test('should pass correspondent to search query', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            await handler({ correspondent: 'alice@example.com' });

            const params = mockSearch.mock.calls[0]?.[0];
            expect(params.query?.correspondent).toBe('alice@example.com');
        });

        test('should pass content to search query', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            await handler({ content: 'invoice' });

            const params = mockSearch.mock.calls[0]?.[0];
            expect(params.query?.content).toBe('invoice');
        });

        test('should pass before date to search query', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            await handler({ before: '2025-01-15T00:00:00.000Z' });

            const params = mockSearch.mock.calls[0]?.[0];
            expect(params.query?.before).toBe('2025-01-15T00:00:00.000Z');
        });

        test('should pass since date to search query', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            await handler({ since: '2025-01-01T00:00:00.000Z' });

            const params = mockSearch.mock.calls[0]?.[0];
            expect(params.query?.since).toBe('2025-01-01T00:00:00.000Z');
        });

        test('should pass header to search query', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            await handler({ header: { name: 'X-Custom', value: 'test' } });

            const params = mockSearch.mock.calls[0]?.[0];
            expect(params.query?.header).toEqual({ name: 'X-Custom', value: 'test' });
        });

        test('should format result lines correctly', async () => {
            mockSearchWildDuck.search = mock(async () => [
                {
                    message: 'CleanInbox:42',
                    from:    'Alice <alice@example.com>',
                    to:      ['me@example.com'],
                    subject: 'Hello world',
                    date:    '2025-01-01T10:00:00.000Z',
                },
                {
                    message: 'Archive:17',
                    from:    'bob@example.com',
                    to:      ['me@example.com', 'other@example.com'],
                    subject: 'Second email',
                    date:    '2025-01-02T10:00:00.000Z',
                },
            ]);

            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBeUndefined();
            const text = getText(result);
            expect(text).toContain('Found 2 emails:');
            expect(text).toContain('- CleanInbox:42 | From: Alice <alice@example.com> | To: me@example.com | Subject: Hello world | Date: 2025-01-01T10:00:00.000Z');
            expect(text).toContain('- Archive:17 | From: bob@example.com | To: me@example.com, other@example.com | Subject: Second email | Date: 2025-01-02T10:00:00.000Z');
        });

        test('should use singular "email" for 1 result', async () => {
            mockSearchWildDuck.search = mock(async () => [
                {
                    message: 'CleanInbox:1',
                    from:    'alice@example.com',
                    to:      [],
                    subject: 'Test',
                    date:    '2025-01-01T10:00:00.000Z',
                },
            ]);

            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            const result: CallToolResult = await handler({});

            const text = getText(result);
            expect(text).toContain('Found 1 email:');
            expect(text).not.toContain('Found 1 emails:');
        });

        test('should show "(none)" for empty to list', async () => {
            mockSearchWildDuck.search = mock(async () => [
                {
                    message: 'CleanInbox:1',
                    from:    'alice@example.com',
                    to:      [],
                    subject: 'Test',
                    date:    '2025-01-01T10:00:00.000Z',
                },
            ]);

            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            const result: CallToolResult = await handler({});

            expect(getText(result)).toContain('To: (none)');
        });

        test('should handle WildDuck search error gracefully', async () => {
            mockSearchWildDuck.search = mock(async () => {
                throw new Error('WildDuck API unavailable');
            });

            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Error: WildDuck API unavailable');
        });

        test('should handle non-Error WildDuck failure gracefully', async () => {
            mockSearchWildDuck.search = mock(async () => {
                throw 'connection refused';
            });

            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('connection refused');
        });

        test('should log warning on search error', async () => {
            mockSearchWildDuck.search = mock(async () => {
                throw new Error('Search failed');
            });

            const server = createEmailMCPServer({ wildDuckClient: mockSearchWildDuck });
            const handler = getToolHandler(server, 'searchEmail');

            await handler({});

            expect(mockLogger.warn).toHaveBeenCalled();
        });
    });

    describe('sendEmail tool', () => {
        let mockSendWildDuck:        WildDuckClient;
        let mockRateLimiter:         SendRateLimiter;
        let mockAllowlist:           EmailAllowlist;
        let mockSendApprovalRequest: ReturnType<typeof mock>;
        let mockUploadMessage:       ReturnType<typeof mock>;
        let mockSubmitMessage:       ReturnType<typeof mock>;
        let mockGetUserAddresses:    ReturnType<typeof mock>;

        beforeEach(() => {
            mockUploadMessage    = mock(() => Promise.resolve(99));
            mockSubmitMessage    = mock(async () => { /* intentionally empty */ });
            mockGetUserAddresses = mock(async () => [
                { id: '1', address: 'formal@example.com',   name: 'Izzy Formal',   main: false, tags: ['formal']   },
                { id: '2', address: 'informal@example.com', name: 'Izzy Informal', main: false, tags: ['informal'] },
            ]);
            mockSendWildDuck = {
                uploadMessage:         mockUploadMessage,
                submitMessage:         mockSubmitMessage,
                getUserAddresses:      mockGetUserAddresses,
                getMailboxId:          mock(() => 'mbx-drafts'),
                updateMessageMetadata: mock(async () => { /* intentionally empty */ }),
                updateMessageFlags:    mock(async () => { /* intentionally empty */ }),
            } as unknown as WildDuckClient;
            mockRateLimiter = {
                isAtLimit:       mock(() => false),
                tokensRemaining: mock(() => 23),
                increment:       mock(() => undefined),
            } as unknown as SendRateLimiter;
            mockAllowlist = {
                isAllowed: mock(() => false),
            } as unknown as EmailAllowlist;
            mockSendApprovalRequest = mock(() => undefined);
        });

        test('should upload to Drafts and submit immediately when recipient is on allowlist', async () => {
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                rateLimiter:    mockRateLimiter,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('Sent successfully');
            expect(mockUploadMessage).toHaveBeenCalledTimes(1);
            expect(mockSubmitMessage).toHaveBeenCalledTimes(1);
            expect(mockRateLimiter.increment).toHaveBeenCalledTimes(1);
        });

        test('should upload to Drafts with correct payload for formal identity', async () => {
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'alice@example.com', subject: 'Test Subject', body: 'Test Body', identity: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(_folder).toBe('Drafts');
            expect(payload.to).toEqual([{ address: 'alice@example.com' }]);
            expect(payload.subject).toBe('Test Subject');
            expect(payload.text).toBe('Test Body');
            expect(payload.draft).toBe(true);
        });

        test('should NOT include flags field in sendEmail upload payload', async () => {
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'alice@example.com', subject: 'Test Subject', body: 'Test Body', identity: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.flags).toBeUndefined();
        });

        test('should use formalAddress from getUserAddresses for formal identity', async () => {
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', identity: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.from as { address: string }).address).toBe('formal@example.com');
            expect((payload.from as { name: string }).name).toBe('Izzy Formal');
        });

        test('should use informalAddress from getUserAddresses for informal identity', async () => {
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', identity: 'informal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.from as { address: string }).address).toBe('informal@example.com');
            expect((payload.from as { name: string }).name).toBe('Izzy Informal');
        });

        test('should pass structured to object { name, email_address } to uploadMessage as { name, address }', async () => {
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: { name: 'Craig', email_address: 'craig@rungie.com' }, subject: 'Hi', body: 'Hello', identity: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.to).toEqual([{ name: 'Craig', address: 'craig@rungie.com' }]);
        });

        test('should pass plain string to as { address } object', async () => {
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'craig@rungie.com', subject: 'Hi', body: 'Hello', identity: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.to).toEqual([{ address: 'craig@rungie.com' }]);
        });

        test('should handle array with mixed structured and plain string to addresses', async () => {
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({
                to:       [{ name: 'Craig', email_address: 'craig@rungie.com' }, 'other@example.com'],
                subject:  'Hi',
                body:     'Hello',
                identity: 'formal',
            });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.to).toEqual([
                { name: 'Craig', address: 'craig@rungie.com' },
                { address: 'other@example.com' },
            ]);
        });

        test('should check allowlist using address field from structured to object', async () => {
            const mockIsAllowed = mock((addr: string) => addr === 'craig@rungie.com');
            mockAllowlist.isAllowed = mockIsAllowed;

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: { name: 'Craig', email_address: 'craig@rungie.com' }, subject: 'Hi', body: 'Hello', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('Sent successfully');
            expect(mockIsAllowed).toHaveBeenCalledWith('craig@rungie.com');
        });

        test('should upload to WildDuck Drafts and NOT submit when recipient not on allowlist', async () => {
            mockAllowlist.isAllowed = mock(() => false);

            const server = createEmailMCPServer({
                wildDuckClient:      mockSendWildDuck,
                allowlist:           mockAllowlist,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'bob@example.com', subject: 'Test', body: 'Body', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('pending admin approval');
            expect(mockUploadMessage).toHaveBeenCalledTimes(1);
            expect(mockSubmitMessage).not.toHaveBeenCalled();
        });

        test('should call sendApprovalRequest with to, subject, WildDuck UID, and undefined cc when not allowlisted', async () => {
            mockAllowlist.isAllowed     = mock(() => false);
            mockUploadMessage           = mock(() => Promise.resolve(99));
            mockSendWildDuck.uploadMessage = mockUploadMessage;

            const server = createEmailMCPServer({
                wildDuckClient:      mockSendWildDuck,
                allowlist:           mockAllowlist,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'bob@example.com', subject: 'Test', body: 'Body', identity: 'formal' });

            expect(mockSendApprovalRequest).toHaveBeenCalledWith('bob@example.com', 'Test', 99, undefined);
        });

        test('should accept an array of to addresses and upload all to WildDuck', async () => {
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: ['alice@example.com', 'bob@example.com'], subject: 'Hi', body: 'Hello', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('Sent successfully');
            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.to).toEqual([{ address: 'alice@example.com' }, { address: 'bob@example.com' }]);
        });

        test('should route to approval when array to has any recipient not on allowlist', async () => {
            mockAllowlist.isAllowed = mock((addr: string) => addr === 'alice@example.com');

            const server = createEmailMCPServer({
                wildDuckClient:      mockSendWildDuck,
                allowlist:           mockAllowlist,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: ['alice@example.com', 'bob@example.com'], subject: 'Hi', body: 'Hello', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('pending admin approval');
            expect(mockSubmitMessage).not.toHaveBeenCalled();
        });

        test('should fast-path when all addresses in array are allowlisted', async () => {
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: ['alice@example.com', 'bob@example.com'], subject: 'Hi', body: 'Hello', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('Sent successfully');
            expect(mockSubmitMessage).toHaveBeenCalledTimes(1);
        });

        test('should pass joined to addresses to sendApprovalRequest when array not allowlisted', async () => {
            mockAllowlist.isAllowed        = mock(() => false);
            mockUploadMessage              = mock(() => Promise.resolve(99));
            mockSendWildDuck.uploadMessage = mockUploadMessage;

            const server = createEmailMCPServer({
                wildDuckClient:      mockSendWildDuck,
                allowlist:           mockAllowlist,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: ['alice@example.com', 'bob@example.com'], subject: 'Hi', body: 'Hello', identity: 'formal' });

            expect(mockSendApprovalRequest).toHaveBeenCalledWith('alice@example.com, bob@example.com', 'Hi', 99, undefined);
        });

        test('should include rate limit warning when over limit', async () => {
            mockAllowlist.isAllowed         = mock(() => true);
            mockRateLimiter.isAtLimit       = mock(() => true);
            mockRateLimiter.tokensRemaining = mock(() => 0);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                rateLimiter:    mockRateLimiter,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('send rate limit reached');
        });

        test('should handle uploadMessage error gracefully', async () => {
            mockAllowlist.isAllowed        = mock(() => true);
            mockSendWildDuck.uploadMessage = mock(async () => {
                throw new Error('WildDuck upload failed');
            });

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', identity: 'formal' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('WildDuck upload failed');
        });

        test('should return failure message when sendApprovalRequest fails', async () => {
            mockAllowlist.isAllowed = mock(() => false);
            mockSendApprovalRequest = mock(async () => {
                throw new Error('Discord unavailable');
            });

            const server = createEmailMCPServer({
                wildDuckClient:      mockSendWildDuck,
                allowlist:           mockAllowlist,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'new@example.com', subject: 'Hi', body: 'Body', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('failed to notify admin');
            expect(getText(result)).toContain('check pending drafts manually');
            expect(mockLogger.warn).toHaveBeenCalled();
            // No flag setting — outbox handles retry now
            expect(mockSendWildDuck.updateMessageFlags).not.toHaveBeenCalledWith('Drafts', 99, { addFlags: ['DiscordNotifyFailed'] });
        });

        test('should NOT store metaData with to address in upload payload (to is a message field)', async () => {
            mockAllowlist.isAllowed = mock(() => false);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'target@example.com', subject: 'Hi', body: 'Body', identity: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            // metaData.to is no longer stored — to is part of the message itself
            expect((payload.metaData as Record<string, unknown> | undefined)?.to).toBeUndefined();
        });

        test('should not include rate limit warning in result when limit is not reached', async () => {
            mockAllowlist.isAllowed   = mock(() => true);
            mockRateLimiter.isAtLimit = mock(() => false);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                rateLimiter:    mockRateLimiter,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', identity: 'formal' });

            // When limit is NOT reached, result text should not contain warning
            const text = getText(result);
            expect(text).not.toContain('send rate limit reached');
            expect(text).toContain('Sent successfully');
        });

        test('should retry getUserAddresses on second sendEmail call after first call fails', async () => {
            // First call: getUserAddresses throws
            mockGetUserAddresses = mock(async () => {
                throw new Error('WildDuck unavailable');
            });
            mockSendWildDuck.getUserAddresses = mockGetUserAddresses;
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            // First call — getUserAddresses fails, addressesLoaded stays false
            await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', identity: 'formal' });
            expect(mockGetUserAddresses).toHaveBeenCalledTimes(1);

            // Second call — getUserAddresses should be called AGAIN (not skipped)
            await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', identity: 'formal' });
            expect(mockGetUserAddresses).toHaveBeenCalledTimes(2);
        });

        test('should NOT retry getUserAddresses on second sendEmail call after first call succeeds', async () => {
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            // First call — getUserAddresses succeeds, addressesLoaded becomes true
            await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', identity: 'formal' });
            expect(mockGetUserAddresses).toHaveBeenCalledTimes(1);

            // Second call — getUserAddresses should NOT be called again (addressesLoaded = true)
            await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', identity: 'formal' });
            expect(mockGetUserAddresses).toHaveBeenCalledTimes(1);
        });

        test('should reject empty array for to via input schema (min(1) constraint)', async () => {
            const server  = createEmailMCPServer({ wildDuckClient: mockSendWildDuck });
            const toolDef = (server.instance as unknown as RegisteredToolInstance)._registeredTools.sendEmail;

            const result = await toolDef.inputSchema.safeParseAsync({ to: [], subject: 'Hi', body: 'Hello' });

            expect(result.success).toBe(false);
        });
    });

    describe('replyToEmail tool', () => {
        let mockReplyWildDuck:    WildDuckClient;
        let mockRateLimiter:      SendRateLimiter;
        let mockAllowlist:        EmailAllowlist;
        let mockUploadMessage:    ReturnType<typeof mock>;
        let mockSubmitMessage:    ReturnType<typeof mock>;
        let mockGetMailboxId:     ReturnType<typeof mock>;

        // WildDuck-format original email fixture (pre-parsed address fields)
        const originalEmail = {
            id:      42,
            subject: 'Re: Hello',
            from:    { name: 'Alice', address: 'alice@example.com' },
            to:      [{ address: 'me@example.com' }],
            cc:      [],
            text:    'Original body.',
        };

        let mockGetMessage: ReturnType<typeof mock>;

        beforeEach(() => {
            mockGetMessage    = mock(async () => originalEmail);
            mockUploadMessage = mock(() => Promise.resolve(88));
            mockSubmitMessage = mock(async () => { /* intentionally empty */ });
            mockGetMailboxId  = mock(() => 'mbx-clean');
            mockReplyWildDuck = {
                getMessage:       mockGetMessage,
                uploadMessage:    mockUploadMessage,
                submitMessage:    mockSubmitMessage,
                getUserAddresses: mock(async () => [
                    { id: '1', address: 'formal@example.com',   name: 'Izzy Formal',   main: false, tags: ['formal']   },
                    { id: '2', address: 'informal@example.com', name: 'Izzy Informal', main: false, tags: ['informal'] },
                ]),
                getMailboxId: mockGetMailboxId,
            } as unknown as WildDuckClient;
            mockRateLimiter = {
                isAtLimit:       mock(() => false),
                tokensRemaining: mock(() => 24),
                increment:       mock(() => undefined),
            } as unknown as SendRateLimiter;
            mockAllowlist = {
                isAllowed: mock(() => true),
            } as unknown as EmailAllowlist;
        });

        test('should deny reply to message in Quarantine mailbox', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'Quarantine:7', body: 'Reply', mode: 'reply', identity: 'formal' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Access denied');
            expect(getText(result)).toContain('Quarantine');
            expect(getText(result)).toContain('Restricted mailboxes require admin review');
            expect(mockUploadMessage).not.toHaveBeenCalled();
            expect(mockGetMessage).not.toHaveBeenCalled();
        });

        test('should deny reply to message in Junk mailbox', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'Junk:3', body: 'Reply', mode: 'reply', identity: 'formal' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Access denied');
            expect(getText(result)).toContain('Junk');
            expect(mockGetMessage).not.toHaveBeenCalled();
        });

        test('should deny reply to message in Drafts mailbox', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'Drafts:2', body: 'Reply', mode: 'reply', identity: 'formal' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Access denied');
            expect(getText(result)).toContain('Drafts');
            expect(mockGetMessage).not.toHaveBeenCalled();
        });

        test('should allow reply to message in CleanInbox mailbox', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            expect(result.isError).toBeUndefined();
        });

        test('should allow reply to message in Archive mailbox', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'Archive:8', body: 'Reply', mode: 'reply', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(mockGetMessage).toHaveBeenCalledWith('Archive', 8);
        });

        test('should upload and submit reply immediately when sender is allowlisted', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                rateLimiter:    mockRateLimiter,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'My reply', mode: 'reply', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('Reply sent');
            expect(mockUploadMessage).toHaveBeenCalledTimes(1);
            expect(mockSubmitMessage).toHaveBeenCalledTimes(1);
        });

        test('should build reference object with reply action for reply mode', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.reference as Record<string, unknown>)?.action).toBe('reply');
            expect((payload.reference as Record<string, unknown>)?.id).toBe(42);
        });

        test('should build reference object with replyAll action for replyAll mode', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply all', mode: 'replyAll', identity: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.reference as Record<string, unknown>)?.action).toBe('replyAll');
        });

        test('should NOT include flags field in replyToEmail upload payload', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.flags).toBeUndefined();
        });

        test('should set draft flag to true in replyToEmail upload payload', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.draft).toBe(true);
        });

        test('should use informalAddress from getUserAddresses for informal identity in reply', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'informal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.from as { address: string }).address).toBe('informal@example.com');
            expect((payload.from as { name: string }).name).toBe('Izzy Informal');
        });

        test('should pass undefined cc to sendApprovalRequest in plain reply mode', async () => {
            const mockSendApprovalRequestReply = mock(async () => { /* intentionally empty */ });
            mockAllowlist.isAllowed = mock(() => false);

            const server = createEmailMCPServer({
                wildDuckClient:      mockReplyWildDuck,
                allowlist:           mockAllowlist,
                sendApprovalRequest: mockSendApprovalRequestReply,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            // In plain reply mode, cc should be undefined (not extracted from original.cc)
            expect(mockSendApprovalRequestReply).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(String),
                expect.any(Number),
                undefined
            );
        });

        test('should call getMailboxId with mailbox name to resolve mailbox ID', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            expect(mockGetMailboxId).toHaveBeenCalledWith('CleanInbox');
        });

        test('should include mailbox ID from getMailboxId in reference object', async () => {
            mockGetMailboxId = mock(() => 'mbx-clean-resolved');
            mockReplyWildDuck.getMailboxId = mockGetMailboxId;

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.reference as Record<string, unknown>)?.mailbox).toBe('mbx-clean-resolved');
        });

        test('should upload to Drafts and NOT submit when recipient not on allowlist', async () => {
            mockAllowlist.isAllowed = mock(() => false);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('pending admin approval');
            expect(mockUploadMessage).toHaveBeenCalledTimes(1);
            expect(mockSubmitMessage).not.toHaveBeenCalled();
        });

        test('should handle getMessage error gracefully', async () => {
            mockGetMessage = mock(async () => {
                throw new Error('getMessage failed');
            });
            mockReplyWildDuck.getMessage = mockGetMessage;

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('getMessage failed');
        });

        test('should return error when getMessage returns null', async () => {
            mockGetMessage = mock(() => Promise.resolve(null));
            mockReplyWildDuck.getMessage = mockGetMessage;

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('not found');
        });

        test('should include rate limit warning in reply when over limit', async () => {
            mockRateLimiter.isAtLimit       = mock(() => true);
            mockRateLimiter.tokensRemaining = mock(() => 0);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                rateLimiter:    mockRateLimiter,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('send rate limit reached');
        });

        test('should not include rate limit warning in reply result when limit is not reached', async () => {
            mockRateLimiter.isAtLimit = mock(() => false);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                rateLimiter:    mockRateLimiter,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            // When limit is NOT reached, result text should not contain warning
            const text = getText(result);
            expect(text).not.toContain('send rate limit reached');
        });

        test('should NOT store metaData with to address in upload payload (to is a message field)', async () => {
            mockAllowlist.isAllowed = mock(() => false);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            // metaData.to is no longer stored — to is part of the message itself
            expect((payload.metaData as Record<string, unknown> | undefined)?.to).toBeUndefined();
        });

        test('should use replyTo.address from WildDuck message for allowlist check when replyTo present', async () => {
            // WildDuck provides pre-parsed replyTo with .address — no regex needed
            mockGetMessage = mock(async () => ({
                ...originalEmail,
                replyTo: { address: 'john@example.com', name: 'John Smith' },
            }));
            mockReplyWildDuck.getMessage = mockGetMessage;
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            // Should succeed using the pre-parsed replyTo.address
            expect(result.isError).toBeUndefined();
            expect(mockAllowlist.isAllowed).toHaveBeenCalledWith('john@example.com');
        });

        test('should fall back to from.address when replyTo is absent in WildDuck message', async () => {
            // When WildDuck message has no replyTo, use from.address
            mockGetMessage = mock(async () => ({
                ...originalEmail,
                // no replyTo field
            }));
            mockReplyWildDuck.getMessage = mockGetMessage;
            mockAllowlist.isAllowed = mock(() => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            // from.address is 'alice@example.com'
            expect(mockAllowlist.isAllowed).toHaveBeenCalledWith('alice@example.com');
        });

        test('should pass allowlist check for allowlisted replyTo.address from WildDuck', async () => {
            // WildDuck provides pre-parsed address — allowlist check uses the address field directly
            mockGetMessage = mock(async () => ({
                ...originalEmail,
                replyTo: { address: 'john@example.com', name: 'John Smith' },
            }));
            mockReplyWildDuck.getMessage = mockGetMessage;
            // Allowlist allows only the bare address
            mockAllowlist.isAllowed = mock((addr: string) => addr === 'john@example.com');

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            // Should have been submitted (isAllowed returned true for john@example.com)
            expect(result.isError).toBeUndefined();
            expect(mockSubmitMessage).toHaveBeenCalledTimes(1);
        });

        test('should return error when getMailboxId returns undefined (Bug B)', async () => {
            // Bug B: getMailboxId returns undefined → must return error, NOT call uploadMessage
            mockGetMailboxId = mock(() => undefined);
            mockReplyWildDuck.getMailboxId = mockGetMailboxId;

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('not found in WildDuck');
            expect(mockUploadMessage).not.toHaveBeenCalled();
        });

        test('should return error from sendEmail when getUserAddresses returns empty array (no sender address)', async () => {
            mockReplyWildDuck.getUserAddresses = mock(async () => []);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            // Use a fresh server so addressesLoaded starts false
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', identity: 'formal' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('no sender address');
            expect(mockUploadMessage).not.toHaveBeenCalled();
        });

        test('should return error from replyToEmail when getUserAddresses returns empty array (no sender address)', async () => {
            mockReplyWildDuck.getUserAddresses = mock(async () => []);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', identity: 'formal' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('no sender address');
            expect(mockUploadMessage).not.toHaveBeenCalled();
        });
    });

    describe('replyToEmail tool - replyAll mode always requires approval', () => {
        let mockWildDuckReplyAll:            WildDuckClient;
        let mockAllowlistReplyAll:           EmailAllowlist;
        let mockUploadMessageReplyAll:       ReturnType<typeof mock>;
        let mockSubmitMessageReplyAll:       ReturnType<typeof mock>;
        let mockSendApprovalRequestReplyAll: ReturnType<typeof mock>;
        let mockGetMessageReplyAll:          ReturnType<typeof mock>;

        // WildDuck-format original email fixture for replyAll tests
        const originalEmailWithCc = {
            id:      42,
            subject: 'Group Discussion',
            from:    { name: 'Alice', address: 'alice@example.com' },
            to:      [{ address: 'me@example.com' }],
            cc:      [{ address: 'bob@example.com' }],
            text:    'Original body.',
        };

        beforeEach(() => {
            mockGetMessageReplyAll       = mock(async () => originalEmailWithCc);
            mockUploadMessageReplyAll    = mock(() => Promise.resolve(88));
            mockSubmitMessageReplyAll    = mock(async () => { /* intentionally empty */ });
            mockSendApprovalRequestReplyAll = mock(async () => { /* intentionally empty */ });
            mockWildDuckReplyAll = {
                getMessage:       mockGetMessageReplyAll,
                uploadMessage:    mockUploadMessageReplyAll,
                submitMessage:    mockSubmitMessageReplyAll,
                getUserAddresses: mock(async () => [
                    { id: '1', address: 'formal@example.com', name: 'Izzy Formal', main: false, tags: ['formal'] },
                ]),
                getMailboxId:          mock(() => 'mbx-clean'),
                updateMessageMetadata: mock(async () => { /* intentionally empty */ }),
            } as unknown as WildDuckClient;
            mockAllowlistReplyAll = {
                isAllowed: mock(() => true),
            } as unknown as EmailAllowlist;
        });

        test('replyAll should always route to approval even when primary recipient is on allowlist', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckReplyAll,
                allowlist:           mockAllowlistReplyAll,
                sendApprovalRequest: mockSendApprovalRequestReplyAll,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply all', mode: 'replyAll', identity: 'formal' });

            expect(result.isError).toBeUndefined();
            // Should NOT have submitted directly even though allowlist returns true
            expect(mockSubmitMessageReplyAll).not.toHaveBeenCalled();
            // Should have requested approval
            expect(mockSendApprovalRequestReplyAll).toHaveBeenCalledTimes(1);
            expect(getText(result)).toContain('pending admin approval');
        });

        test('replyAll should call sendApprovalRequest with (to, subject, uid, cc) — cc extracted from original message', async () => {
            const primaryTo = originalEmailWithCc.from.address;
            const subject   = `Re: ${originalEmailWithCc.subject}`;
            const uid       = 88;

            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckReplyAll,
                allowlist:           mockAllowlistReplyAll,
                sendApprovalRequest: mockSendApprovalRequestReplyAll,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply all', mode: 'replyAll', identity: 'formal' });

            // sendApprovalRequest is called with (to, subject, uid, cc) — cc extracted from original.cc
            expect(mockSendApprovalRequestReplyAll).toHaveBeenCalledWith(primaryTo, subject, uid, ['bob@example.com']);
        });

        test('replyAll upload payload should not contain cc (WildDuck derives recipients from reference object)', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckReplyAll,
                allowlist:           mockAllowlistReplyAll,
                sendApprovalRequest: mockSendApprovalRequestReplyAll,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply all', mode: 'replyAll', identity: 'formal' });

            const [_folder, payload] = mockUploadMessageReplyAll.mock.calls[0] as [string, Record<string, unknown>];
            // cc should NOT be in the upload payload — WildDuck derives it from the reference
            expect(payload.cc).toBeUndefined();
            expect((payload.metaData as Record<string, unknown> | undefined)?.cc).toBeUndefined();
        });
    });

    describe('deleteDraft tool', () => {
        let mockWildDuckDelete:   WildDuckClient;
        let mockDeleteMessage:    ReturnType<typeof mock>;

        beforeEach(() => {
            mockDeleteMessage = mock(async () => { /* intentionally empty */ });
            mockWildDuckDelete = {
                deleteMessage: mockDeleteMessage,
            } as unknown as WildDuckClient;
        });

        test('should delete draft and return success message', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete });
            const handler = getToolHandler(server, 'deleteDraft');

            const result: CallToolResult = await handler({ message: 'Drafts:42' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('Drafts:42');
            expect(getText(result)).toContain('deleted');
            expect(mockDeleteMessage).toHaveBeenCalledWith('Drafts', 42);
        });

        test('should parse UID from Drafts:UID format', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete });
            const handler = getToolHandler(server, 'deleteDraft');

            await handler({ message: 'Drafts:99' });

            expect(mockDeleteMessage).toHaveBeenCalledWith('Drafts', 99);
        });

        test('should return error when deleteMessage throws', async () => {
            mockDeleteMessage = mock(async () => {
                throw new Error('WildDuck delete failed');
            });
            mockWildDuckDelete.deleteMessage = mockDeleteMessage;

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete });
            const handler = getToolHandler(server, 'deleteDraft');

            const result: CallToolResult = await handler({ message: 'Drafts:42' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('WildDuck delete failed');
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        test('should have destructiveHint: true annotation', () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete });
            const toolDef = (server.instance as unknown as RegisteredToolInstance)._registeredTools.deleteDraft;
            expect(toolDef.annotations.destructiveHint).toBe(true);
        });
    });

    describe('amendAndResubmitDraft tool', () => {
        let mockWildDuckAmend:       WildDuckClient;
        let mockGetMessageAmend:     ReturnType<typeof mock>;
        let mockUploadMessageAmend:  ReturnType<typeof mock>;
        let mockGetUserAddresses:    ReturnType<typeof mock>;
        let mockSendApprovalRequest: ReturnType<typeof mock>;

        const originalDraft = {
            id:      42,
            subject: 'Original Subject',
            to:      [{ address: 'original-to@example.com' }],
            cc:      [] as { address: string }[],
            text:    'Original body text',
        };

        beforeEach(() => {
            mockGetMessageAmend    = mock(async () => originalDraft);
            mockUploadMessageAmend = mock(() => Promise.resolve(55));
            mockGetUserAddresses   = mock(async () => [
                { id: '1', address: 'formal@example.com',   name: 'Izzy Formal',   main: false, tags: ['formal']   },
                { id: '2', address: 'informal@example.com', name: 'Izzy Informal', main: false, tags: ['informal'] },
            ]);
            mockSendApprovalRequest = mock(async () => { /* intentionally empty */ });
            mockWildDuckAmend = {
                getMessage:            mockGetMessageAmend,
                uploadMessage:         mockUploadMessageAmend,
                getUserAddresses:      mockGetUserAddresses,
                updateMessageMetadata: mock(async () => { /* intentionally empty */ }),
                updateMessageFlags:    mock(async () => { /* intentionally empty */ }),
            } as unknown as WildDuckClient;
        });

        test('should read original draft, amend, and re-upload with replacePrevious', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            const result: CallToolResult = await handler({ message: 'Drafts:42', subject: 'Updated Subject' });

            expect(result.isError).toBeUndefined();
            // Routes through approval — result contains pending admin approval message with the UID
            expect(getText(result)).toContain('pending admin approval');
            expect(getText(result)).toContain('55');
            expect(mockGetMessageAmend).toHaveBeenCalledWith('Drafts', 42);
            const [_folder, payload] = mockUploadMessageAmend.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.subject).toBe('Updated Subject');
            expect(payload.replacePrevious).toEqual({ mailbox: 'Drafts', id: 42 });
        });

        test('should keep original subject when not provided', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42' });

            const [_folder, payload] = mockUploadMessageAmend.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.subject).toBe('Original Subject');
        });

        test('should NOT include flags field in amendAndResubmitDraft upload payload', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42' });

            const [_folder, payload] = mockUploadMessageAmend.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.flags).toBeUndefined();
        });

        test('should apply amended body text', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', body: 'New body text' });

            const [_folder, payload] = mockUploadMessageAmend.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.text).toBe('New body text');
        });

        test('should keep original body when not provided', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42' });

            const [_folder, payload] = mockUploadMessageAmend.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.text).toBe('Original body text');
        });

        test('should accept amended to address as plain string', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', to: 'new-to@example.com' });

            const [_folder, payload] = mockUploadMessageAmend.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.to).toEqual([{ address: 'new-to@example.com' }]);
        });

        test('should accept amended to as structured address object', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', to: { name: 'Craig', email_address: 'craig@rungie.com' } });

            const [_folder, payload] = mockUploadMessageAmend.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.to).toEqual([{ name: 'Craig', address: 'craig@rungie.com' }]);
        });

        test('should accept amended to as array of addresses', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', to: ['addr1@example.com', 'addr2@example.com'] });

            const [_folder, payload] = mockUploadMessageAmend.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.to).toEqual([{ address: 'addr1@example.com' }, { address: 'addr2@example.com' }]);
        });

        test('should keep original to addresses when not provided (already address objects from WildDuck)', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42' });

            const [_folder, payload] = mockUploadMessageAmend.mock.calls[0] as [string, Record<string, unknown>];
            // original.to is [{ address: 'original-to@example.com' }] from WildDuck — used directly
            expect(payload.to).toEqual([{ address: 'original-to@example.com' }]);
        });

        test('should call sendApprovalRequest with new UID after re-upload', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', subject: 'Updated' });

            expect(mockSendApprovalRequest).toHaveBeenCalledWith('original-to@example.com', 'Updated', 55, undefined);
        });

        test('should join multiple to addresses with ", " separator in sendApprovalRequest', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', to: ['addr1@example.com', 'addr2@example.com'] });

            // Two addresses joined with ', ' separator — validates join separator mutation
            expect(mockSendApprovalRequest).toHaveBeenCalledWith('addr1@example.com, addr2@example.com', expect.any(String), 55, undefined);
        });

        test('should return error when original draft not found', async () => {
            mockGetMessageAmend = mock(async () => null);
            mockWildDuckAmend.getMessage = mockGetMessageAmend;

            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            const result: CallToolResult = await handler({ message: 'Drafts:99' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('not found');
        });

        test('should return error when getMessage throws', async () => {
            mockGetMessageAmend = mock(async () => {
                throw new Error('WildDuck unavailable');
            });
            mockWildDuckAmend.getMessage = mockGetMessageAmend;

            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            const result: CallToolResult = await handler({ message: 'Drafts:42' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('WildDuck unavailable');
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        test('should return failure message when sendApprovalRequest fails', async () => {
            mockSendApprovalRequest = mock(async () => {
                throw new Error('Discord unavailable');
            });

            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            const result: CallToolResult = await handler({ message: 'Drafts:42' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('failed to notify admin');
            expect(getText(result)).toContain('check pending drafts manually');
            expect(mockLogger.warn).toHaveBeenCalled();
            // No flag setting — outbox handles retry now
            expect(mockWildDuckAmend.updateMessageFlags).not.toHaveBeenCalledWith('Drafts', 55, { addFlags: ['DiscordNotifyFailed'] });
        });

        test('should use formal from address when identity is formal', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', identity: 'formal' });

            const [_folder, payload] = mockUploadMessageAmend.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.from as { address: string }).address).toBe('formal@example.com');
            expect((payload.from as { name: string }).name).toBe('Izzy Formal');
        });

        test('should use informal from address when identity is informal', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', identity: 'informal' });

            const [_folder, payload] = mockUploadMessageAmend.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.from as { address: string }).address).toBe('informal@example.com');
            expect((payload.from as { name: string }).name).toBe('Izzy Informal');
        });

        test('should upload with draft flag set to true and no explicit flags field', async () => {
            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42' });

            const [_folder, payload] = mockUploadMessageAmend.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.draft).toBe(true);
            // flags field removed — draft: true is sufficient for WildDuck
            expect(payload.flags).toBeUndefined();
        });

        test('should return error when no sender address is configured', async () => {
            // getUserAddresses returns no formal/informal addresses
            mockGetUserAddresses = mock(async () => []);
            mockWildDuckAmend.getUserAddresses = mockGetUserAddresses;

            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            const result: CallToolResult = await handler({ message: 'Drafts:42', identity: 'formal' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('no sender address configured');
        });

        test('should fall back to empty strings when original has no subject or text', async () => {
            mockGetMessageAmend = mock(async () => ({ id: 42, to: [{ address: 'original-to@example.com' }] }));
            mockWildDuckAmend.getMessage = mockGetMessageAmend;

            const server = createEmailMCPServer({
                wildDuckClient:      mockWildDuckAmend,
                sendApprovalRequest: mockSendApprovalRequest,
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            const result: CallToolResult = await handler({ message: 'Drafts:42' });

            expect(result.isError).toBeUndefined();
            expect(mockUploadMessageAmend).toHaveBeenCalledWith(
                'Drafts',
                expect.objectContaining({ subject: '', text: '' })
            );
        });
    });
});

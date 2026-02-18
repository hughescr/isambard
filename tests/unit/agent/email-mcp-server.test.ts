/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import _ from 'lodash';
import { mockLogger } from '../../setup';
import { createEmailMCPServer } from '../../../src/agent/email-mcp-server';
import type { ImapConnection } from '../../../src/integrations/email/imap-connection';
import type { EmailCounterStore } from '../../../src/integrations/email/email-counters';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

describe('createEmailMCPServer', () => {
    let mockImap: ImapConnection;
    let mockCounters: EmailCounterStore;

    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();

        mockImap = {
            listUnread:   mock(async () => []),
            fetchMessage: mock(async () => ({
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
            })),
            setFlag:          mock(async () => { /* intentionally empty */ }),
            moveMessage:      mock(async () => { /* intentionally empty */ }),
            getMailboxCounts: mock(async () => ({ total: 5, unread: 1 })),
        } as unknown as ImapConnection;

        mockCounters = {
            getCounters: mock(async () => ({ total: 5, unread: 2 })),
            reset:       mock(async () => { /* intentionally empty */ }),
        } as unknown as EmailCounterStore;
    });

    // Helper to get tool handler from server instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Need to access private _registeredTools
    const getToolHandler = (server: any, toolName: string): (args: any) => Promise<CallToolResult> => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Accessing private property
        return server.instance._registeredTools[toolName].handler;
    };

    // Helper to extract text from CallToolResult
    const getText = (result: CallToolResult): string => {
        const content = result.content[0];
        if(content && 'text' in content && _.isString(content.text)) {
            return content.text;
        }
        return '';
    };

    describe('createEmailMCPServer function', () => {
        test('should create MCP server with correct properties', () => {
            const server = createEmailMCPServer(mockImap, mockCounters);

            expect(server).toBeDefined();
            expect(server.name).toBe('email');
            expect(server.instance).toBeDefined();
            expect(server.type).toBe('sdk');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing server version
            expect((server.instance as any).server._serverInfo.version).toBe('1.0.0');
        });

        test.each([
            ['checkInbox',      'Check CleanInbox for unread emails. Returns counter state and list of unread message summaries.'],
            ['getEmailContent', 'Fetch the full content of an email by UID. Marks the email as read and decrements the unread counter.'],
            ['archiveEmail',    'Move an email from CleanInbox to Archive. Decrements the total email counter.'],
        ])('should have %s tool with correct description', (toolName, expectedDescription) => {
            const server = createEmailMCPServer(mockImap, mockCounters);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Accessing registered tools
            const toolDef = (server.instance as any)._registeredTools[toolName] as { description: string };

            expect(toolDef.description).toBe(expectedDescription);
        });

        test.each([
            ['checkInbox',      { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }],
            ['getEmailContent', { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
            ['archiveEmail',    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
        ])('should have %s tool with correct annotations', (toolName, expectedAnnotations) => {
            const server = createEmailMCPServer(mockImap, mockCounters);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- Accessing registered tools
            const toolDef = (server.instance as any)._registeredTools[toolName];

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Checking tool annotations
            expect(toolDef.annotations).toEqual(expectedAnnotations);
        });
    });

    describe('checkInbox tool', () => {
        test('should return counters and message list when there are unread messages', async () => {
            mockCounters.getCounters = mock(async () => ({ total: 10, unread: 3 }));
            mockImap.listUnread = mock(async () => [
                { uid: 1, from: { name: 'Alice', address: 'alice@example.com' }, subject: 'Hello', date: new Date('2025-01-01T10:00:00.000Z') },
                { uid: 2, from: { address: 'bob@example.com' },                  subject: 'World', date: new Date('2025-01-01T11:00:00.000Z') },
            ]);

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({});

            expect(result.content).toBeDefined();
            expect(result.content[0]?.type).toBe('text');
            expect(result.isError).toBeUndefined();

            const parsed = JSON.parse(getText(result)) as {
                counters: { total: number, unread: number }
                messages: { uid: number, from: string, subject: string, date: string }[]
            };
            expect(parsed.counters.total).toBe(10);
            expect(parsed.counters.unread).toBe(3);
            expect(parsed.messages).toHaveLength(2);
            expect(parsed.messages[0]?.uid).toBe(1);
            expect(parsed.messages[0]?.subject).toBe('Hello');
            expect(parsed.messages[1]?.uid).toBe(2);
            expect(parsed.messages[1]?.subject).toBe('World');
        });

        test('should return empty messages list when no unread messages', async () => {
            mockCounters.getCounters = mock(async () => ({ total: 5, unread: 0 }));
            mockImap.listUnread = mock(async () => []);

            const server = createEmailMCPServer(mockImap, mockCounters);
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

        test('should handle IMAP error gracefully', async () => {
            mockImap.listUnread = mock(async () => {
                throw new Error('IMAP connection failed');
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Error: IMAP connection failed');
        });

        test('should handle counter error gracefully', async () => {
            mockCounters.getCounters = mock(async () => {
                throw new Error('DynamoDB timeout');
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Error: DynamoDB timeout');
        });

        test('should handle non-Error IMAP failure gracefully', async () => {
            mockImap.listUnread = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw 'IMAP error string';
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({});

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('IMAP error string');
        });

        test('should call listUnread with CleanInbox folder', async () => {
            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'checkInbox');

            await handler({});

            expect(mockImap.listUnread).toHaveBeenCalledWith('CleanInbox');
        });
    });

    describe('getEmailContent tool', () => {
        test('should fetch email and return formatted content', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 42 });

            expect(result.isError).toBeUndefined();
            const text = getText(result);
            expect(text).toContain('From: Alice Smith <alice@example.com>');
            expect(text).toContain('To: Bob <bob@example.com>');
            expect(text).toContain('Subject: Meeting tomorrow');
            expect(text).toContain('Let us meet at noon.');
        });

        test('should mark email as Seen and sync counters from IMAP', async () => {
            mockImap.getMailboxCounts = mock(async () => ({ total: 8, unread: 3 }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            await handler({ uid: 42 });

            expect(mockImap.fetchMessage).toHaveBeenCalledWith('CleanInbox', 42);
            expect(mockImap.setFlag).toHaveBeenCalledWith(42, 'CleanInbox', '\\Seen');
            expect(mockImap.getMailboxCounts).toHaveBeenCalledWith('CleanInbox');
            expect(mockCounters.reset).toHaveBeenCalledWith(8, 3);
        });

        test('should still return email content when getMailboxCounts fails', async () => {
            mockImap.getMailboxCounts = mock(async () => {
                throw new Error('IMAP STATUS failed');
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 42 });

            // Email content returned despite counter sync failure
            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('From:');
            expect(mockLogger.warn).toHaveBeenCalled();
            expect(mockCounters.reset).not.toHaveBeenCalled();
        });

        test('should still return email content when reset fails', async () => {
            mockImap.getMailboxCounts = mock(async () => ({ total: 4, unread: 2 }));
            mockCounters.reset = mock(async () => {
                throw new Error('DynamoDB error');
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 42 });

            // Email content returned despite counter sync failure
            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('From:');
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        test('setFlag called before counter sync', async () => {
            const callOrder: string[] = [];
            mockImap.setFlag = mock(async () => {
                callOrder.push('setFlag');
            });
            mockImap.getMailboxCounts = mock(async () => {
                callOrder.push('getMailboxCounts');
                return { total: 5, unread: 1 };
            });
            mockCounters.reset = mock(async () => {
                callOrder.push('reset');
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            await handler({ uid: 42 });

            expect(callOrder).toEqual(['setFlag', 'getMailboxCounts', 'reset']);
        });

        test('should handle missing email error gracefully', async () => {
            mockImap.fetchMessage = mock(async () => {
                throw new Error('Message UID 99 not found in CleanInbox');
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 99 });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Error: Message UID 99 not found in CleanInbox');
        });

        test('should handle non-Error fetch failure gracefully', async () => {
            mockImap.fetchMessage = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw { code: 'IMAP_ERR' };
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Error:');
        });

        test('should include date in formatted output', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            const text = getText(result);
            expect(text).toContain('Date:');
            expect(text).toContain('2025');
        });

        test('should format From without name when name is absent', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            const text = getText(result);
            expect(text).toContain('noname@example.com');
            // Should NOT include angle-bracket format when name is absent
            expect(text).not.toContain(' <noname@example.com>');
        });

        test('should format From with name when name is present', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            const text = getText(result);
            expect(text).toContain('From: Alice Smith <alice@example.com>');
        });

        test('should join multiple To addresses with comma and space', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            const text = getText(result);
            expect(text).toContain('To: Alice <alice@example.com>, bob@example.com');
        });

        test('should include Cc header when cc is non-empty', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            const text = getText(result);
            expect(text).toContain('Cc: Carol <carol@example.com>');
        });

        test('should omit Cc header when cc is empty', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            const text = getText(result);
            expect(text).not.toContain('Cc:');
        });

        test('should include multiple Cc addresses comma-separated', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            const text = getText(result);
            expect(text).toContain('Cc: cc1@example.com, CC Two <cc2@example.com>');
        });

        test('should have a blank line between headers and body', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            const text = getText(result);
            // Blank line between headers and body means two consecutive newlines
            expect(text).toContain('\n\nBody content here');
        });

        test('should not have leading newline when cc is empty', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            const text = getText(result);
            expect(_.startsWith(text, '\n')).toBe(false);
            expect(_.startsWith(text, 'From:')).toBe(true);
        });

        test('should not have leading newline when cc is non-empty', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            const text = getText(result);
            expect(_.startsWith(text, '\n')).toBe(false);
            expect(_.startsWith(text, 'From:')).toBe(true);
        });

        test('should have Subject immediately after To when cc is empty (no spurious blank line)', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            const text = getText(result);
            const lines = _.split(text, '\n');
            const toIndex = _.indexOf(lines, 'To: recipient@example.com');
            const subjectIndex = _.indexOf(lines, 'Subject: No Blank Line');
            expect(toIndex).toBeGreaterThanOrEqual(0);
            expect(subjectIndex).toBe(toIndex + 1);
        });

        test('should not include extra text in output when cc is empty', async () => {
            mockImap.fetchMessage = mock(async () => ({
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
            }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'getEmailContent');

            const result: CallToolResult = await handler({ uid: 1 });

            const text = getText(result);
            // When cc is empty, the undefined sentinel is filtered out — no blank line between To: and Subject:
            const splitLines = _.split(text, '\n');
            const toIndex = _.indexOf(splitLines, 'To: recipient@example.com');
            const subjectIndex = _.indexOf(splitLines, 'Subject: No CC Test');
            expect(toIndex).toBeGreaterThanOrEqual(0);
            expect(subjectIndex).toBeGreaterThanOrEqual(0);
            // Subject: immediately follows To: (no blank line between them when cc is absent)
            expect(subjectIndex).toBe(toIndex + 1);
        });
    });

    describe('archiveEmail tool', () => {
        test('should move email and sync counters from IMAP', async () => {
            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ uid: 7 });

            expect(result.isError).toBeUndefined();
            expect(mockImap.moveMessage).toHaveBeenCalledWith(7, 'CleanInbox', 'Archive');
            expect(mockImap.getMailboxCounts).toHaveBeenCalledWith('CleanInbox');
            expect(mockCounters.reset).toHaveBeenCalledTimes(1);
            const text = getText(result);
            expect(text).toContain('7');
            expect(text).toContain('archived');
        });

        test('should handle move error gracefully', async () => {
            mockImap.moveMessage = mock(async () => {
                throw new Error('Move failed: folder not found');
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ uid: 7 });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Error: Move failed: folder not found');
        });

        test('should handle non-Error move failure gracefully', async () => {
            mockImap.moveMessage = mock(async () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error throw
                throw 'Network timeout';
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ uid: 3 });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Network timeout');
        });

        test('should not sync counter when move fails', async () => {
            mockImap.moveMessage = mock(async () => {
                throw new Error('Move failed');
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'archiveEmail');

            await handler({ uid: 7 });

            expect(mockCounters.reset).not.toHaveBeenCalled();
        });

        test('should sync total and unread counters from IMAP after successful archive', async () => {
            mockImap.getMailboxCounts = mock(async () => ({ total: 12, unread: 4 }));

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ uid: 7 });

            expect(result.isError).toBeUndefined();
            expect(mockImap.getMailboxCounts).toHaveBeenCalledWith('CleanInbox');
            expect(mockCounters.reset).toHaveBeenCalledWith(12, 4);
        });

        test('should still return success when getMailboxCounts fails after archive', async () => {
            mockImap.getMailboxCounts = mock(async () => {
                throw new Error('IMAP STATUS failed');
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ uid: 7 });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('archived');
            expect(mockLogger.warn).toHaveBeenCalled();
            expect(mockCounters.reset).not.toHaveBeenCalled();
        });

        test('should still return success when reset fails after archive', async () => {
            mockCounters.reset = mock(async () => {
                throw new Error('DynamoDB error');
            });

            const server = createEmailMCPServer(mockImap, mockCounters);
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ uid: 7 });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('archived');
            expect(mockLogger.warn).toHaveBeenCalled();
        });
    });
});

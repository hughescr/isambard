import { describe, test, expect, beforeEach, afterEach, mock, spyOn, jest } from 'bun:test';
import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildAdminRejectedSubsection } from '../../../src/agent/context-builder';
import { buildAttachments, MAX_ATTACHMENT_BYTES, type ContainedFileReader } from '../../../src/agent/email-attachments';
import { createEmailMCPServer, type EmailApprovalCardPort, type RestrictedMailboxNotification } from '../../../src/agent/email-mcp-server';
import { EMAIL_TOOL_ERROR_SENTENCES, type EmailToolErrorCode } from '../../../src/agent/email-tool-errors';
import { PathSecurityError } from '../../../src/errors';
import { ApprovalCardEditGate } from '../../../src/integrations/discord/approvals/card-edit-gate';
import { EmailOutboundApprovals } from '../../../src/integrations/email/outbound-approvals';
import { WildDuckAuthError, WildDuckError, type AttachmentStream, type WildDuckClient, type WildDuckMessage, type WildDuckMessageAttachment, type WildDuckSearchPage, type WildDuckSearchPageRequest, type WildDuckSearchRow, type WildDuckUploadPayload } from '../../../src/integrations/email/wildduck-client';
import type { ApprovedOutboundAction } from '../../../src/services';
import type { ServiceHealthRegistry } from '../../../src/services/health-registry';
import type { TokenBucketRateLimiter } from '../../../src/services/rate-limiters/token-bucket';
import type { ServiceHealthEntry } from '../../../src/services/types';
import type { PersonAllowlist } from '../../../src/storage';
import * as utils from '../../../src/utils';
import { callSdkTool } from '../../helpers/sdk-mcp-client';
import { mockLogger, mockFsPromises, resetMockFs } from '../../setup';

/** A draft preview token: 32 random bytes as base64url (#158). */
const PREVIEW_TOKEN_RE = /^[\w-]{43}$/u;

/** Minimal offline-state ServiceHealthRegistry double for the getRejectedDrafts health-guard test. */
function makeOfflineHealthRegistry(): ServiceHealthRegistry {
    const offlineEntry: ServiceHealthEntry = { state: 'offline', epoch: 0, failureCount: 1 };
    return {
        isAvailable:        mock(() => false),
        getEntry:           mock(() => offlineEntry),
        getState:           mock(() => 'offline' as const),
        getAll:             mock(() => ({}) as ReturnType<ServiceHealthRegistry['getAll']>),
        sendEvent:          mock(() => undefined),
        subscribe:          mock(() => () => undefined),
        buildStatusSummary: mock(() => undefined),
        stop:               mock(() => undefined),
    };
}

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: {
        shape:          Record<string, unknown>
        safeParseAsync: (args: unknown) => Promise<
            { success: true, data: unknown } | { success: false, error: { issues: { path: PropertyKey[], message: string }[] } }
        >
    }
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool>, server: { _serverInfo: { version: string } } }

/** An approval card port whose present() is `present` (other methods are inert unless overridden). */
function cardPort(present: ReturnType<typeof mock>, overrides: Partial<EmailApprovalCardPort> = {}): EmailApprovalCardPort {
    return {
        present,
        markDeleted:    mock(async () => undefined),
        markSuperseded: mock(async () => true),
        ...overrides,
    };
}

/** Izzy's working directory in these tests: the only place attachments are read from. */
const ATTACHMENT_ROOT = '/work/izzy';

/**
 * A contained attachment reader over an in-memory tree: each path relative to the root and its
 * content (a function for any path); a missing one is refused as not found, like the real reader.
 */
function attachmentFiles(files: Partial<Record<string, string>> | ((relPath: string) => string)): ReturnType<typeof mock<ContainedFileReader>> {
    return mock<ContainedFileReader>(async (_root, relPath, maxBytes) => {
        const content = typeof files === 'function' ? files(relPath) : files[relPath];
        if(content === undefined) {
            throw new PathSecurityError(`File not found: ${relPath}`, relPath, 'not_found');
        }
        const bytes = Buffer.from(content);
        if(bytes.length > maxBytes) {
            throw new PathSecurityError(`File is larger than the ${maxBytes}-byte limit: ${relPath}`, relPath, 'too_large');
        }
        return { bytes, size: bytes.length };
    });
}

async function drainMicrotasks(ticks = 10): Promise<void> {
    for(let i = 0; i < ticks; i++) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
        await Promise.resolve();
    }
}

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
            // WildDuck methods used in email operations (in addition to the base methods above)
            listMessages:     mock(async () => []),
            getFullMessage:   mock(async () => ({
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
            })),
            updateMessageFlags: mock(async () => { /* intentionally empty */ }),
            // Echoes the source uid back as the destination uid by default (as a real move often
            // does); tests covering the destination-uid behaviour override this with a distinct value.
            moveMessage:        mock(async (_source: string, uid: number, _dest: string) => uid),
            getAttachment:      mock(async () => Buffer.from('attachment-data')),
        } as unknown as WildDuckClient;
    });

    afterEach(() => {
        resetMockFs();
    });

    // Exercise handlers with the same transformed input shape that MCP supplies at runtime.
    const getToolHandler = (server: ReturnType<typeof createEmailMCPServer>, toolName: string): ((args: unknown) => Promise<CallToolResult>) => {
        const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];
        return async (args: unknown): Promise<CallToolResult> => {
            const parsed = await registeredTool.inputSchema.safeParseAsync(args);
            if(!parsed.success) {
                throw new Error(parsed.error.issues.map(issue => issue.message).join('; '));
            }
            return registeredTool.handler(parsed.data);
        };
    };

    const firstMockCall = <TArgs extends readonly unknown[]>(calls: readonly TArgs[]): TArgs | undefined => calls.at(0);

    // Helper to extract text from CallToolResult
    const getText = (result: CallToolResult): string => {
        const record: unknown = result.content[0];
        if(record !== null && typeof record === 'object' && 'text' in record && typeof record.text === 'string') {
            return record.text;
        }
        return '';
    };

    /** The reference the last logged email tool failure carried, which its tool text repeats. */
    const lastFailureReference = (): string => {
        const entry = mockLogger.warn.mock.calls.map(([logged]) => logged as { msg?: string, reference?: string }).findLast(logged => logged.msg === 'Email tool failed');
        return entry?.reference ?? 'no failure logged';
    };

    /** The classified tool text for a failure of `tool` with `code`, carrying the last logged reference. */
    const failureText = (tool: string, code: EmailToolErrorCode): string => `${tool} failed (${code}): ${EMAIL_TOOL_ERROR_SENTENCES[code]} Reference: ${lastFailureReference()}.`;

    /** A WildDuck call that hangs until `signal` aborts, then rejects with its reason; an already-aborted signal rejects at once. */
    const untilAborted = async (signal: AbortSignal | undefined): Promise<never> => new Promise<never>((_resolve, reject) => {
        if(signal?.aborted) {
            reject(signal.reason as Error);
        }
        signal?.addEventListener('abort', () => {
            reject(signal.reason as Error);
        });
    });

    const realCreateDeadline = utils.createDeadline;

    /** Replaces the `ms` deadline with one this test aborts, leaving every other deadline real. */
    const controlDeadline = (ms: number): { controller: AbortController, clear: ReturnType<typeof mock>, spy: ReturnType<typeof spyOn<typeof utils, 'createDeadline'>> } => {
        const controller = new AbortController();
        const clear = mock(() => undefined);
        const spy = spyOn(utils, 'createDeadline').mockImplementation(duration => (duration === ms ? { signal: controller.signal, clear } : realCreateDeadline(duration)));
        return { controller, clear, spy };
    };

    test('a missing attachment file is named as given in a plain refusal', async () => {
        const read = attachmentFiles({});
        const result = await buildAttachments({ root: ATTACHMENT_ROOT, read }, ['missing-003.txt']);
        expect(result).toEqual({ problem: 'the attachment "missing-003.txt" was not found' });
    });

    test('attachment failure reports the specific file that failed, not always the first path', async () => {
        const read = attachmentFiles({ 'ok-001.txt': 'ok' });
        const result = await buildAttachments({ root: ATTACHMENT_ROOT, read }, ['ok-001.txt', '/work/izzy/missing-002.txt']);
        expect(result).toEqual({ problem: 'the attachment "/work/izzy/missing-002.txt" was not found' });
    });

    describe('createEmailMCPServer function', () => {
        test('registers every email capability with agent-readable parameter guidance', () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const registered = (server.instance as unknown as RegisteredToolInstance)._registeredTools;
            expect(Object.keys(registered).toSorted((a, b) => a.localeCompare(b))).toEqual([
                'amendAndResubmitDraft', 'archiveEmail', 'checkInbox', 'deleteDraft',
                'getEmailContent', 'getEmailThread', 'getRejectedDrafts', 'replyToEmail', 'searchEmail', 'sendEmail',
            ]);
            const undocumented: string[] = [];
            for(const [name, definition] of Object.entries(registered)) {
                expect(definition.description.length).toBeGreaterThan(0);
                for(const [parameter, schema] of Object.entries(definition.inputSchema.shape)) {
                    if(!((schema as { description?: string }).description?.length)) {
                        undocumented.push(`${name}.${parameter}`);
                    }
                }
            }
            expect(undocumented).toEqual([]);
        });

        test.each([
            ['getEmailContent', { message: 'CleanInbox:42' }, { message: ':42' }, 'Folder:UID'],
            ['archiveEmail', { message: 'CleanInbox:42' }, { message: 'CleanInbox:42x' }, 'Folder:UID'],
            ['replyToEmail', { message: 'CleanInbox:42', body: 'reply', mode: 'reply', senderProfile: 'formal' }, { message: 'CleanInbox:42x', body: 'reply', mode: 'reply', senderProfile: 'formal' }, 'Folder:UID'],
            ['deleteDraft', { message: 'Drafts:42' }, { message: 'NotDrafts:42' }, 'Drafts:UID'],
            ['amendAndResubmitDraft', { message: 'Drafts:42' }, { message: 'Drafts:42x' }, 'Folder:UID'],
        ])('%s validates mailbox references with a useful schema error', async (toolName, valid, invalid, format) => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const schema = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName].inputSchema;
            const validResult = await schema.safeParseAsync(valid);
            expect(validResult.success).toBe(true);
            const result = await schema.safeParseAsync(invalid);
            expect(result.success).toBe(false);
            if(!result.success) {
                expect(result.error.issues.some(issue => issue.path.includes('message') && issue.message.includes(format))).toBe(true);
            }
        });

        test('describes bodyFormat on every body-taking tool: when markdown helps, what is literal, what the admin sees, and the limits', () => {
            const registered = (createEmailMCPServer({ wildDuckClient: mockWildDuck }).instance as unknown as RegisteredToolInstance)._registeredTools;
            const describedAs = (toolName: string, field: string): string | undefined => (registered[toolName].inputSchema.shape[field] as { description?: string }).description;
            const markdown = 'How body is written: "text" (the default) sends it exactly as written, as plain text only; "markdown" renders it. Use markdown when formatting helps the reader: lists, links, emphasis, headings, quotes, code or tables. The email then has a plain-text version and an HTML version, both rendered from your markdown. The plain-text version shows each link as its text and then its whole destination in brackets ("the docs [https://example.com/docs]"), or just once when the text is exactly the destination, or is the address of a mailto: to that address. Raw HTML in the markdown is shown literally, never interpreted, and images are never embedded (each becomes a link to its URL). A link is clickable only when its destination is at most 2048 characters and is either an absolute http:// or https:// URL with a host and no user name or password, or mailto: and one plain address (no ?subject= or other query, one recipient); any other link is shown as its text and destination, not clickable. The admin sees the plain-text version on the approval card and both versions in the preview. Limits: 64 KB of markdown, 90 KB of rendered text, 500 KB of rendered HTML; lists and quotes cannot nest deeply.';

            expect(describedAs('sendEmail', 'bodyFormat')).toBe(markdown);
            expect(describedAs('replyToEmail', 'bodyFormat')).toBe(markdown);
            expect(describedAs('amendAndResubmitDraft', 'bodyFormat')).toBe(`How the new body is written; give it only with body. ${markdown} A new plain-text body removes the draft's HTML version.`);
            expect(describedAs('sendEmail', 'body')).toBe('Email body: plain text, or markdown with bodyFormat "markdown"');
            expect(describedAs('replyToEmail', 'body')).toBe('Reply body: plain text, or markdown with bodyFormat "markdown"');
        });

        test('bodyFormat accepts only "text" and "markdown", and may be omitted', async () => {
            const schema = (createEmailMCPServer({ wildDuckClient: mockWildDuck }).instance as unknown as RegisteredToolInstance)._registeredTools.sendEmail.inputSchema;
            const base = { to: 'a@example.com', subject: 's', body: 'b' };

            const results = await Promise.all([base, { ...base, bodyFormat: 'text' }, { ...base, bodyFormat: 'markdown' }, { ...base, bodyFormat: 'html' }].map(async args => schema.safeParseAsync(args)));

            expect(results.map(result => result.success)).toEqual([true, true, true, false]);
        });

        test('exposes senderProfile without the legacy identity tool parameter', () => {
            const registered = (createEmailMCPServer({ wildDuckClient: mockWildDuck }).instance as unknown as RegisteredToolInstance)._registeredTools;
            for(const [name, description] of [
                ['sendEmail', 'Sender profile for the From address: formal or informal (default: formal)'],
                ['replyToEmail', 'Sender profile for the From address: formal or informal (default: formal)'],
                ['amendAndResubmitDraft', 'Sender profile for the From address: formal or informal'],
            ] as const) {
                const shape = registered[name].inputSchema.shape;
                expect(shape).toHaveProperty('senderProfile');
                expect(shape).not.toHaveProperty('identity');
                expect((shape.senderProfile as { description?: string }).description).toBe(description);
            }
        });

        test('rejects missing fields in a structured recipient', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const schema = (server.instance as unknown as RegisteredToolInstance)._registeredTools.sendEmail.inputSchema;
            const validResult = await schema.safeParseAsync({
                to: { name: 'Alice', email_address: 'alice@example.com' }, subject: 'Hello', body: 'Hi', senderProfile: 'formal',
            });
            const invalidResult = await schema.safeParseAsync({ to: { unknown: 'alice@example.com' }, subject: 'Hello', body: 'Hi', senderProfile: 'formal' });
            expect(validResult.success).toBe(true);
            expect(invalidResult.success).toBe(false);
        });

        test('mailbox UID schemas reject partial regex matches', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const tools = (server.instance as unknown as RegisteredToolInstance)._registeredTools;
            const mailbox = tools.getEmailContent.inputSchema;
            const drafts = tools.deleteDraft.inputSchema;
            const mailboxResults = await Promise.all(['junk\nCleanInbox:42', 'CleanInbox:42x'].map(message => mailbox.safeParseAsync({ message })));
            const draftResults = await Promise.all(['XDrafts:42', 'Drafts:42x'].map(message => drafts.safeParseAsync({ message })));
            expect(mailboxResults.every(result => !result.success)).toBe(true);
            expect(draftResults.every(result => !result.success)).toBe(true);
        });

        test('search mailbox scope accepts only the mailboxes Izzy can read', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const schema = (server.instance as unknown as RegisteredToolInstance)._registeredTools.searchEmail.inputSchema;
            const validResults = await Promise.all(['CleanInbox', 'Archive', 'Drafts', 'Sent Mail'].map(mailbox => schema.safeParseAsync({ mailbox })));
            const invalidResult = await schema.safeParseAsync({ mailbox: 'NotAFolder' });
            expect(validResults.every(result => result.success)).toBe(true);
            expect(invalidResult.success).toBe(false);
        });

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
            ['getEmailContent', 'Fetch the full content of an email by its Mailbox:UID reference and mark it as read. An HTML email\'s body is its HTML converted to text, each link shown as "label [url]"; a body over the size limit is cut, and its last line then says how much of it is shown.'],
            ['archiveEmail',      'Move an email from CleanInbox to Archive.'],
            ['getRejectedDrafts', 'List drafts rejected by admin review.'],
        ])('should have %s tool with correct description', (toolName, expectedDescription) => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const toolDef = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(toolDef.description).toBe(expectedDescription);
        });

        test.each([
            ['checkInbox',       { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }],
            ['getEmailContent',  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
            ['archiveEmail',     { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
            ['searchEmail',      { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }],
            ['sendEmail',        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }],
            ['replyToEmail',     { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }],
            ['deleteDraft',      { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: false }],
            ['amendAndResubmitDraft', { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }],
            ['getRejectedDrafts', { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false }],
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

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('checkInbox', 'unavailable') }], isError: true });
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'checkInbox', detail: 'listMessages connection failed', msg: 'Email tool failed' }));
        });

        test('should handle WildDuck getMailboxCounts timeout gracefully', async () => {
            mockWildDuck.getMailboxCounts = mock(async () => {
                throw new DOMException('The operation timed out.', 'TimeoutError');
            });

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({});

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('checkInbox', 'timeout') }], isError: true });
        });

        test('should handle non-Error listMessages failure gracefully', async () => {
            mockWildDuck.listMessages = mock(async () => {
                throw 'listMessages error string';
            });

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'checkInbox');

            const result: CallToolResult = await handler({});

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('checkInbox', 'unavailable') }], isError: true });
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'checkInbox', error: 'string', detail: 'listMessages error string' }));
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
        test('logs the read tool identity when WildDuck fails', async () => {
            mockWildDuck.getFullMessage = mock(async () => {
                throw new Error('read failed');
            });
            const handler = getToolHandler(createEmailMCPServer({ wildDuckClient: mockWildDuck }), 'getEmailContent');
            const result = await handler({ message: 'CleanInbox:42' });
            expect(result).toEqual({ content: [{ type: 'text', text: failureText('getEmailContent', 'unavailable') }], isError: true });
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'getEmailContent', detail: 'read failed', msg: 'Email tool failed' }));
        });

        test('should fetch email and return formatted content using Mailbox:UID format', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            42,
                messageId:      '<msg42@example.com>',
                from:           { name: 'Alice Smith', address: 'alice@example.com' },
                to:             [{ name: 'Bob', address: 'bob@example.com' }],
                cc:             [],
                subject:        'Meeting tomorrow',
                date:           new Date('2025-01-15T09:00:00.000Z'),
                bodyText:       'Let us meet at noon.  ',
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
            expect(text).toBe('From: Alice Smith <alice@example.com>\nTo: Bob <bob@example.com>\nSubject: Meeting tomorrow\nDate: 2025-01-15T09:00:00.000Z\n\nLet us meet at noon.');
        });

        test('ends with the body\'s truncation note when the body was cut', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            42,
                messageId:      '<msg42@example.com>',
                from:           { address: 'alice@example.com' },
                to:             [],
                cc:             [],
                subject:        'Digest',
                date:           new Date('2025-01-15T09:00:00.000Z'),
                bodyText:       'See [https://example.com/p]\n[body truncated: showing the first 28 of 90000 bytes]',
                hasAttachments: false,
                headers:        {},
                attachments:    [],
                attachmentMeta: [],
            }));

            const result = await getToolHandler(createEmailMCPServer({ wildDuckClient: mockWildDuck }), 'getEmailContent')({ message: 'CleanInbox:42' });

            expect(getText(result).endsWith('\n\nSee [https://example.com/p]\n[body truncated: showing the first 28 of 90000 bytes]')).toBe(true);
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
            expect(mockLogger.warn).toHaveBeenCalledWith({
                error: 'Discord channel send failed',
                msg:   'Failed to send restricted mailbox notification',
            });
        });

        test('should include message reference in admin notification', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck, sendAdminNotification: mockSendAdminNotification });
            const handler = getToolHandler(server, 'getEmailContent');

            await handler({ message: 'Quarantine:42' });

            const callArg = mockSendAdminNotification.mock.calls[0]?.[0] as RestrictedMailboxNotification;
            expect(callArg).toBeDefined();
            expect(callArg.folder).toBe('Quarantine');
            expect(callArg.uid).toBe(42);
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

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('getEmailContent', 'unavailable') }], isError: true });
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
            expect(mockFsPromises.mkdir).toHaveBeenCalledWith(expect.stringContaining('/attachments/email-'), { recursive: true });
            expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(1);
            // Check that getAttachment was called with correct params
            expect(mockWildDuck.getAttachment).toHaveBeenCalledWith('CleanInbox', 42, 'att-1');
            // Check that writeFile was called with correct path and data
            const writeFileCall = firstMockCall(mockFsPromises.writeFile.mock.calls);
            expect(writeFileCall?.[0]).toContain('report.pdf');
            expect(writeFileCall?.[0]).toContain('email-');
            expect(writeFileCall?.[1] as unknown as Buffer).toEqual(pdfData);
            // Attachment section in output
            const text = getText(result);
            expect(text).toContain('Attachments:');
            expect(text).toContain('report.pdf');
            expect(text).toContain('application/pdf');
            expect(text.split('\nAttachments:\n').at(1)?.split('\n')).toEqual([`- ${String(writeFileCall?.[0]).slice(process.cwd().length + 1)} (application/pdf)`]);
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

        test('fetches independent attachments with a bound of two and keeps display order', async () => {
            const firstGate = Promise.withResolvers<void>();
            const thirdStarted = Promise.withResolvers<void>();
            let active = 0;
            let maxActive = 0;
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            66,
                messageId:      '<concurrent@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Three files',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'See files',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: ['first.pdf', 'second.pdf', 'third.pdf'].map((filename, index) => ({
                    id:          `att-${index + 1}`,
                    filename,
                    contentType: 'application/pdf',
                    sizeKb:      1,
                })),
            }));
            mockFsPromises.access.mockRejectedValue(new Error('ENOENT'));
            mockWildDuck.getAttachment = mock(async (_mailbox: string, _uid: number, id: string) => {
                active++;
                maxActive = Math.max(maxActive, active);
                if(id === 'att-1') {
                    await firstGate.promise;
                }
                if(id === 'att-3') {
                    thirdStarted.resolve();
                }
                active--;
                return Buffer.from(id);
            });
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');
            const pending = handler({ message: 'CleanInbox:66' });

            try {
                await Promise.race([
                    thirdStarted.promise,
                    drainMicrotasks(200).then(() => { throw new Error('third attachment did not start before the first completed'); }),
                ]);
                expect(maxActive).toBe(2);
            } finally {
                firstGate.resolve();
            }

            const text = getText(await pending);
            const attachmentLines = text.split('\nAttachments:\n')[1]?.split('\n') ?? [];
            expect(attachmentLines.map(line => /(?:first|second|third)\.pdf/.exec(line)?.[0])).toEqual(['first.pdf', 'second.pdf', 'third.pdf']);
        });

        test('should use the mailbox and UID for the attachment directory name', async () => {
            const expectedHash = createHash('sha1').update(JSON.stringify(['CleanInbox', 99])).digest('hex');
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            99,
                messageId:      '<unique-msg-id@example.com>',
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

            const mkdirCall = firstMockCall(mockFsPromises.mkdir.mock.calls);
            expect(mkdirCall?.[0]).toContain(`email-${expectedHash}`);
        });

        test('should include email- prefix in attachment path in output text', async () => {
            const expectedHash = createHash('sha1').update(JSON.stringify(['CleanInbox', 77])).digest('hex');
            const expectedAttachmentHash = createHash('sha1').update('att-1').digest('hex');
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            77,
                messageId:      '<prefix-test@example.com>',
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
            expect(text).toContain(`attachments/email-${expectedHash}/attachment-${expectedAttachmentHash}/doc.pdf`);
        });

        test('should fetch distinct bytes for reused or missing Message-IDs and reuse the same attachment', async () => {
            const bytesByMessage = new Map([
                ['CleanInbox:41', Buffer.from('first document')],
                ['CleanInbox:42', Buffer.from('second document')],
                ['Archive:41', Buffer.from('archived document')],
            ]);
            mockWildDuck.getFullMessage = mock(async (mailboxName: string, uid: number) => ({
                uid,
                messageId:      mailboxName === 'Archive' ? '' : '<reused@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Document',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'See attached',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [{ id: 'att-1', filename: 'doc.pdf', contentType: 'application/pdf', sizeKb: 1 }],
            }));
            mockWildDuck.getAttachment = mock(async (mailboxName: string, uid: number) => bytesByMessage.get(`${mailboxName}:${uid}`)!);

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');
            const first = await handler({ message: 'CleanInbox:41' });
            const second = await handler({ message: 'CleanInbox:42' });
            const archived = await handler({ message: 'Archive:41' });
            const paths = mockFsPromises.writeFile.mock.calls.map(call => call[0]);

            expect(paths).toHaveLength(3);
            expect(new Set(paths).size).toBe(3);
            expect(mockWildDuck.getAttachment).toHaveBeenCalledTimes(3);
            for(const [index, result] of [first, second, archived].entries()) {
                expect(result.isError).toBeUndefined();
                expect(getText(result)).toContain(String(paths[index]).slice(process.cwd().length + 1));
            }
            expect(mockFsPromises.writeFile.mock.calls.map(call => call[1] as unknown as Buffer)).toEqual([...bytesByMessage.values()]);

            const firstAgain = await handler({ message: 'CleanInbox:41' });
            expect(firstAgain.isError).toBeUndefined();
            expect(getText(firstAgain)).toContain(String(paths[0]).slice(process.cwd().length + 1));
            expect(mockWildDuck.getAttachment).toHaveBeenCalledTimes(3);
            expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(3);
        });

        test('should fetch a new attachment ID even when its filename is unchanged', async () => {
            let attachmentId = 'att-first';
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            50,
                messageId:      '<same@example.com>',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Document',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'See attached',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [{ id: attachmentId, filename: 'doc.pdf', contentType: 'application/pdf', sizeKb: 1 }],
            }));
            mockWildDuck.getAttachment = mock(async (_mailboxName: string, _uid: number, id: string) => Buffer.from(id));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');
            const first = await handler({ message: 'CleanInbox:50' });
            attachmentId = 'att-second';
            const second = await handler({ message: 'CleanInbox:50' });
            const paths = mockFsPromises.writeFile.mock.calls.map(call => call[0]);

            expect(paths).toHaveLength(2);
            expect(paths[0]).not.toBe(paths[1]);
            expect(mockFsPromises.writeFile.mock.calls.map(call => call[1] as unknown as Buffer)).toEqual([Buffer.from('att-first'), Buffer.from('att-second')]);
            expect(getText(first)).toContain(String(paths[0]).slice(process.cwd().length + 1));
            expect(getText(second)).toContain(String(paths[1]).slice(process.cwd().length + 1));
        });

        test('should continue saving later attachments when a remote attachment ID is malformed', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            51,
                messageId:      '',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Documents',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'See attached',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [
                    { id: undefined as unknown as string, filename: 'broken.pdf', contentType: 'application/pdf', sizeKb: 1 },
                    { id: 'valid-id', filename: 'valid.pdf', contentType: 'application/pdf', sizeKb: 1 },
                ],
            }));

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'getEmailContent');
            const result = await handler({ message: 'CleanInbox:51' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('could not save attachment broken.pdf');
            expect(getText(result)).toContain('/valid.pdf (application/pdf)');
            expect(mockWildDuck.getAttachment).toHaveBeenCalledTimes(1);
            expect(mockWildDuck.getAttachment).toHaveBeenCalledWith('CleanInbox', 51, 'valid-id');
            expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ filename: 'broken.pdf', msg: 'Failed to save attachment (best-effort)' }));
        });

        test('notes an attachment WildDuck failed to deliver by its code and reference, never WildDuck\'s text', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            53,
                messageId:      '',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Documents',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'See attached',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [{ id: 'ATT1', filename: 'report.pdf', contentType: 'application/pdf', sizeKb: 1 }],
            }));
            mockWildDuck.getAttachment = mock(async () => {
                throw new WildDuckError('WildDuck API error: 502 Bad Gateway: <html>upstream page</html>', undefined, { status: 502, kind: 'http' });
            });
            mockFsPromises.access.mockRejectedValueOnce(new Error('ENOENT'));
            mockFsPromises.mkdir.mockResolvedValueOnce(undefined);

            const result = await getToolHandler(createEmailMCPServer({ wildDuckClient: mockWildDuck }), 'getEmailContent')({ message: 'CleanInbox:53' });

            const reference = lastFailureReference();
            expect(getText(result).split('\n').at(-1)).toBe(`- Note: could not save attachment report.pdf (unavailable; reference ${reference}).`);
            expect(getText(result)).not.toContain('upstream page');
            expect(mockLogger.warn).toHaveBeenCalledWith({ filename: 'report.pdf', reference, msg: 'Failed to save attachment (best-effort)' });
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'getEmailContent', reference, status: 502, detail: 'WildDuck API error: 502 Bad Gateway: <html>upstream page</html>' }));
        });

        test('should show processed video frames and fall back to the saved file after processing fails', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            52,
                messageId:      '',
                from:           { address: 'sender@example.com' },
                to:             [{ address: 'recipient@example.com' }],
                cc:             [],
                subject:        'Video',
                date:           new Date('2025-01-01T00:00:00.000Z'),
                bodyText:       'See attached',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [{ id: 'video-id', filename: 'clip.mp4', contentType: 'video/mp4', sizeKb: 1 }],
            }));
            const processSpy = spyOn(utils, 'processLocalVideo')
                .mockResolvedValueOnce({
                    metadata:         { duration: 1, width: 10, height: 10, videoCodec: 'h264', frameRate: 30, subtitleTracks: [] },
                    frames:           [{ filename: 'frame-001.jpg', mediaType: 'image/jpeg', base64Data: 'AA==', originalSize: 1 }],
                    text:             { kind: 'transcription', outcome: { kind: 'empty' } },
                    metadataMarkdown: 'Duration: 1s',
                    outputDir:        'unused',
                })
                .mockRejectedValueOnce(new Error('probe failed'));
            try {
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
                const handler = getToolHandler(server, 'getEmailContent');
                const first = await handler({ message: 'CleanInbox:52' });
                const second = await handler({ message: 'CleanInbox:52' });
                const savedPath = String(mockFsPromises.writeFile.mock.calls[0]?.[0]);
                const videoOutputDir = savedPath.replace(/\/clip\.mp4$/, '/video-clip.mp4');

                expect(first.isError).toBeUndefined();
                expect(getText(first)).toContain('- Video: clip.mp4 — Duration: 1s');
                expect(getText(first)).toContain(`  - Frame: ${videoOutputDir}/frame-001.jpg`);
                expect(getText(first)).not.toContain(`- ${savedPath.slice(process.cwd().length + 1)} (video/mp4)`);
                expect(second.isError).toBeUndefined();
                expect(getText(second)).toContain(`- ${savedPath.slice(process.cwd().length + 1)} (video/mp4)`);
                expect(processSpy).toHaveBeenCalledTimes(2);
                expect(processSpy).toHaveBeenCalledWith(savedPath, videoOutputDir, { run: expect.any(Function), binaryRun: expect.any(Function) });
                expect(mockWildDuck.getAttachment).toHaveBeenCalledTimes(1);
                expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: 'probe failed', filename: 'clip.mp4', msg: 'Video processing failed, using generic attachment reference' }));
            } finally {
                processSpy.mockRestore();
            }
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
            const writeFileCall = firstMockCall(mockFsPromises.writeFile.mock.calls);
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

        test('reports the destination uid WildDuck assigned in Archive, not the source uid', async () => {
            // Regression test: WildDuck (like IMAP) assigns a new uid on move, so a later
            // Archive:<uid> lookup must use the uid WildDuck actually gave it there.
            mockWildDuck.moveMessage = mock(async () => 999); // WildDuck assigns uid 999 in Archive, not 7

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:7' });

            expect(result.isError).toBeUndefined();
            const text = getText(result);
            expect(text).toContain('999');
            expect(text).not.toContain('UID 7 ');
        });

        test('should handle a move WildDuck answers 404 as not found', async () => {
            mockWildDuck.moveMessage = mock(async () => {
                throw new WildDuckError('WildDuck API error: 404 Not Found: {"error":"Message not found"}', undefined, { status: 404, kind: 'http' });
            });

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:7' });

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('archiveEmail', 'not_found') }], isError: true });
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'archiveEmail', status: 404, msg: 'Email tool failed' }));
        });

        test('should handle non-Error move failure gracefully', async () => {
            mockWildDuck.moveMessage = mock(async () => {
                throw 'Network timeout';
            });

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:3' });

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('archiveEmail', 'unavailable') }], isError: true });
        });

        test('should archive from any accessible mailbox (not just CleanInbox)', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:15' });

            expect(result.isError).toBeUndefined();
            expect(mockWildDuck.moveMessage).toHaveBeenCalledWith('CleanInbox', 15, 'Archive');
        });

        test.each([
            ['Quarantine', 7, ['Restricted mailboxes require admin review']],
            ['Junk',       3, []],
            ['Trash',      5, []],
            ['Drafts',     2, []],
        ])('should deny archive from %s mailbox', async (mailbox, id, extraMessages) => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: `${mailbox}:${id}` });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Access denied');
            expect(getText(result)).toContain(mailbox);
            for(const extraMessage of extraMessages) {
                expect(getText(result)).toContain(extraMessage);
            }
            expect(mockWildDuck.moveMessage).not.toHaveBeenCalled();
        });

        test('should treat only the final colon as the mailbox/uid separator', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'Foo:Bar:42' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('Foo:Bar');
            expect(mockWildDuck.moveMessage).not.toHaveBeenCalled();
        });

        test('should not trim whitespace from the parsed mailbox name', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const handler = getToolHandler(server, 'archiveEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox :42' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('CleanInbox ');
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
        type SearchPageMock = ReturnType<typeof mock<(request: WildDuckSearchPageRequest) => Promise<WildDuckSearchPage>>>;

        /** A search row in `mailboxId`, as WildDuckClient.searchPage maps it. */
        const searchRow = (uid: number, overrides: Partial<WildDuckSearchRow> = {}): WildDuckSearchRow => ({
            message: `Path/${uid}:${uid}`, uid, mailboxId: 'mbx', intro: '', from: { address: `sender${uid}@example.com` }, to: [{ address: 'me@example.com' }], subject: `Subject ${uid}`, date: '2025-01-01T10:00:00.000Z', ...overrides,
        });

        /** `count` rows numbered from `first`. */
        const searchRows = (first: number, count: number): WildDuckSearchRow[] => Array.from({ length: count }, (_unused, index) => searchRow(first + index));

        /** A searchPage mock answering each mailbox with its pages in order (an empty last page once they run out). */
        const pagesByMailbox = (pages: Partial<Record<string, WildDuckSearchPage[]>>): SearchPageMock => mock(async (request: WildDuckSearchPageRequest) => pages[request.mailbox ?? '']?.shift() ?? { results: [] });

        /** The searchEmail handler over a client whose searchPage is `searchPage`. */
        const searchHandler = (searchPage: SearchPageMock): ((args: unknown) => Promise<CallToolResult>) => getToolHandler(createEmailMCPServer({ wildDuckClient: { searchPage } as unknown as WildDuckClient }), 'searchEmail');

        /** The next value a result's last line offers, or undefined when it offers none. */
        const offeredNext = (result: CallToolResult): string | undefined => /next: (\S+)$/u.exec(getText(result))?.[1];

        test('is described with its scope and its paging', () => {
            const registered = (createEmailMCPServer({ wildDuckClient: mockWildDuck }).instance as unknown as RegisteredToolInstance)._registeredTools.searchEmail;
            expect(registered.description).toBe('Search the emails you can read (CleanInbox, Archive, Drafts and Sent Mail, mailbox by mailbox), at most 20 a page: each result\'s Mailbox:UID reference, From, To, Subject and Date. When there may be more, the result ends with a next value for the following page.');
            expect((registered.inputSchema.shape.mailbox as { description?: string }).description).toBe('Search only this mailbox. Omit to search every mailbox you can read: CleanInbox, Archive, Drafts, Sent Mail, in that order.');
            expect((registered.inputSchema.shape.next as { description?: string }).description).toBe('The next value from the end of an earlier searchEmail result, for the page after it. Give exactly the same filters as that search; a next from a different search is refused.');
            expect((registered.inputSchema.shape.correspondent as { description?: string }).description).toBe('Match this text in the From, To or Cc header');
        });

        test('offers only filters WildDuck\'s search applies: no header filter, which it would silently ignore', () => {
            const registered = (createEmailMCPServer({ wildDuckClient: mockWildDuck }).instance as unknown as RegisteredToolInstance)._registeredTools.searchEmail;
            expect(Object.keys(registered.inputSchema.shape)).toEqual(['correspondent', 'content', 'before', 'since', 'mailbox', 'next']);
        });

        test.each(['Quarantine', 'Review', 'Junk', 'Trash', 'INBOX', 'all', 'all-regular'])('refuses %s as a mailbox to search', async (mailbox) => {
            const schema = (createEmailMCPServer({ wildDuckClient: mockWildDuck }).instance as unknown as RegisteredToolInstance)._registeredTools.searchEmail.inputSchema;
            const parsed = await schema.safeParseAsync({ mailbox });
            expect(parsed.success).toBe(false);
        });

        test('searches only the mailboxes Izzy can read, one after another, never every mailbox', async () => {
            const searchPage = pagesByMailbox({});

            const result = await searchHandler(searchPage)({});

            expect(searchPage.mock.calls.map(([request]) => request.mailbox)).toEqual(['CleanInbox', 'Archive', 'Drafts', 'Sent Mail']);
            expect(searchPage.mock.calls.every(([request]) => request.searchable === undefined && request.next === undefined && request.limit === 20)).toBe(true);
            expect(getText(result)).toBe('No emails found matching your search criteria.\nNo more results.');
            expect(result.isError).toBeUndefined();
        });

        test('searches only the mailbox it is given', async () => {
            const searchPage = pagesByMailbox({});

            await searchHandler(searchPage)({ mailbox: 'Archive' });

            expect(searchPage.mock.calls.map(([request]) => request.mailbox)).toEqual(['Archive']);
        });

        test('passes every filter to each mailbox\'s search', async () => {
            const searchPage = pagesByMailbox({});
            const filters = { correspondent: 'alice@example.com', content: 'MiXeD', before: '2025-01-15T00:00:00.000Z', since: '2025-01-01T00:00:00.000Z' };

            await searchHandler(searchPage)({ ...filters, mailbox: 'Drafts' });

            expect(searchPage).toHaveBeenCalledWith({ query: filters, mailbox: 'Drafts', limit: 20, next: undefined });
        });

        test('fills a page from the next mailbox once one runs out, asking it only for the rows still wanted', async () => {
            const searchPage = pagesByMailbox({ CleanInbox: [{ results: searchRows(1, 15) }], Archive: [{ results: searchRows(100, 5) }] });

            const result = await searchHandler(searchPage)({});

            expect(searchPage.mock.calls.map(([request]) => [request.mailbox, request.limit])).toEqual([['CleanInbox', 20], ['Archive', 5]]);
            const lines = getText(result).split('\n');
            expect(lines[0]).toBe('Found 20 emails:');
            expect(lines[1]).toBe('- CleanInbox:1 | From: sender1@example.com | To: me@example.com | Subject: Subject 1 | Date: 2025-01-01T10:00:00.000Z');
            expect(lines[16]).toBe('- Archive:100 | From: sender100@example.com | To: me@example.com | Subject: Subject 100 | Date: 2025-01-01T10:00:00.000Z');
            expect(lines).toHaveLength(22);
            expect(lines[21]).toMatch(/^More results: call searchEmail again with the same filters and next: \S+$/u);
        });

        test('pages through a mailbox with WildDuck\'s cursor, then carries on into the next mailbox', async () => {
            const searchPage = pagesByMailbox({
                CleanInbox: [{ results: searchRows(1, 20), nextCursor: 'cursor-a' }, { results: searchRows(21, 3) }],
                Archive:    [{ results: searchRows(100, 2) }],
            });
            const handler = searchHandler(searchPage);

            const first = await handler({ content: 'invoice' });
            const second = await handler({ content: 'invoice', next: offeredNext(first) });

            expect(offeredNext(first)).toMatch(/^[0-9a-f]{16}\.0\.cursor-a$/u);
            expect(searchPage.mock.calls.map(([request]) => [request.mailbox, request.limit, request.next])).toEqual([
                ['CleanInbox', 20, undefined],
                ['CleanInbox', 20, 'cursor-a'],
                ['Archive', 17, undefined],
                ['Drafts', 15, undefined],
                ['Sent Mail', 15, undefined],
            ]);
            expect(getText(second).split('\n')).toEqual([
                'Found 5 emails:',
                ...[21, 22, 23].map(uid => `- CleanInbox:${uid} | From: sender${uid}@example.com | To: me@example.com | Subject: Subject ${uid} | Date: 2025-01-01T10:00:00.000Z`),
                ...[100, 101].map(uid => `- Archive:${uid} | From: sender${uid}@example.com | To: me@example.com | Subject: Subject ${uid} | Date: 2025-01-01T10:00:00.000Z`),
                'No more results.',
            ]);
        });

        test('offers the next mailbox when a page fills up exactly as one mailbox runs out', async () => {
            const searchPage = pagesByMailbox({ CleanInbox: [{ results: searchRows(1, 20) }], Archive: [{ results: searchRows(100, 1) }] });
            const handler = searchHandler(searchPage);

            const first = await handler({});
            const second = await handler({ next: offeredNext(first) });

            expect(offeredNext(first)).toMatch(/^[0-9a-f]{16}\.1$/u);
            expect(searchPage.mock.calls.map(([request]) => [request.mailbox, request.next])).toEqual([
                ['CleanInbox', undefined], ['Archive', undefined], ['Drafts', undefined], ['Sent Mail', undefined],
            ]);
            expect(getText(second).split('\n')[1]).toBe('- Archive:100 | From: sender100@example.com | To: me@example.com | Subject: Subject 100 | Date: 2025-01-01T10:00:00.000Z');
        });

        test('says there are no more results when the last mailbox runs out with the page full', async () => {
            const searchPage = pagesByMailbox({ 'Sent Mail': [{ results: searchRows(1, 20) }] });

            const result = await searchHandler(searchPage)({ mailbox: 'Sent Mail' });

            expect(getText(result).split('\n').at(-1)).toBe('No more results.');
        });

        test('names each result by the mailbox searched and its UID, whatever WildDuck calls the mailbox', async () => {
            const searchPage = pagesByMailbox({ 'Sent Mail': [{ results: [searchRow(7, { message: '[Gmail]/Sent Mail:7', from: { name: 'Alice', address: 'alice@example.com' }, to: [] })] }] });

            const result = await searchHandler(searchPage)({ mailbox: 'Sent Mail' });

            expect(getText(result)).toBe('Found 1 email:\n- Sent Mail:7 | From: Alice <alice@example.com> | To: (none) | Subject: Subject 7 | Date: 2025-01-01T10:00:00.000Z\nNo more results.');
        });

        test('shows several recipients, a sender without an address and empty fields as they are', async () => {
            const searchPage = pagesByMailbox({ Archive: [{ results: [searchRow(3, { from: null, to: [{ address: 'a@example.com' }, { name: 'B', address: 'b@example.com' }], subject: '', date: '' })] }] });

            const result = await searchHandler(searchPage)({ mailbox: 'Archive' });

            expect(getText(result).split('\n')[1]).toBe('- Archive:3 | From: (no address) | To: a@example.com, B <b@example.com> | Subject:  | Date: ');
        });

        test.each([
            ['correspondent', { correspondent: 'bob@example.com' }],
            ['content', { content: 'other' }],
            ['before', { before: '2025-02-01T00:00:00.000Z' }],
            ['since', { since: '2024-02-01T00:00:00.000Z' }],
            ['mailbox', { mailbox: 'Archive' }],
        ])('refuses a next from a search with a different %s, before any WildDuck call', async (_field, changed) => {
            const searchPage = pagesByMailbox({ CleanInbox: [{ results: searchRows(1, 20), nextCursor: 'cursor-a' }] });
            const handler = searchHandler(searchPage);
            const filters = { correspondent: 'alice@example.com', content: 'invoice', before: '2025-01-15T00:00:00.000Z', since: '2025-01-01T00:00:00.000Z', mailbox: 'CleanInbox' };
            const next = offeredNext(await handler(filters));
            searchPage.mockClear();

            const result = await handler({ ...filters, ...changed, next });

            expect(result).toEqual({ content: [{ type: 'text', text: 'searchEmail: this next value does not belong to this search. Repeat the search that gave it with exactly the same filters, or search again without next.' }], isError: true });
            expect(searchPage).not.toHaveBeenCalled();
        });

        test.each([
            ['is not a next value at all', () => 'garbage'],
            ['names a mailbox past the end of the search', (next: string) => next.replace(/\.0\./u, '.4.')],
            ['names a mailbox past the end of a one-mailbox search', (next: string) => next.replace(/\.0\./u, '.1.')],
            ['has anything before it', (next: string) => `x${next}`],
            ['has anything after it', (next: string) => `${next} x`],
            ['has an empty cursor', (next: string) => next.replace(/cursor-a$/u, '')],
            ['has a cursor WildDuck could not have issued', (next: string) => next.replace(/cursor-a$/u, 'cursor+a')],
            ['has a mailbox that is not a digit', (next: string) => next.replace(/\.0\./u, '.x.')],
        ])('refuses a next value that %s', async (_label, tamper) => {
            const searchPage = pagesByMailbox({ CleanInbox: [{ results: searchRows(1, 20), nextCursor: 'cursor-a' }], Archive: [{ results: searchRows(1, 20), nextCursor: 'cursor-b' }] });
            const handler = searchHandler(searchPage);
            const scoped = _label.includes('one-mailbox');
            const next = offeredNext(await handler(scoped ? { mailbox: 'CleanInbox' } : {}));
            searchPage.mockClear();

            const result = await handler({ ...(scoped ? { mailbox: 'CleanInbox' } : {}), next: tamper(next ?? '') });

            expect(result).toEqual({ content: [{ type: 'text', text: 'searchEmail: this next value does not belong to this search. Repeat the search that gave it with exactly the same filters, or search again without next.' }], isError: true });
            expect(searchPage).not.toHaveBeenCalled();
        });

        test('accepts a next it gave for the last of four mailboxes', async () => {
            const searchPage = pagesByMailbox({ 'Sent Mail': [{ results: searchRows(1, 20), nextCursor: 'cursor-s' }, { results: searchRows(21, 1) }] });
            const handler = searchHandler(searchPage);

            const first = await handler({});
            const second = await handler({ next: offeredNext(first) });

            expect(searchPage.mock.calls.at(-1)?.[0]).toMatchObject({ mailbox: 'Sent Mail', next: 'cursor-s' });
            expect(getText(second)).toContain('- Sent Mail:21 |');
        });

        test('reports an unknown mailbox as an invalid request, never searching more widely', async () => {
            const searchPage: SearchPageMock = mock(async () => {
                throw new WildDuckError('WildDuck: unknown mailbox path: Drafts', undefined, { kind: 'invalid_request' });
            });

            const result = await searchHandler(searchPage)({ mailbox: 'Drafts' });

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('searchEmail', 'invalid_request') }], isError: true });
            expect(searchPage).toHaveBeenCalledTimes(1);
        });

        test('should handle a WildDuck search refusal gracefully, never echoing WildDuck\'s text', async () => {
            const searchPage: SearchPageMock = mock(async () => {
                throw new WildDuckError('WildDuck API error: 400 Bad Request: {"error":"invalid query"}', undefined, { status: 400, kind: 'http' });
            });

            const result: CallToolResult = await searchHandler(searchPage)({});

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('searchEmail', 'refused') }], isError: true });
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'searchEmail', status: 400, kind: 'http', detail: 'WildDuck API error: 400 Bad Request: {"error":"invalid query"}' }));
        });
    });

    describe('sendEmail tool', () => {
        let mockSendWildDuck:        WildDuckClient;
        let mockRateLimiter:         TokenBucketRateLimiter;
        let mockAllowlist:           PersonAllowlist;
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
                // The draft read before a direct send, for its Message-ID and Date.
                getMessage:            mock(async (_folder: string, uid: number) => ({ id: uid, messageId: `<draft-${uid}@example.com>`, date: '2026-11-17T10:00:00.000Z', draft: true })),
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
            } as unknown as TokenBucketRateLimiter;
            mockAllowlist = {
                isAllowed: mock((_platform: string, _value: string) => false),
            } as unknown as PersonAllowlist;
            mockSendApprovalRequest = mock(async () => 'posted');
        });

        test('encodes attachment bytes in input order before uploading the draft', async () => {
            mockAllowlist.isAllowed = mock(() => true);
            const read = attachmentFiles({ 'first.txt': 'first bytes', 'out/second.bin': 'second bytes' });
            const server = createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist, attachmentRoot: ATTACHMENT_ROOT, readAttachmentFile: read });
            const handler = getToolHandler(server, 'sendEmail');

            const result = await handler({
                to:            'alice@example.com',
                subject:       'Files',
                body:          'See attached',
                senderProfile: 'formal',
                attachments:   ['first.txt', '/work/izzy/out/second.bin'],
            });

            expect(result.isError).toBeUndefined();
            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, { attachments: unknown[] }];
            expect(payload.attachments).toEqual([
                { filename: 'first.txt', contentType: 'text/plain', content: Buffer.from('first bytes').toString('base64') },
                { filename: 'second.bin', contentType: 'application/octet-stream', content: Buffer.from('second bytes').toString('base64') },
            ]);
            // Read under the root only, through the contained reader, within the 25 MiB budget.
            expect(read.mock.calls).toEqual([[ATTACHMENT_ROOT, 'first.txt', MAX_ATTACHMENT_BYTES], [ATTACHMENT_ROOT, 'out/second.bin', MAX_ATTACHMENT_BYTES]]);
        });

        test.each([
            ['a key outside the working directory', '/Users/craig/.ssh/id_ed25519', 'the attachment "/Users/craig/.ssh/id_ed25519" is outside your working directory'],
            ['a parent-directory escape', '../.env', 'the attachment "../.env" is outside your working directory'],
            ['a dotfile inside it', '.env', 'the attachment ".env" is a hidden file or in a hidden folder (a name starting with ".")'],
            ['a file in a dot-directory', '.git/config', 'the attachment ".git/config" is a hidden file or in a hidden folder (a name starting with ".")'],
        ])('refuses %s, reading and uploading nothing', async (_label, given, problem) => {
            mockAllowlist.isAllowed = mock(() => true);
            const read = attachmentFiles(() => 'secret');
            const server = createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist, attachmentRoot: ATTACHMENT_ROOT, readAttachmentFile: read });

            const result = await getToolHandler(server, 'sendEmail')({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', attachments: ['ok.txt', given] });

            expect(result).toEqual({ content: [{ type: 'text', text: `Nothing was saved or sent: ${problem}.` }], isError: true });
            expect(read).not.toHaveBeenCalled();
            expect(mockUploadMessage).not.toHaveBeenCalled();
            expect(mockSubmitMessage).not.toHaveBeenCalled();
        });

        test('refuses a symlink escape the contained reader refuses, uploading nothing', async () => {
            mockAllowlist.isAllowed = mock(() => true);
            const read = mock<ContainedFileReader>(async (_root, relPath) => {
                throw new PathSecurityError(`Path component "link" of ${relPath} is not a real directory`, relPath, 'not_directory');
            });
            const server = createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist, attachmentRoot: ATTACHMENT_ROOT, readAttachmentFile: read });

            const result = await getToolHandler(server, 'sendEmail')({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', attachments: ['link/id_ed25519'] });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Nothing was saved or sent: the attachment "link/id_ed25519" is in a folder that is missing, is a symbolic link or is not a folder.' }], isError: true });
            expect(mockUploadMessage).not.toHaveBeenCalled();
        });

        test('reads attachments from the working directory at server creation through the contained reader by default', async () => {
            mockAllowlist.isAllowed = mock(() => true);
            const contained = spyOn(utils, 'openContainedForRead').mockImplementation(async () => ({ bytes: Buffer.from('x'), size: 1 }));
            const cwd = spyOn(process, 'cwd').mockReturnValue('/at/creation');
            try {
                const server = createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist });
                cwd.mockReturnValue('/later');

                await getToolHandler(server, 'sendEmail')({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', attachments: ['/at/creation/a.txt'] });

                expect(contained.mock.calls).toEqual([['/at/creation', 'a.txt', MAX_ATTACHMENT_BYTES]]);
            } finally {
                contained.mockRestore();
                cwd.mockRestore();
            }
        });

        test('assigns standard MIME types to supported attachment extensions', async () => {
            const expected: Record<string, string> = {
                pdf:  'application/pdf', doc:  'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                xls:  'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                ppt:  'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                txt:  'text/plain', csv:  'text/csv', html: 'text/html', htm:  'text/html', xml:  'application/xml',
                json: 'application/json', zip:  'application/zip', tar:  'application/x-tar', gz:   'application/gzip',
                png:  'image/png', jpg:  'image/jpeg', jpeg: 'image/jpeg', gif:  'image/gif', webp: 'image/webp',
                svg:  'image/svg+xml', mp4:  'video/mp4', mp3:  'audio/mpeg', wav:  'audio/wav',
            };
            mockAllowlist.isAllowed = mock(() => true);
            const server = createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist, attachmentRoot: ATTACHMENT_ROOT, readAttachmentFile: attachmentFiles(() => 'file') });
            const handler = getToolHandler(server, 'sendEmail');

            const result = await handler({
                to:            'alice@example.com',
                subject:       'Files',
                body:          'Attached',
                senderProfile: 'formal',
                attachments:   Object.keys(expected).map(ext => `tmp/file.${ext}`),
            });

            expect(result.isError).toBeUndefined();
            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, { attachments: { filename: string, contentType: string }[] }];
            expect(Object.fromEntries(payload.attachments.map(attachment => [attachment.filename.split('.').at(-1), attachment.contentType]))).toEqual(expected);
        });

        test('should upload to Drafts and submit immediately when recipient is on allowlist', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                rateLimiter:    mockRateLimiter,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('Sent successfully');
            expect(mockUploadMessage).toHaveBeenCalledTimes(1);
            expect(mockSubmitMessage).toHaveBeenCalledTimes(1);
            expect(mockRateLimiter.increment).toHaveBeenCalledTimes(1);
        });

        test('should upload to Drafts with correct payload for formal identity', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'alice@example.com', subject: 'Test Subject', body: 'Test Body', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(_folder).toBe('Drafts');
            expect(payload.to).toEqual([{ address: 'alice@example.com' }]);
            expect(payload.subject).toBe('Test Subject');
            expect(payload.text).toBe('Test Body');
            expect(payload.draft).toBe(true);
        });

        test('should NOT include flags field in sendEmail upload payload', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'alice@example.com', subject: 'Test Subject', body: 'Test Body', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.flags).toBeUndefined();
        });

        test('should use formalAddress from getUserAddresses for formal identity', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.from as { address: string }).address).toBe('formal@example.com');
            expect((payload.from as { name: string }).name).toBe('Izzy Formal');
        });

        test('should use informalAddress from getUserAddresses for informal identity', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'informal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.from as { address: string }).address).toBe('informal@example.com');
            expect((payload.from as { name: string }).name).toBe('Izzy Informal');
        });

        test('sendEmail through the SDK MCP validator accepts an omitted senderProfile and sends from the formal address', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);
            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });

            const result = await callSdkTool(server, 'sendEmail', { to: 'alice@example.com', subject: 'Hi', body: 'Hello' });

            expect(result.isError).toBeUndefined();
            expect(mockUploadMessage).toHaveBeenCalledTimes(1);
            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.from).toEqual({ address: 'formal@example.com', name: 'Izzy Formal' });
        });

        test('sendEmail through the SDK MCP validator accepts bodyFormat markdown and uploads the HTML version', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist });

            const result = await callSdkTool(server, 'sendEmail', { to: 'alice@example.com', subject: 'Hi', body: '*Hello*', bodyFormat: 'markdown' });

            expect(result.isError).toBeUndefined();
            const [, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.html).toBe('<p style="margin:0 0 1em"><em>Hello</em></p>');
        });

        test('should pass structured to object { name, email_address } to uploadMessage as { name, address }', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: { name: 'Craig', email_address: 'craig@rungie.com' }, subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.to).toEqual([{ name: 'Craig', address: 'craig@rungie.com' }]);
        });

        test('should pass plain string to as { address } object', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'craig@rungie.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.to).toEqual([{ address: 'craig@rungie.com' }]);
        });

        test('should handle array with mixed structured and plain string to addresses', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({
                to:            [{ name: 'Craig', email_address: 'craig@rungie.com' }, 'other@example.com'],
                subject:       'Hi',
                body:          'Hello',
                senderProfile: 'formal',
            });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.to).toEqual([
                { name: 'Craig', address: 'craig@rungie.com' },
                { address: 'other@example.com' },
            ]);
        });

        test('should check allowlist using address field from structured to object', async () => {
            const mockIsAllowed = mock((_platform: string, addr: string) => addr === 'craig@rungie.com');
            mockAllowlist.isAllowed = mockIsAllowed;

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: { name: 'Craig', email_address: 'craig@rungie.com' }, subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('Sent successfully');
            expect(mockIsAllowed).toHaveBeenCalledWith('email', 'craig@rungie.com');
        });

        test('should upload to WildDuck Drafts and NOT submit when recipient not on allowlist', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => false);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'bob@example.com', subject: 'Test', body: 'Body', senderProfile: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('pending admin approval');
            expect(mockUploadMessage).toHaveBeenCalledTimes(1);
            expect(mockSubmitMessage).not.toHaveBeenCalled();
        });

        test('should present the uploaded WildDuck UID, with no previous uid, when not allowlisted', async () => {
            mockAllowlist.isAllowed     = mock((_platform: string, _value: string) => false);
            mockUploadMessage           = mock(() => Promise.resolve(99));
            mockSendWildDuck.uploadMessage = mockUploadMessage;

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'bob@example.com', subject: 'Test', body: 'Body', senderProfile: 'formal' });

            expect(mockSendApprovalRequest.mock.calls).toEqual([[99, undefined]]);
        });

        test('without an allowlist, the uploaded draft requires approval', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockSendWildDuck, approvalCards: cardPort(mockSendApprovalRequest) });
            const result = await getToolHandler(server, 'sendEmail')({ to: 'bob@example.com', subject: 'Test', body: 'Body', senderProfile: 'formal' });
            expect(getText(result)).toBe('Message saved to Drafts, pending admin approval (draft UID: 99).');
            expect(mockSubmitMessage).not.toHaveBeenCalled();
            expect(mockSendApprovalRequest.mock.calls).toEqual([[99, undefined]]);
            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload).not.toHaveProperty('attachments');
        });

        test('should accept an array of to addresses and upload all to WildDuck', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: ['alice@example.com', 'bob@example.com'], subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('Sent successfully');
            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.to).toEqual([{ address: 'alice@example.com' }, { address: 'bob@example.com' }]);
            expect(payload).not.toHaveProperty('attachments');
        });

        test('should route to approval when array to has any recipient not on allowlist', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, addr: string) => addr === 'alice@example.com');

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: ['alice@example.com', 'bob@example.com'], subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('pending admin approval');
            expect(mockSubmitMessage).not.toHaveBeenCalled();
        });

        test('should fast-path when all addresses in array are allowlisted', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: ['alice@example.com', 'bob@example.com'], subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('Sent successfully');
            expect(mockSubmitMessage).toHaveBeenCalledTimes(1);
        });

        test.each([
            ['queued', 'Message saved to Drafts, pending admin approval (draft UID: 99).'],
            ['failed', 'Draft saved as Drafts:99 but failed to notify admin. Please check pending drafts manually.'],
        ])('maps a %s presentation to the tool text', async (presentation, expected) => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => false);
            const server = createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist, approvalCards: cardPort(mock(async () => presentation)) });

            const result = await getToolHandler(server, 'sendEmail')({ to: 'bob@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toBe(expected);
        });

        test('reports an error when the uploaded draft cannot be found to present', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => false);
            const server = createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist, approvalCards: cardPort(mock(async () => 'missing')) });

            const result = await getToolHandler(server, 'sendEmail')({ to: 'bob@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Draft Drafts:99 not found after upload.' }], isError: true });
        });

        test('should include rate limit warning when over limit', async () => {
            mockAllowlist.isAllowed         = mock((_platform: string, _value: string) => true);
            mockRateLimiter.isAtLimit       = mock(() => true);
            mockRateLimiter.tokensRemaining = mock(() => 0);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                rateLimiter:    mockRateLimiter,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('send rate limit reached');
        });

        test('should handle uploadMessage error gracefully', async () => {
            mockAllowlist.isAllowed        = mock((_platform: string, _value: string) => true);
            mockSendWildDuck.uploadMessage = mock(async () => {
                throw new Error('WildDuck upload failed');
            });

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('sendEmail', 'unavailable') }], isError: true });
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'sendEmail', detail: 'WildDuck upload failed', msg: 'Email tool failed' }));
            expect(mockSubmitMessage).not.toHaveBeenCalled();
        });

        test('shows a missing attachment file as Isambard\'s own text, uploading nothing', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);
            const server = createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist, attachmentRoot: ATTACHMENT_ROOT, readAttachmentFile: attachmentFiles({}) });

            const result = await getToolHandler(server, 'sendEmail')({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', attachments: ['/work/izzy/tmp/missing.pdf'] });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Nothing was saved or sent: the attachment "/work/izzy/tmp/missing.pdf" was not found.' }], isError: true });
            expect(mockUploadMessage).not.toHaveBeenCalled();
        });

        test('should return failure message when presenting the approval card throws', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => false);
            mockSendApprovalRequest = mock(async () => {
                throw new Error('Discord unavailable');
            });

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'new@example.com', subject: 'Hi', body: 'Body', senderProfile: 'formal' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toContain('failed to notify admin');
            expect(getText(result)).toContain('check pending drafts manually');
            expect(mockLogger.warn).toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith({
                error: 'Discord unavailable', msg: 'Failed to send outbound approval request',
            });
            // No flag setting — outbox handles retry now
            expect(mockSendWildDuck.updateMessageFlags).not.toHaveBeenCalledWith('Drafts', 99, { addFlags: ['DiscordNotifyFailed'] });
        });

        test('should log the string form of a non-Error approval card failure', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => false);
            mockSendApprovalRequest = mock(async () => {
                throw 'transient outbox failure';
            });

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'new@example.com', subject: 'Hi', body: 'Body', senderProfile: 'formal' });

            expect(mockLogger.warn).toHaveBeenCalledWith({
                error: 'transient outbox failure', msg: 'Failed to send outbound approval request',
            });
        });

        test('should append the rate limit warning when notifying admin of the draft fails', async () => {
            mockAllowlist.isAllowed         = mock((_platform: string, _value: string) => false);
            mockRateLimiter.isAtLimit       = mock(() => true);
            mockRateLimiter.tokensRemaining = mock(() => 0);
            mockSendApprovalRequest = mock(async () => {
                throw new Error('Discord unavailable');
            });

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                rateLimiter:    mockRateLimiter,
                allowlist:      mockAllowlist,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'new@example.com', subject: 'Hi', body: 'Body', senderProfile: 'formal' });

            expect(getText(result)).toContain('check pending drafts manually');
            expect(getText(result)).toContain('send rate limit reached');
        });

        test('should append the rate limit warning when saved to Drafts pending admin approval', async () => {
            mockAllowlist.isAllowed         = mock((_platform: string, _value: string) => false);
            mockRateLimiter.isAtLimit       = mock(() => true);
            mockRateLimiter.tokensRemaining = mock(() => 0);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                rateLimiter:    mockRateLimiter,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'new@example.com', subject: 'Hi', body: 'Body', senderProfile: 'formal' });

            expect(getText(result)).toContain('pending admin approval');
            expect(getText(result)).toContain('send rate limit reached');
        });

        test('should NOT store metaData with to address in upload payload (to is a message field)', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => false);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            await handler({ to: 'target@example.com', subject: 'Hi', body: 'Body', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            // metaData carries only the preview token — to is part of the message itself
            expect(payload.metaData).toEqual({ previewToken: expect.stringMatching(PREVIEW_TOKEN_RE) });
        });

        test('stores a fresh preview token with every draft upload', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => false);
            const handler = getToolHandler(createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist }), 'sendEmail');

            await handler({ to: 'target@example.com', subject: 'Hi', body: 'Body', senderProfile: 'formal' });
            await handler({ to: 'target@example.com', subject: 'Hi', body: 'Body', senderProfile: 'formal' });

            const tokens = mockUploadMessage.mock.calls.map(call => ((call as unknown as [string, { metaData: { previewToken: string } }])[1]).metaData.previewToken);
            expect(tokens).toHaveLength(2);
            expect(tokens[0]).not.toBe(tokens[1]);
        });

        test.each([
            ['omitted', {}],
            ['text', { bodyFormat: 'text' }],
        ])('with bodyFormat %s, uploads exactly the plain body as before, with no HTML part or marker', async (_label, format) => {
            const handler = getToolHandler(createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist }), 'sendEmail');

            await handler({ to: 'target@example.com', subject: 'Hi', body: 'Body **raw** <b>x</b>', ...format });

            const [, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload).toStrictEqual({
                from:     { address: 'formal@example.com', name: 'Izzy Formal' },
                to:       [{ address: 'target@example.com' }],
                subject:  'Hi',
                text:     'Body **raw** <b>x</b>',
                draft:    true,
                metaData: { previewToken: expect.stringMatching(PREVIEW_TOKEN_RE) },
            });
        });

        test('with bodyFormat markdown, uploads the rendered text and HTML together, recording the HTML\'s digest', async () => {
            const handler = getToolHandler(createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist }), 'sendEmail');
            const html = '<p style="margin:0 0 1em">Hi <strong>there</strong> <a href="https://example.com">docs</a></p>';

            await handler({ to: 'target@example.com', subject: 'Hi', body: 'Hi **there** [docs](https://example.com)', bodyFormat: 'markdown' });

            const [, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload).toStrictEqual({
                from:     { address: 'formal@example.com', name: 'Izzy Formal' },
                to:       [{ address: 'target@example.com' }],
                subject:  'Hi',
                text:     'Hi there docs [https://example.com]',
                html,
                draft:    true,
                metaData: { previewToken: expect.stringMatching(PREVIEW_TOKEN_RE), htmlSha256: createHash('sha256').update(html).digest('hex') },
            });
        });

        test('a markdown body the renderer refuses uploads nothing and sends nothing', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);
            const handler = getToolHandler(createEmailMCPServer({ wildDuckClient: mockSendWildDuck, allowlist: mockAllowlist }), 'sendEmail');

            const result = await handler({ to: 'target@example.com', subject: 'Hi', body: 'a'.repeat(64 * 1024 + 1), bodyFormat: 'markdown' });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Nothing was saved or sent: the markdown body is larger than 64.0 KB.' }], isError: true });
            expect(mockUploadMessage).not.toHaveBeenCalled();
            expect(mockSubmitMessage).not.toHaveBeenCalled();
        });

        test('should not include rate limit warning in result when limit is not reached', async () => {
            mockAllowlist.isAllowed   = mock((_platform: string, _value: string) => true);
            mockRateLimiter.isAtLimit = mock(() => false);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                rateLimiter:    mockRateLimiter,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            const result: CallToolResult = await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

            // When limit is NOT reached, result text should not contain warning
            const text = getText(result);
            expect(text).toBe('Sent successfully.');
        });

        test('should retry getUserAddresses on second sendEmail call after first call fails', async () => {
            // First call: getUserAddresses throws
            mockGetUserAddresses = mock(async () => {
                throw new Error('WildDuck unavailable');
            });
            mockSendWildDuck.getUserAddresses = mockGetUserAddresses;
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            // First call — getUserAddresses fails, addressesLoaded stays false
            await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });
            expect(mockGetUserAddresses).toHaveBeenCalledTimes(1);

            // Second call — getUserAddresses should be called AGAIN (not skipped)
            await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });
            expect(mockGetUserAddresses).toHaveBeenCalledTimes(2);
            expect(mockLogger.warn).toHaveBeenCalledWith({
                err: expect.any(Error),
                msg: 'Failed to load WildDuck user addresses',
            });
        });

        test('should NOT retry getUserAddresses on second sendEmail call after first call succeeds', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockSendWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'sendEmail');

            // First call — getUserAddresses succeeds, addressesLoaded becomes true
            await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });
            expect(mockGetUserAddresses).toHaveBeenCalledTimes(1);

            // Second call — getUserAddresses should NOT be called again (addressesLoaded = true)
            await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });
            expect(mockGetUserAddresses).toHaveBeenCalledTimes(1);
        });

        test('should reject empty array for to via input schema (min(1) constraint)', async () => {
            const server  = createEmailMCPServer({ wildDuckClient: mockSendWildDuck });
            const toolDef = (server.instance as unknown as RegisteredToolInstance)._registeredTools.sendEmail;

            const valid = await toolDef.inputSchema.safeParseAsync({
                to: ['alice@example.com'], subject: 'Hi', body: 'Hello', senderProfile: 'formal',
            });
            expect(valid.success).toBe(true);

            const result = await toolDef.inputSchema.safeParseAsync({
                to: [], subject: 'Hi', body: 'Hello', senderProfile: 'formal',
            });
            expect(result.success).toBe(false);
            if(!result.success) {
                expect(result.error.issues.map(issue => issue.path)).toEqual([['to']]);
            }
        });
    });

    describe('replyToEmail tool', () => {
        let mockReplyWildDuck:    WildDuckClient;
        let mockRateLimiter:      TokenBucketRateLimiter;
        let mockAllowlist:        PersonAllowlist;
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
            } as unknown as TokenBucketRateLimiter;
            mockAllowlist = {
                isAllowed: mock((_platform: string, _value: string) => true),
            } as unknown as PersonAllowlist;
        });

        test('should deny reply to message in Quarantine mailbox', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'Quarantine:7', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

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

            const result: CallToolResult = await handler({ message: 'Junk:3', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

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

            const result: CallToolResult = await handler({ message: 'Drafts:2', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

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

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

            expect(result.isError).toBeUndefined();
        });

        test('should allow reply to message in Archive mailbox', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'Archive:8', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

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

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'My reply', mode: 'reply', senderProfile: 'formal' });

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

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.reference as Record<string, unknown> | undefined)?.action).toBe('reply');
            expect((payload.reference as Record<string, unknown> | undefined)?.id).toBe(42);
        });

        test.each([
            ['omitted', {}],
            ['text', { bodyFormat: 'text' }],
        ])('with bodyFormat %s, uploads exactly the plain reply body as before, with no HTML part or marker', async (_label, format) => {
            const handler = getToolHandler(createEmailMCPServer({ wildDuckClient: mockReplyWildDuck, allowlist: mockAllowlist }), 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply *raw*', mode: 'reply', ...format });

            const [, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload).toStrictEqual({
                from:      { address: 'formal@example.com', name: 'Izzy Formal' },
                subject:   'Re: Re: Hello',
                text:      'Reply *raw*',
                reference: { action: 'reply', mailbox: 'mbx-clean', id: 42 },
                draft:     true,
                metaData:  { previewToken: expect.stringMatching(PREVIEW_TOKEN_RE) },
            });
        });

        test('with bodyFormat markdown, uploads the rendered reply text and HTML together, recording the HTML\'s digest', async () => {
            const handler = getToolHandler(createEmailMCPServer({ wildDuckClient: mockReplyWildDuck, allowlist: mockAllowlist }), 'replyToEmail');
            const html = '<p style="margin:0 0 1em">Reply <em>styled</em></p>';

            await handler({ message: 'CleanInbox:42', body: 'Reply *styled*', mode: 'reply', bodyFormat: 'markdown' });

            const [, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.text).toBe('Reply styled');
            expect(payload.html).toBe(html);
            expect(payload.metaData).toEqual({ previewToken: expect.stringMatching(PREVIEW_TOKEN_RE), htmlSha256: createHash('sha256').update(html).digest('hex') });
        });

        test('a markdown reply the renderer refuses uploads nothing and sends nothing', async () => {
            const handler = getToolHandler(createEmailMCPServer({ wildDuckClient: mockReplyWildDuck, allowlist: mockAllowlist }), 'replyToEmail');

            const result = await handler({ message: 'CleanInbox:42', body: `${'>'.repeat(30)} deep`, mode: 'reply', bodyFormat: 'markdown' });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Nothing was saved or sent: the markdown body nests lists or block quotes too deeply.' }], isError: true });
            expect(mockUploadMessage).not.toHaveBeenCalled();
            expect(mockSubmitMessage).not.toHaveBeenCalled();
        });

        test('should build reference object with replyAll action for replyAll mode', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply all', mode: 'replyAll', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.reference as Record<string, unknown> | undefined)?.action).toBe('replyAll');
        });

        test('should NOT include flags field in replyToEmail upload payload', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.flags).toBeUndefined();
        });

        test('should set draft flag to true in replyToEmail upload payload', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.draft).toBe(true);
            expect(payload).not.toHaveProperty('attachments');
        });

        test('reply upload and approval preserve subject and attachment details', async () => {
            mockAllowlist.isAllowed = mock(() => false);
            const requestApproval = mock(async (_uid: number, _previousUid?: number) => 'posted');
            const server = createEmailMCPServer({ wildDuckClient: mockReplyWildDuck, allowlist: mockAllowlist, approvalCards: cardPort(requestApproval), attachmentRoot: ATTACHMENT_ROOT, readAttachmentFile: attachmentFiles({ 'tmp/reply.txt': 'reply file' }) });
            await getToolHandler(server, 'replyToEmail')({
                message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal', attachments: ['tmp/reply.txt'],
            });
            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.subject).toBe('Re: Re: Hello');
            expect(payload.attachments).toEqual([{ filename: 'reply.txt', contentType: 'text/plain', content: Buffer.from('reply file').toString('base64') }]);
            expect(requestApproval.mock.calls).toEqual([[88, undefined]]);
            expect(mockAllowlist.isAllowed).toHaveBeenCalledWith('email', 'alice@example.com');
        });

        test('refuses an attachment outside the working directory, uploading nothing', async () => {
            const read = attachmentFiles(() => 'secret');
            const server = createEmailMCPServer({ wildDuckClient: mockReplyWildDuck, allowlist: mockAllowlist, attachmentRoot: ATTACHMENT_ROOT, readAttachmentFile: read });

            const result = await getToolHandler(server, 'replyToEmail')({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', attachments: ['/etc/passwd'] });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Nothing was saved or sent: the attachment "/etc/passwd" is outside your working directory.' }], isError: true });
            expect(read).not.toHaveBeenCalled();
            expect(mockUploadMessage).not.toHaveBeenCalled();
            expect(mockSubmitMessage).not.toHaveBeenCalled();
        });

        test('reply with missing sender and subject retains empty fallbacks', async () => {
            mockGetMessage = mock(async () => ({ ...originalEmail, from: undefined, replyTo: undefined, subject: undefined }));
            mockReplyWildDuck.getMessage = mockGetMessage;
            mockAllowlist.isAllowed = mock(() => false);
            const requestApproval = mock(async (_uid: number, _previousUid?: number) => 'posted');
            const server = createEmailMCPServer({ wildDuckClient: mockReplyWildDuck, allowlist: mockAllowlist, approvalCards: cardPort(requestApproval) });
            const result = await getToolHandler(server, 'replyToEmail')({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });
            expect(result.isError).toBeUndefined();
            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.subject).toBe('Re: ');
            expect(payload).not.toHaveProperty('attachments');
            expect(requestApproval.mock.calls).toEqual([[88, undefined]]);
            expect(mockAllowlist.isAllowed).toHaveBeenCalledWith('email', '');
        });

        test('a plain reply without an allowlist remains pending approval', async () => {
            const requestApproval = mock(async (_uid: number, _previousUid?: number) => 'posted');
            const server = createEmailMCPServer({ wildDuckClient: mockReplyWildDuck, approvalCards: cardPort(requestApproval) });
            const result = await getToolHandler(server, 'replyToEmail')({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });
            expect(getText(result)).toBe('Message saved to Drafts, pending admin approval (draft UID: 88).');
            expect(mockSubmitMessage).not.toHaveBeenCalled();
            expect(requestApproval.mock.calls).toEqual([[88, undefined]]);
        });

        test('should use informalAddress from getUserAddresses for informal identity in reply', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'informal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.from as { address: string }).address).toBe('informal@example.com');
            expect((payload.from as { name: string }).name).toBe('Izzy Informal');
        });

        test('replyToEmail through the SDK MCP validator accepts an omitted senderProfile and replies from the formal address', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });

            const result = await callSdkTool(server, 'replyToEmail', { message: 'CleanInbox:42', body: 'Reply', mode: 'reply' });

            expect(result.isError).toBeUndefined();
            expect(mockUploadMessage).toHaveBeenCalledTimes(1);
            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect(payload.from).toEqual({ address: 'formal@example.com', name: 'Izzy Formal' });
        });

        test('a plain reply to an allowlisted sender is sent without a card', async () => {
            const mockSendApprovalRequestReply = mock(async () => 'posted');
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
                approvalCards:  cardPort(mockSendApprovalRequestReply),
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

            expect(getText(result)).toBe('Reply sent to alice@example.com.');
            expect(mockSendApprovalRequestReply).not.toHaveBeenCalled();
            expect(mockSubmitMessage).toHaveBeenCalledTimes(1);
        });

        test('should call getMailboxId with mailbox name to resolve mailbox ID', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

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

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            expect((payload.reference as Record<string, unknown> | undefined)?.mailbox).toBe('mbx-clean-resolved');
        });

        test('should upload to Drafts and NOT submit when recipient not on allowlist', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => false);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

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

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('replyToEmail', 'unavailable') }], isError: true });
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'replyToEmail', detail: 'getMessage failed', msg: 'Email tool failed' }));
        });

        test('should return error when getMessage returns null', async () => {
            mockGetMessage = mock(() => Promise.resolve(null));
            mockReplyWildDuck.getMessage = mockGetMessage;

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

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

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

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

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

            // When limit is NOT reached, result text should not contain warning
            const text = getText(result);
            expect(text).not.toContain('send rate limit reached');
        });

        test('should NOT store metaData with to address in upload payload (to is a message field)', async () => {
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => false);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessage.mock.calls[0] as [string, Record<string, unknown>];
            // metaData carries only the preview token — to is part of the message itself
            expect(payload.metaData).toEqual({ previewToken: expect.stringMatching(PREVIEW_TOKEN_RE) });
        });

        test('should use replyTo.address from WildDuck message for allowlist check when replyTo present', async () => {
            // WildDuck provides pre-parsed replyTo with .address — no regex needed
            mockGetMessage = mock(async () => ({
                ...originalEmail,
                replyTo: { address: 'john@example.com', name: 'John Smith' },
            }));
            mockReplyWildDuck.getMessage = mockGetMessage;
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

            // Should succeed using the pre-parsed replyTo.address
            expect(result.isError).toBeUndefined();
            expect(mockAllowlist.isAllowed).toHaveBeenCalledWith('email', 'john@example.com');
        });

        test('should fall back to from.address when replyTo is absent in WildDuck message', async () => {
            // When WildDuck message has no replyTo, use from.address
            mockGetMessage = mock(async () => ({
                ...originalEmail,
                // no replyTo field
            }));
            mockReplyWildDuck.getMessage = mockGetMessage;
            mockAllowlist.isAllowed = mock((_platform: string, _value: string) => true);

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

            // from.address is 'alice@example.com'
            expect(mockAllowlist.isAllowed).toHaveBeenCalledWith('email', 'alice@example.com');
        });

        test('should pass allowlist check for allowlisted replyTo.address from WildDuck', async () => {
            // WildDuck provides pre-parsed address — allowlist check uses the address field directly
            mockGetMessage = mock(async () => ({
                ...originalEmail,
                replyTo: { address: 'john@example.com', name: 'John Smith' },
            }));
            mockReplyWildDuck.getMessage = mockGetMessage;
            // Allowlist allows only the bare address
            mockAllowlist.isAllowed = mock((_platform: string, addr: string) => addr === 'john@example.com');

            const server = createEmailMCPServer({
                wildDuckClient: mockReplyWildDuck,
                allowlist:      mockAllowlist,
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

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

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

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

            const result: CallToolResult = await handler({ to: 'alice@example.com', subject: 'Hi', body: 'Hello', senderProfile: 'formal' });

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

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply', mode: 'reply', senderProfile: 'formal' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('no sender address');
            expect(mockUploadMessage).not.toHaveBeenCalled();
        });
    });

    describe('replyToEmail tool - replyAll mode always requires approval', () => {
        let mockWildDuckReplyAll:            WildDuckClient;
        let mockAllowlistReplyAll:           PersonAllowlist;
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
            mockSendApprovalRequestReplyAll = mock(async () => 'posted');
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
                isAllowed: mock((_platform: string, _value: string) => true),
            } as unknown as PersonAllowlist;
        });

        test('replyAll should always route to approval even when primary recipient is on allowlist', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckReplyAll,
                allowlist:      mockAllowlistReplyAll,
                approvalCards:  cardPort(mockSendApprovalRequestReplyAll),
            });
            const handler = getToolHandler(server, 'replyToEmail');

            const result: CallToolResult = await handler({ message: 'CleanInbox:42', body: 'Reply all', mode: 'replyAll', senderProfile: 'formal' });

            expect(result.isError).toBeUndefined();
            // Should NOT have submitted directly even though allowlist returns true
            expect(mockSubmitMessageReplyAll).not.toHaveBeenCalled();
            // Should have requested approval
            expect(mockSendApprovalRequestReplyAll).toHaveBeenCalledTimes(1);
            expect(getText(result)).toContain('pending admin approval');
        });

        test('replyAll presents the uploaded draft (whose stored Cc the card shows) with no previous uid, never consulting the allowlist', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckReplyAll,
                allowlist:      mockAllowlistReplyAll,
                approvalCards:  cardPort(mockSendApprovalRequestReplyAll),
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply all', mode: 'replyAll', senderProfile: 'formal' });

            expect(mockSendApprovalRequestReplyAll.mock.calls).toEqual([[88, undefined]]);
            expect(mockAllowlistReplyAll.isAllowed).not.toHaveBeenCalled();
        });

        test('replyAll upload payload should not contain cc (WildDuck derives recipients from reference object)', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckReplyAll,
                allowlist:      mockAllowlistReplyAll,
                approvalCards:  cardPort(mockSendApprovalRequestReplyAll),
            });
            const handler = getToolHandler(server, 'replyToEmail');

            await handler({ message: 'CleanInbox:42', body: 'Reply all', mode: 'replyAll', senderProfile: 'formal' });

            const [_folder, payload] = mockUploadMessageReplyAll.mock.calls[0] as [string, Record<string, unknown>];
            // cc should NOT be in the upload payload — WildDuck derives it from the reference
            expect(payload.cc).toBeUndefined();
            expect((payload.metaData as Record<string, unknown> | undefined)?.cc).toBeUndefined();
        });
    });

    describe('deleteDraft tool', () => {
        let mockWildDuckDelete:   WildDuckClient;
        let mockDeleteMessage:    ReturnType<typeof mock>;
        let mockGetMessageDelete: ReturnType<typeof mock>;
        const LINKED_META = { approvalCard: { channelId: 'admin-ch', messageId: 'card-1', edits: 0 } };

        beforeEach(() => {
            mockDeleteMessage = mock(async () => { /* intentionally empty */ });
            mockGetMessageDelete = mock(async (_folder: string, uid: number) => ({ id: uid, draft: true, subject: 'Hi', metaData: LINKED_META }));
            mockWildDuckDelete = {
                deleteMessage: mockDeleteMessage,
                getMessage:    mockGetMessageDelete,
            } as unknown as WildDuckClient;
        });

        test('should read, then delete the draft and return success message', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete });
            const handler = getToolHandler(server, 'deleteDraft');

            const result: CallToolResult = await handler({ message: 'Drafts:42' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toBe('Draft Drafts:42 deleted.');
            expect(mockGetMessageDelete).toHaveBeenCalledWith('Drafts', 42, expect.any(AbortSignal));
            expect(mockDeleteMessage).toHaveBeenCalledWith('Drafts', 42, expect.any(AbortSignal));
            expect(mockGetMessageDelete.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteMessage.mock.invocationCallOrder[0]);
        });

        test('marks the linked approval card deleted, from the pre-delete read, after the delete', async () => {
            const markDeleted = mock(async (_draft: unknown, _uid: number) => {
                expect(mockDeleteMessage).toHaveBeenCalledTimes(1);
            });
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete, approvalCards: cardPort(mock(async () => 'posted'), { markDeleted }) });

            const result = await getToolHandler(server, 'deleteDraft')({ message: 'Drafts:42' });

            expect(markDeleted.mock.calls).toEqual([[{ id: 42, draft: true, subject: 'Hi', metaData: LINKED_META }, 42]]);
            expect(getText(result)).toBe('Draft Drafts:42 deleted. The admin\'s approval card was marked deleted.');
        });

        test('does not report the delete until the approval card has been marked', async () => {
            const marking = Promise.withResolvers<undefined>();
            const markDeleted = mock(async () => marking.promise);
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete, approvalCards: cardPort(mock(async () => 'posted'), { markDeleted }) });
            let settled = false;

            const pending = getToolHandler(server, 'deleteDraft')({ message: 'Drafts:42' }).then((result) => {
                settled = true;
                return result;
            });
            for(let i = 0; i < 20; i++) {
                // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
                await Promise.resolve();
            }

            expect(markDeleted).toHaveBeenCalledTimes(1);
            expect(settled).toBe(false);
            marking.resolve(undefined);
            expect(getText(await pending)).toBe('Draft Drafts:42 deleted. The admin\'s approval card was marked deleted.');
        });

        test.each([
            ['no card link', {}],
            ['a rejection', { ...LINKED_META, rejectedAt: 'then' }],
        ])('does not claim a card was marked for a draft with %s', async (_label, metaData) => {
            mockGetMessageDelete.mockImplementation(async () => ({ id: 42, draft: true, metaData }));
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete, approvalCards: cardPort(mock(async () => 'posted')) });

            const result = await getToolHandler(server, 'deleteDraft')({ message: 'Drafts:42' });

            expect(getText(result)).toBe('Draft Drafts:42 deleted.');
        });

        test('refuses to delete a draft with an admin approval recorded', async () => {
            mockGetMessageDelete.mockImplementation(async () => ({ id: 42, draft: true, metaData: { approval: { actionId: 'a', at: 'b' } } }));
            const markDeleted = mock(async () => undefined);
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete, approvalCards: cardPort(mock(async () => 'posted'), { markDeleted }) });

            const result = await getToolHandler(server, 'deleteDraft')({ message: 'Drafts:42' });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Draft Drafts:42 has an admin approval recorded; it can\'t be deleted.' }], isError: true });
            expect(mockDeleteMessage).not.toHaveBeenCalled();
            expect(markDeleted).not.toHaveBeenCalled();
        });

        test('reports a draft that does not exist, deleting nothing', async () => {
            mockGetMessageDelete.mockImplementation(async () => null);
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete });

            const result = await getToolHandler(server, 'deleteDraft')({ message: 'Drafts:42' });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Draft Drafts:42 not found.' }], isError: true });
            expect(mockDeleteMessage).not.toHaveBeenCalled();
        });

        test('should parse UID from Drafts:UID format', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete });
            const handler = getToolHandler(server, 'deleteDraft');

            await handler({ message: 'Drafts:99' });

            expect(mockDeleteMessage).toHaveBeenCalledWith('Drafts', 99, expect.any(AbortSignal));
        });

        test('should return error when deleteMessage throws', async () => {
            mockDeleteMessage = mock(async () => {
                throw new Error('WildDuck delete failed');
            });
            mockWildDuckDelete.deleteMessage = mockDeleteMessage;

            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete });
            const handler = getToolHandler(server, 'deleteDraft');

            const result: CallToolResult = await handler({ message: 'Drafts:42' });

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('deleteDraft', 'unavailable') }], isError: true });
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'deleteDraft', detail: 'WildDuck delete failed', msg: 'Email tool failed' }));
        });

        describe('under the draft lock', () => {
            let events: string[];
            let draftLocks: { acquire: ReturnType<typeof mock> };

            beforeEach(() => {
                events = [];
                draftLocks = {
                    acquire: mock(async (key: string) => {
                        events.push(`acquire ${key}`);
                        return () => {
                            events.push(`release ${key}`);
                        };
                    }),
                };
                mockGetMessageDelete.mockImplementation(async (_folder: string, uid: number) => {
                    events.push('read');
                    return { id: uid, draft: true, metaData: LINKED_META };
                });
                mockDeleteMessage.mockImplementation(async () => {
                    events.push('delete');
                });
            });

            test('reads, checks and deletes holding email-draft:<uid>, releasing it before the card is marked', async () => {
                const markDeleted = mock(async () => {
                    events.push('markDeleted');
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete, draftLocks, approvalCards: cardPort(mock(async () => 'posted'), { markDeleted }) });

                const result = await getToolHandler(server, 'deleteDraft')({ message: 'Drafts:42' });

                expect(getText(result)).toBe('Draft Drafts:42 deleted. The admin\'s approval card was marked deleted.');
                expect(events).toEqual(['acquire email-draft:42', 'read', 'delete', 'release email-draft:42', 'markDeleted']);
            });

            test.each([
                ['an approved draft', async () => ({ id: 42, draft: true, metaData: { approval: { actionId: 'a', at: 'b' } } }), ['acquire email-draft:42', 'release email-draft:42']],
                ['a missing draft', async () => null, ['acquire email-draft:42', 'release email-draft:42']],
            ])('releases the lock after refusing %s', async (_label, read, expected) => {
                mockGetMessageDelete.mockImplementation(read);
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete, draftLocks });

                const result = await getToolHandler(server, 'deleteDraft')({ message: 'Drafts:42' });

                expect(result.isError).toBe(true);
                expect(events).toEqual(expected);
            });

            test('releases the lock when the delete throws', async () => {
                mockDeleteMessage.mockImplementation(async () => {
                    events.push('delete');
                    throw new Error('WildDuck delete failed');
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete, draftLocks });

                const result = await getToolHandler(server, 'deleteDraft')({ message: 'Drafts:42' });

                expect(result.isError).toBe(true);
                expect(events).toEqual(['acquire email-draft:42', 'read', 'delete', 'release email-draft:42']);
            });

            test('an approval recorded while the delete waited for the lock is seen, and the draft is kept', async () => {
                let metaData: Record<string, unknown> = { ...LINKED_META };
                mockGetMessageDelete.mockImplementation(async () => ({ id: 42, draft: true, metaData }));
                let releaseApprove!: () => void;
                const approveHeld = new Promise<void>((resolve) => {
                    releaseApprove = resolve;
                });
                draftLocks.acquire.mockImplementation(async () => {
                    await approveHeld;
                    return () => { /* intentionally empty */ };
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckDelete, draftLocks });

                const deleting = getToolHandler(server, 'deleteDraft')({ message: 'Drafts:42' });
                await drainMicrotasks(50);
                expect(draftLocks.acquire.mock.calls).toEqual([['email-draft:42']]);
                expect(mockGetMessageDelete).not.toHaveBeenCalled();
                metaData = { ...LINKED_META, approval: { actionId: 'act', at: 'now' } };
                releaseApprove();
                const result = await deleting;

                expect(getText(result)).toBe('Draft Drafts:42 has an admin approval recorded; it can\'t be deleted.');
                expect(mockDeleteMessage).not.toHaveBeenCalled();
            });
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
        let mockDeleteMessageAmend:  ReturnType<typeof mock>;

        const LINK = { channelId: 'admin-ch', messageId: 'card-1', edits: 1 };
        /** The pending-approval result for the amended Drafts:55. */
        const PENDING = 'Message saved to Drafts, pending admin approval (draft UID: 55).';
        /** What an amend of a draft with no Cc and no attachments says it carried. */
        const NOTHING_CARRIED = ' Cc: 0 addresses (kept from the original draft). Attachments: 0 kept from the original draft, 0 removed, 0 added.';
        const THREAD_KEPT = ' Its References header matches the original draft\'s, so it stays in the same conversation.';
        const THREAD_KEPT_VIA_HEADERS = ' Its References header matches the original draft\'s, so it stays in the same conversation. It was threaded from the original draft\'s own reply headers, so sending it will not mark the message it replies to as answered.';
        const THREAD_LOST = ' Warning: the amended draft is no longer threaded as a reply to the original conversation; the recipient will see it as a new message. To keep the thread, delete this draft and reply to the original message again with replyToEmail.';
        const THREAD_UNVERIFIED = ' Warning: could not confirm whether the amended draft is still threaded as a reply; check the draft before it is approved.';
        const OLD_UID_LEFT = ' Warning: the previous version Drafts:42 could not be removed; delete it with deleteDraft.';
        /** WildDuck's ids for the mailboxes a reply may reference (CleanInbox and Archive), and one it may not. */
        const MAILBOX_IDS: Record<string, string> = { CleanInbox: 'a'.repeat(24), Archive: 'c'.repeat(24), Quarantine: 'q'.repeat(24) };
        const originalDraft = {
            id:         42,
            draft:      true,
            subject:    'Original Subject',
            to:         [{ address: 'original-to@example.com' }],
            cc:         [] as { address: string }[],
            text:       'Original body text',
            references: [] as string[],
            metaData:   {} as Record<string, unknown>,
        };

        beforeEach(() => {
            mockGetMessageAmend    = mock(async () => originalDraft);
            mockUploadMessageAmend = mock(async () => ({ id: 55, previousDeleted: true }));
            mockDeleteMessageAmend = mock(async () => undefined);
            mockGetUserAddresses   = mock(async () => [
                { id: '1', address: 'formal@example.com',   name: 'Izzy Formal',   main: false, tags: ['formal']   },
                { id: '2', address: 'informal@example.com', name: 'Izzy Informal', main: false, tags: ['informal'] },
            ]);
            mockSendApprovalRequest = mock(async () => 'posted');
            mockWildDuckAmend = {
                getMessage:            mockGetMessageAmend,
                getMailboxId:          mock((folder: string) => MAILBOX_IDS[folder]),
                uploadReplacingDraft:  mockUploadMessageAmend,
                deleteMessage:         mockDeleteMessageAmend,
                getUserAddresses:      mockGetUserAddresses,
                updateMessageMetadata: mock(async () => { /* intentionally empty */ }),
                updateMessageFlags:    mock(async () => { /* intentionally empty */ }),
            } as unknown as WildDuckClient;
        });

        test.each([
            ['false', false],
            ['absent', undefined],
            ['not the boolean true', 'true'],
        ])('refuses a message whose draft flag is %s, reading nothing more and changing nothing', async (_label, draft) => {
            const openAttachmentStream = mock(async () => null);
            mockWildDuckAmend.openAttachmentStream = openAttachmentStream;
            mockGetMessageAmend.mockImplementation(async () => ({ ...originalDraft, draft, attachments: [{ id: 'ATT1', filename: 'a.pdf', contentType: 'application/pdf', sizeKb: 1, size: 10 }] }));
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mockSendApprovalRequest) });

            const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Drafts:42 is not a draft; it can\'t be amended.' }], isError: true });
            expect(mockGetMessageAmend).toHaveBeenCalledTimes(1);
            expect(openAttachmentStream).not.toHaveBeenCalled();
            expect(mockUploadMessageAmend).not.toHaveBeenCalled();
            expect(mockDeleteMessageAmend).not.toHaveBeenCalled();
            expect(mockSendApprovalRequest).not.toHaveBeenCalled();
        });

        describe('the HTML version', () => {
            const ORIGINAL_HTML = '<p style="margin:0 0 1em">Original <strong>body</strong></p>';
            const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
            /** The original draft with a verified HTML part (stored with CRLF line breaks, as WildDuck's MIME encoding leaves them). */
            const withHtml = { ...originalDraft, html: [ORIGINAL_HTML], metaData: { htmlSha256: sha(ORIGINAL_HTML) } };
            const KEPT = ' HTML version: kept from the original draft.';
            const RENDERED = ' HTML version: rendered from the new markdown body.';
            const REMOVED = ' HTML version: removed; the new version is plain text only.';
            const MISMATCH = ' Warning: the amended draft\'s HTML version is not what this amend uploaded; check it before it is approved.';
            const UNCONFIRMED = ' The HTML version could not be confirmed on the stored draft either.';
            const NOT_CONFIRMED = ' Cc and attachments were sent to WildDuck (0 Cc, 0 attachments kept, 0 removed, 0 added) but could not be confirmed on the stored draft.';
            const DROPPED = ' Warning: the original draft\'s HTML version could not be verified, so it was not carried; the new version is plain text only. Check it before it is approved.';

            /** The original (Drafts:42) and the new version as WildDuck stores it (Drafts:55, echoing the upload's html and metaData unless `stored` says otherwise). */
            function drafts(original: Record<string, unknown>, stored?: Record<string, unknown> | null): void {
                mockGetMessageAmend.mockImplementation(async (_folder: string, uid: number) => {
                    if(uid === 42) {
                        return original;
                    }
                    if(stored === null) {
                        throw new Error('read-back failed');
                    }
                    const [payload] = mockUploadMessageAmend.mock.calls[0] as [{ html?: string, metaData: Record<string, unknown> }];
                    return { id: 55, cc: [], attachments: [], references: [], html: payload.html === undefined ? ['<p>synthesised</p>'] : [payload.html.replaceAll('\n', '\r\n')], metaData: payload.metaData, ...stored };
                });
            }

            async function amend(args: Record<string, unknown>): Promise<CallToolResult> {
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mockSendApprovalRequest) });
                return getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42', ...args });
            }

            const uploaded = (): Record<string, unknown> => (mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>])[0];

            test('bodyFormat without body is refused before anything is read or changed', async () => {
                expect(await amend({ bodyFormat: 'markdown' })).toEqual({
                    content: [{ type: 'text', text: 'Could not amend draft Drafts:42: bodyFormat was given without body; give the new body with it, or leave both out to keep the draft\'s body. Nothing was changed.' }],
                    isError: true,
                });
                expect(mockGetMessageAmend).not.toHaveBeenCalled();
                expect(mockUploadMessageAmend).not.toHaveBeenCalled();
            });

            test('a markdown body the renderer refuses is refused before anything is read or changed', async () => {
                expect(await amend({ body: 'a'.repeat(64 * 1024 + 1), bodyFormat: 'markdown' })).toEqual({
                    content: [{ type: 'text', text: 'Could not amend draft Drafts:42: the markdown body is larger than 64.0 KB. Nothing was changed.' }],
                    isError: true,
                });
                expect(mockGetMessageAmend).not.toHaveBeenCalled();
                expect(mockUploadMessageAmend).not.toHaveBeenCalled();
            });

            test('a new markdown body uploads its rendered text and HTML with a new digest, confirmed on the stored draft', async () => {
                drafts(withHtml);
                const html = '<p style="margin:0 0 1em">New <em>body</em></p>';

                expect(getText(await amend({ body: 'New *body*', bodyFormat: 'markdown' }))).toBe(`${PENDING}${NOTHING_CARRIED}${RENDERED}`);

                expect(uploaded()).toMatchObject({ text: 'New body', html, metaData: { previewToken: expect.stringMatching(PREVIEW_TOKEN_RE), htmlSha256: sha(html) } });
            });

            test('a new plain-text body uploads text only and says the original\'s HTML version was removed', async () => {
                drafts(withHtml);

                expect(getText(await amend({ body: 'Plain *now*', bodyFormat: 'text' }))).toBe(`${PENDING}${NOTHING_CARRIED}${REMOVED}`);

                expect(uploaded().text).toBe('Plain *now*');
                expect(Object.hasOwn(uploaded(), 'html')).toBe(false);
                expect(Object.hasOwn(uploaded().metaData as object, 'htmlSha256')).toBe(false);
            });

            test('a new body without bodyFormat is plain text, and a draft without an HTML version says nothing about HTML', async () => {
                drafts(originalDraft);

                expect(getText(await amend({ body: 'Plain' }))).toBe(`${PENDING}${NOTHING_CARRIED}`);

                expect(Object.hasOwn(uploaded(), 'html')).toBe(false);
            });

            test('keeping the body carries the original text and its verified HTML unchanged, with the same digest', async () => {
                drafts({ ...withHtml, html: [ORIGINAL_HTML.replaceAll('\n', '\r\n')] });

                expect(getText(await amend({ subject: 'New subject' }))).toBe(`${PENDING}${NOTHING_CARRIED}${KEPT}`);

                expect(uploaded()).toMatchObject({ text: 'Original body text', html: ORIGINAL_HTML, metaData: { htmlSha256: sha(ORIGINAL_HTML) } });
            });

            test('keeping the body of a draft whose html is WildDuck\'s synthesised version carries the text only, as before', async () => {
                drafts({ ...originalDraft, html: ['<p>Original body text</p>'] });

                expect(getText(await amend({}))).toBe(`${PENDING}${NOTHING_CARRIED}`);

                expect(Object.hasOwn(uploaded(), 'html')).toBe(false);
                expect(Object.hasOwn(uploaded().metaData as object, 'htmlSha256')).toBe(false);
            });

            test('keeping the body of a draft whose HTML no longer matches its digest carries the text only, with a warning', async () => {
                drafts({ ...withHtml, html: ['<p>tampered</p>'] });

                expect(getText(await amend({}))).toBe(`${PENDING}${NOTHING_CARRIED}${DROPPED}`);

                expect(Object.hasOwn(uploaded(), 'html')).toBe(false);
            });

            test.each([
                ['kept', {}, { html: ['<p>other</p>'] }],
                ['rendered', { body: '*x*', bodyFormat: 'markdown' }, { metaData: {} }],
                ['removed', { body: 'x' }, { metaData: { htmlSha256: sha('<p>x</p>') }, html: ['<p>x</p>'] }],
            ])('warns when the stored new version\'s HTML is not what was uploaded (%s)', async (_label, args, stored) => {
                drafts(withHtml, stored);

                expect(getText(await amend(args))).toBe(`${PENDING}${NOTHING_CARRIED}${MISMATCH}`);
            });

            test.each([
                ['kept', {}, KEPT],
                ['rendered', { body: '*x*', bodyFormat: 'markdown' }, RENDERED],
                ['removed', { body: 'x' }, REMOVED],
            ])('says the HTML version (%s) could not be confirmed when the read-back fails', async (_label, args, note) => {
                drafts(withHtml, null);

                expect(getText(await amend(args))).toBe(`${PENDING}${NOT_CONFIRMED}${note}${UNCONFIRMED}`);
            });

            test('a failed read-back of a draft without HTML adds nothing about HTML', async () => {
                drafts(originalDraft, null);

                expect(getText(await amend({}))).toBe(`${PENDING}${NOT_CONFIRMED}`);
            });
        });

        test('uploads the new version carrying the card link with one more edit, and nothing else of the old metaData', async () => {
            mockGetMessageAmend.mockImplementation(async () => ({
                ...originalDraft,
                metaData: { approvalCard: LINK, rejectedAt: 'then', reason: 'too long', previewToken: 'old', other: 'x' },
            }));
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mockSendApprovalRequest) });

            await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            const [payload, previousUid] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            expect(previousUid).toBe(42);
            expect(payload.metaData).toEqual({ approvalCard: { ...LINK, edits: 2 }, previewToken: expect.stringMatching(PREVIEW_TOKEN_RE) });
            expect(mockSendApprovalRequest.mock.calls).toEqual([[55, 42]]);
        });

        test('uploads only a fresh preview token for a draft without a card link, never the old token', async () => {
            const oldToken = 'o'.repeat(43);
            mockGetMessageAmend.mockImplementation(async () => ({ ...originalDraft, metaData: { previewToken: oldToken } }));
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mockSendApprovalRequest) });

            await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [{ metaData: { previewToken: string } }, number];
            expect(payload.metaData).toEqual({ previewToken: expect.stringMatching(PREVIEW_TOKEN_RE) });
            expect(payload.metaData.previewToken).not.toBe(oldToken);
        });

        test('reports an in-place card update with its edit number', async () => {
            mockGetMessageAmend.mockImplementation(async () => ({ ...originalDraft, metaData: { approvalCard: LINK } }));
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mock(async () => 'updated')) });

            const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toBe(`Draft saved as Drafts:55; the admin's approval card was updated in place (edit 2).${NOTHING_CARRIED}`);
        });

        test('reports an in-place update of an unlinked draft as its first edit', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mock(async () => 'updated')) });

            const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            expect(getText(result)).toBe(`Draft saved as Drafts:55; the admin's approval card was updated in place (edit 1).${NOTHING_CARRIED}`);
        });

        test('refuses a draft with an admin approval recorded, uploading nothing', async () => {
            mockGetMessageAmend.mockImplementation(async () => ({ ...originalDraft, metaData: { approval: { actionId: 'a', at: 'b' } } }));
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mockSendApprovalRequest) });

            const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Draft Drafts:42 has an admin approval recorded; it can\'t be amended.' }], isError: true });
            expect(mockUploadMessageAmend).not.toHaveBeenCalled();
        });

        test('refuses a draft already replaced, uploading nothing', async () => {
            mockGetMessageAmend.mockImplementation(async () => ({ ...originalDraft, metaData: { supersededBy: 60 } }));
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mockSendApprovalRequest) });

            const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Draft Drafts:42 was already replaced by Drafts:60.' }], isError: true });
            expect(mockUploadMessageAmend).not.toHaveBeenCalled();
        });

        test('deletes nothing more when WildDuck reports the old draft deleted', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mockSendApprovalRequest) });

            await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            expect(mockDeleteMessageAmend).not.toHaveBeenCalled();
        });

        test('deletes the old draft itself when WildDuck did not, before presenting the new one', async () => {
            mockUploadMessageAmend.mockImplementation(async () => ({ id: 55, previousDeleted: false }));
            const markSuperseded = mock(async (_oldUid: number, _newUid: number) => true);
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mockSendApprovalRequest, { markSuperseded }) });

            const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            expect(mockDeleteMessageAmend.mock.calls).toEqual([['Drafts', 42, expect.any(AbortSignal)]]);
            expect(mockDeleteMessageAmend.mock.invocationCallOrder[0]).toBeLessThan(mockSendApprovalRequest.mock.invocationCallOrder[0]);
            expect(markSuperseded).not.toHaveBeenCalled();
            expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}`);
        });

        test('treats an old draft already gone (404) as deleted', async () => {
            mockUploadMessageAmend.mockImplementation(async () => ({ id: 55, previousDeleted: false }));
            mockDeleteMessageAmend.mockImplementation(async () => {
                throw new WildDuckError('WildDuck API error: 404 Not Found', undefined, { status: 404 });
            });
            const markSuperseded = mock(async (_oldUid: number, _newUid: number) => true);
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mockSendApprovalRequest, { markSuperseded }) });

            const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            expect(markSuperseded).not.toHaveBeenCalled();
            expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}`);
        });

        test('marks the old draft superseded when it cannot be deleted', async () => {
            mockUploadMessageAmend.mockImplementation(async () => ({ id: 55, previousDeleted: false }));
            const failure = new WildDuckError('WildDuck API error: 500', undefined, { status: 500 });
            mockDeleteMessageAmend.mockImplementation(async () => {
                throw failure;
            });
            const markSuperseded = mock(async (_oldUid: number, _newUid: number) => true);
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mockSendApprovalRequest, { markSuperseded }) });

            const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            expect(markSuperseded.mock.calls).toEqual([[42, 55]]);
            expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}`);
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: failure, oldUid: 42, newUid: 55, msg: 'Could not delete the amended draft’s previous version — marking it superseded' });
        });

        test('warns in the tool text when the old draft can be neither deleted nor marked superseded', async () => {
            mockUploadMessageAmend.mockImplementation(async () => ({ id: 55, previousDeleted: false }));
            mockDeleteMessageAmend.mockImplementation(async () => {
                throw new Error('network down');
            });
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mockSendApprovalRequest, { markSuperseded: mock(async () => false) }) });

            const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${OLD_UID_LEFT}`);
        });

        test('without approval cards, marks the old draft superseded through the fallback', async () => {
            mockUploadMessageAmend.mockImplementation(async () => ({ id: 55, previousDeleted: false }));
            mockDeleteMessageAmend.mockImplementation(async () => {
                throw new Error('network down');
            });
            const markSuperseded = mock(async (_oldUid: number, _newUid: number) => true);
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, markSuperseded });

            const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            expect(markSuperseded.mock.calls).toEqual([[42, 55]]);
            expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}`);
        });

        test('without approval cards or a fallback, warns that the old draft remains', async () => {
            mockUploadMessageAmend.mockImplementation(async () => ({ id: 55, previousDeleted: false }));
            mockDeleteMessageAmend.mockImplementation(async () => {
                throw new Error('network down');
            });
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend });

            const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${OLD_UID_LEFT}`);
        });

        test('amend schema accepts multiple recipients and either identity', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const schema = (server.instance as unknown as RegisteredToolInstance)._registeredTools.amendAndResubmitDraft.inputSchema;
            const validResults = await Promise.all(['formal', 'informal'].map(senderProfile => schema.safeParseAsync({ message: 'Drafts:42', senderProfile, to: ['one@example.com', 'two@example.com'] })));
            const invalidResult = await schema.safeParseAsync({ message: 'Drafts:42', to: [] });
            expect(validResults.every(result => result.success)).toBe(true);
            expect(invalidResult.success).toBe(false);
        });

        test('should read original draft, amend, and re-upload with replacePrevious', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            const result: CallToolResult = await handler({ message: 'Drafts:42', subject: 'Updated Subject' });

            expect(result.isError).toBeUndefined();
            // Routes through approval — result contains pending admin approval message with the UID
            expect(getText(result)).toContain('pending admin approval');
            expect(getText(result)).toContain('55');
            expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}`);
            expect(mockGetMessageAmend).toHaveBeenCalledWith('Drafts', 42, expect.any(AbortSignal));
            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            expect(payload.subject).toBe('Updated Subject');
            expect(payload).not.toHaveProperty('replacePrevious');
            expect(mockUploadMessageAmend.mock.calls[0]?.[1]).toBe(42);
        });

        test('should keep original subject when not provided', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42' });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            expect(payload.subject).toBe('Original Subject');
        });

        test('should NOT include flags field in amendAndResubmitDraft upload payload', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42' });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            expect(payload.flags).toBeUndefined();
        });

        test('should apply amended body text', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', body: 'New body text' });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            expect(payload.text).toBe('New body text');
        });

        test('should keep original body when not provided', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42' });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            expect(payload.text).toBe('Original body text');
        });

        test('should accept amended to address as plain string', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', to: 'new-to@example.com' });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            expect(payload.to).toEqual([{ address: 'new-to@example.com' }]);
        });

        test('should accept amended to as structured address object', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', to: { name: 'Craig', email_address: 'craig@rungie.com' } });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            expect(payload.to).toEqual([{ name: 'Craig', address: 'craig@rungie.com' }]);
        });

        test('should accept amended to as array of addresses', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', to: ['addr1@example.com', 'addr2@example.com'] });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            expect(payload.to).toEqual([{ address: 'addr1@example.com' }, { address: 'addr2@example.com' }]);
        });

        test('should keep original to addresses when not provided (already address objects from WildDuck)', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42' });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            // original.to is [{ address: 'original-to@example.com' }] from WildDuck — used directly
            expect(payload.to).toEqual([{ address: 'original-to@example.com' }]);
        });

        test('should present the new UID, naming the replaced one, after re-upload — even to an allowlisted recipient', async () => {
            const allowlist = { isAllowed: mock(() => true) } as unknown as PersonAllowlist;
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                allowlist,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', subject: 'Updated' });

            expect(mockSendApprovalRequest.mock.calls).toEqual([[55, 42]]);
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
            expect(getText(result)).toContain('Drafts:99');
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

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('amendAndResubmitDraft', 'unavailable') }], isError: true });
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'amendAndResubmitDraft', detail: 'WildDuck unavailable', msg: 'Email tool failed' }));
        });

        test('should return failure message when sendApprovalRequest fails', async () => {
            mockSendApprovalRequest = mock(async () => {
                throw new Error('Discord unavailable');
            });

            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
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
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', senderProfile: 'formal' });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            expect((payload.from as { address: string }).address).toBe('formal@example.com');
            expect((payload.from as { name: string }).name).toBe('Izzy Formal');
        });

        test('should use informal from address when identity is informal', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42', senderProfile: 'informal' });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            expect((payload.from as { address: string }).address).toBe('informal@example.com');
            expect((payload.from as { name: string }).name).toBe('Izzy Informal');
        });

        test('should upload with draft flag set to true and no explicit flags field', async () => {
            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            await handler({ message: 'Drafts:42' });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
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

            const result: CallToolResult = await handler({ message: 'Drafts:42', senderProfile: 'formal' });

            expect(result.isError).toBe(true);
            expect(getText(result)).toContain('no sender address configured');
        });

        test('should fall back to empty strings when original has no subject or text', async () => {
            mockGetMessageAmend = mock(async () => ({ id: 42, draft: true, to: [{ address: 'original-to@example.com' }], references: [] }));
            mockWildDuckAmend.getMessage = mockGetMessageAmend;

            const server = createEmailMCPServer({
                wildDuckClient: mockWildDuckAmend,
                approvalCards:  cardPort(mockSendApprovalRequest),
            });
            const handler = getToolHandler(server, 'amendAndResubmitDraft');

            const result: CallToolResult = await handler({ message: 'Drafts:42' });

            expect(result.isError).toBeUndefined();
            expect(mockUploadMessageAmend).toHaveBeenCalledWith(
                expect.objectContaining({ subject: '', text: '' }),
                42,
                expect.any(AbortSignal)
            );
        });

        test('uploads no recipients when neither the amend nor the original draft has a To', async () => {
            mockGetMessageAmend.mockImplementation(async () => ({ id: 42, draft: true, subject: 'S', text: 'T', references: [] }));
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards: cardPort(mockSendApprovalRequest) });

            await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

            const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
            expect(payload.to).toEqual([]);
        });

        describe('carrying the original draft forward (#159)', () => {
            const CAP = 25 * 1024 * 1024;
            const REPORT = { id: 'ATT00001', filename: 'report.pdf', contentType: 'application/pdf', sizeKb: 2, size: 2000 };
            const PHOTO = { id: 'ATT00002', filename: 'photo.png', contentType: 'image/png', sizeKb: 1, size: 900, related: true };
            const REFERENCES = ['<parent@example.com>', '<root@example.com>'];
            const REPLY_REFERENCE = { action: 'reply' as const, mailbox: MAILBOX_IDS.CleanInbox, id: 7 };
            const base64 = (text: string): string => Buffer.from(text).toString('base64');
            /** The read-back of Drafts:55 as WildDuck would store the upload (its Cc and attachments as sent, no References). */
            const AS_UPLOADED = Symbol('as uploaded');
            /** A WildDuck attachment stream that yields `chunks`, then ends; `contentLength` when WildDuck declared one. */
            const streamOf = (chunks: unknown[], contentLength?: number): AttachmentStream => ({
                status: 200,
                body:   new ReadableStream<Uint8Array>({
                    start(controller) {
                        for(const chunk of chunks) {
                            controller.enqueue(chunk as Uint8Array);
                        }
                        controller.close();
                    },
                }),
                ...(contentLength === undefined ? {} : { contentLength }),
            });
            /** A stream that yields `chunks` and then stalls until `signal` aborts, as a fetch body does. */
            const stallingStream = (signal: AbortSignal, chunks: unknown[] = []): AttachmentStream => ({
                status: 200,
                body:   new ReadableStream<Uint8Array>({
                    start(controller) {
                        for(const chunk of chunks) {
                            controller.enqueue(chunk as Uint8Array);
                        }
                        signal.addEventListener('abort', () => {
                            controller.error(signal.reason);
                        });
                    },
                }),
            });
            const uploaded = (): WildDuckUploadPayload => (mockUploadMessageAmend.mock.calls[0] as [WildDuckUploadPayload, number])[0];

            let original: Record<string, unknown>;
            /** What reading the amended Drafts:55 back returns ({@link AS_UPLOADED}: what the upload sent). */
            let stored: unknown;
            /** What reading the message a reply reference points at (outside Drafts) returns. */
            let referenced: unknown;
            let mockOpenStream: ReturnType<typeof mock<(mailbox: string, uid: number, id: string, signal: AbortSignal) => Promise<AttachmentStream | null>>>;
            /** The old draft's own In-Reply-To and References, as WildDuck's search lists them; null when it finds none. */
            let mockThreadingHeaders: ReturnType<typeof mock<(mailbox: string, uid: number, signal?: AbortSignal) => Promise<{ inReplyTo: unknown, references: unknown } | null>>>;
            /** The working-directory files an amend's addAttachments read. */
            let localFiles: ReturnType<typeof attachmentFiles>;

            beforeEach(() => {
                original = { ...originalDraft };
                stored = AS_UPLOADED;
                referenced = { id: 7, subject: 'The message replied to' };
                mockThreadingHeaders = mock(async () => null);
                mockWildDuckAmend.getThreadingHeaders = mockThreadingHeaders;
                mockGetMessageAmend.mockImplementation(async (folder: string, uid: number) => {
                    if(folder !== 'Drafts') {
                        return referenced;
                    }
                    if(uid === 42) {
                        return original;
                    }
                    if(stored !== AS_UPLOADED) {
                        return stored;
                    }
                    const sent = uploaded();
                    return { id: 55, draft: true, cc: sent.cc, attachments: (sent.attachments ?? []).map((attachment, index) => ({ id: `ATT${index}`, filename: attachment.filename })), references: [] };
                });
                mockOpenStream = mock(async (_mailbox: string, _uid: number, id: string) => streamOf([Buffer.from(`bytes of ${id}`)]));
                mockWildDuckAmend.openAttachmentStream = mockOpenStream;
                localFiles = attachmentFiles({});
            });

            const amend = async (args: Record<string, unknown> = {}, approvalCards = cardPort(mockSendApprovalRequest)): Promise<CallToolResult> => getToolHandler(
                createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, approvalCards, attachmentRoot: ATTACHMENT_ROOT, readAttachmentFile: localFiles }),
                'amendAndResubmitDraft'
            )({ message: 'Drafts:42', ...args });
            const refused = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });
            const expectNothingChanged = (): void => {
                expect(mockUploadMessageAmend).not.toHaveBeenCalled();
                expect(mockDeleteMessageAmend).not.toHaveBeenCalled();
                expect(mockSendApprovalRequest).not.toHaveBeenCalled();
            };

            describe('Cc', () => {
                test('keeps the draft\'s Cc when the amend gives none', async () => {
                    original = { ...originalDraft, cc: [{ address: 'cc1@example.com' }, { name: 'Bo', address: 'cc2@example.com' }] };

                    const result = await amend();

                    expect(uploaded().cc).toEqual([{ address: 'cc1@example.com' }, { name: 'Bo', address: 'cc2@example.com' }]);
                    expect(getText(result)).toBe(`${PENDING} Cc: 2 addresses (kept from the original draft). Attachments: 0 kept from the original draft, 0 removed, 0 added.`);
                });

                test('names one kept Cc address in the singular', async () => {
                    original = { ...originalDraft, cc: [{ address: 'cc1@example.com' }] };

                    const result = await amend();

                    expect(getText(result)).toBe(`${PENDING} Cc: 1 address (kept from the original draft). Attachments: 0 kept from the original draft, 0 removed, 0 added.`);
                });

                test('uploads an empty Cc for a draft that has none', async () => {
                    const { cc: _cc, ...withoutCc } = originalDraft;
                    original = withoutCc;

                    const result = await amend();

                    expect(uploaded().cc).toEqual([]);
                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}`);
                });

                test('replaces the draft\'s Cc with the addresses given', async () => {
                    original = { ...originalDraft, cc: [{ address: 'cc1@example.com' }] };

                    const result = await amend({ cc: ['new@example.com', { name: 'Al', email_address: 'al@example.com' }] });

                    expect(uploaded().cc).toEqual([{ address: 'new@example.com' }, { name: 'Al', address: 'al@example.com' }]);
                    expect(getText(result)).toBe(`${PENDING} Cc: 2 addresses (as given in this amend). Attachments: 0 kept from the original draft, 0 removed, 0 added.`);
                });

                test('accepts a single Cc address', async () => {
                    const result = await amend({ cc: 'one@example.com' });

                    expect(uploaded().cc).toEqual([{ address: 'one@example.com' }]);
                    expect(getText(result)).toBe(`${PENDING} Cc: 1 address (as given in this amend). Attachments: 0 kept from the original draft, 0 removed, 0 added.`);
                });

                test('an explicit empty Cc removes every Cc address', async () => {
                    original = { ...originalDraft, cc: [{ address: 'cc1@example.com' }, { address: 'cc2@example.com' }] };

                    const result = await amend({ cc: [] });

                    expect(uploaded().cc).toEqual([]);
                    expect(getText(result)).toBe(`${PENDING} Cc: 0 addresses (as given in this amend). Attachments: 0 kept from the original draft, 0 removed, 0 added.`);
                });
            });

            describe('attachments', () => {
                test('carries every attachment, inline ones included, with its bytes fetched from the draft in WildDuck', async () => {
                    original = { ...originalDraft, attachments: [REPORT, PHOTO] };

                    const result = await amend();

                    expect(mockOpenStream.mock.calls.map(call => call.slice(0, 3))).toEqual([['Drafts', 42, 'ATT00001'], ['Drafts', 42, 'ATT00002']]);
                    expect(uploaded().attachments).toEqual([
                        { filename: 'report.pdf', contentType: 'application/pdf', content: base64('bytes of ATT00001') },
                        { filename: 'photo.png', contentType: 'image/png', content: base64('bytes of ATT00002') },
                    ]);
                    expect(getText(result)).toBe(`${PENDING} Cc: 0 addresses (kept from the original draft). Attachments: 2 kept from the original draft, 0 removed, 0 added.`);
                });

                test('joins an attachment\'s chunks', async () => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    mockOpenStream.mockImplementation(async () => streamOf([Buffer.from('first '), Buffer.from('second')]));

                    await amend();

                    expect(uploaded().attachments).toEqual([{ filename: 'report.pdf', contentType: 'application/pdf', content: base64('first second') }]);
                });

                test.each([
                    ['no body and no declared length', undefined],
                    ['no body but a declared length', 5],
                ])('refuses an attachment WildDuck answered with a 200 with %s, uploading nothing', async (_label, contentLength) => {
                    original = { ...originalDraft, attachments: [REPORT, PHOTO] };
                    mockOpenStream.mockImplementation(async (_mailbox: string, _uid: number, id: string) => (
                        id === 'ATT00001' ? streamOf([Buffer.from('ok')]) : { status: 200, body: null, ...(contentLength === undefined ? {} : { contentLength }) }
                    ));

                    const result = await amend();

                    expect(result).toEqual(refused('Could not amend draft Drafts:42: these attachments could not be fetched from WildDuck: "photo.png". Nothing was changed and the draft is as it was; try again, or leave them out with removeAttachments.'));
                    expectNothingChanged();
                    expect(mockLogger.warn.mock.calls).toEqual([[{ uid: 42, attachmentId: 'ATT00002', msg: 'An attachment to carry into the amended draft came back from WildDuck without a body' }]]);
                });

                test.each([
                    ['a 200 declared as zero length with no body', (): AttachmentStream => ({ status: 200, body: null, contentLength: 0 })],
                    ['a 200 with an empty body and no declared length', (): AttachmentStream => streamOf([])],
                    ['a 200 with an empty body declared as zero length', (): AttachmentStream => streamOf([], 0)],
                ])('carries a genuinely empty attachment: %s', async (_label, open) => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    mockOpenStream.mockImplementation(async () => open());

                    const result = await amend();

                    expect(result.isError).toBeUndefined();
                    expect(uploaded().attachments).toEqual([{ filename: 'report.pdf', contentType: 'application/pdf', content: '' }]);
                    expect(mockLogger.warn).not.toHaveBeenCalled();
                });

                test.each([199, 201, 204, 206])('refuses an attachment WildDuck answered with a %i, cancelling its body unread and uploading nothing', async (status) => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    let pulled = false;
                    let cancelled = false;
                    mockOpenStream.mockImplementation(async () => ({
                        status,
                        contentLength: 5,
                        body:          new ReadableStream<Uint8Array>({
                            pull(controller) {
                                pulled = true;
                                controller.enqueue(Buffer.from('12345'));
                            },
                            cancel() {
                                cancelled = true;
                            },
                        }, { highWaterMark: 0 }),
                    }));

                    const result = await amend();

                    expect(result).toEqual(refused('Could not amend draft Drafts:42: these attachments could not be fetched from WildDuck: "report.pdf". Nothing was changed and the draft is as it was; try again, or leave them out with removeAttachments.'));
                    expectNothingChanged();
                    expect(mockLogger.warn.mock.calls).toEqual([[{ uid: 42, attachmentId: 'ATT00001', status, msg: 'Could not fetch an attachment to carry into the amended draft' }]]);
                    expect(pulled).toBe(false);
                    expect(cancelled).toBe(true);
                });

                test('refuses a 204 that has no body at all', async () => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    mockOpenStream.mockImplementation(async () => ({ status: 204, body: null, contentLength: 0 }));

                    const result = await amend();

                    expect(getText(result)).toBe('Could not amend draft Drafts:42: these attachments could not be fetched from WildDuck: "report.pdf". Nothing was changed and the draft is as it was; try again, or leave them out with removeAttachments.');
                    expectNothingChanged();
                    expect(mockLogger.warn.mock.calls).toEqual([[{ uid: 42, attachmentId: 'ATT00001', status: 204, msg: 'Could not fetch an attachment to carry into the amended draft' }]]);
                });

                describe('the body\'s reader', () => {
                    /** A body whose reader is recorded: each read yields the next of `reads` (a chunk, or `{ fail }` to reject with), then the end. */
                    const recordedBody = (reads: (Uint8Array | { fail: unknown })[], cancel: () => Promise<void> = async () => undefined): { stream: AttachmentStream, calls: string[] } => {
                        const calls: string[] = [];
                        const pending = [...reads];
                        const reader = {
                            read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
                                calls.push('read');
                                const next = pending.shift();
                                if(next === undefined) {
                                    return { done: true, value: undefined };
                                }
                                if('fail' in next) {
                                    throw next.fail;
                                }
                                return { done: false, value: next };
                            },
                            cancel: async (): Promise<void> => {
                                calls.push('cancel');
                                await cancel();
                            },
                            releaseLock: (): void => {
                                calls.push('releaseLock');
                            },
                        };
                        // A stand-in exposing only getReader, which is all an amend's read uses of a body.
                        const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
                        return { stream: { status: 200, body }, calls };
                    };
                    const FETCH_FAILED = 'Could not amend draft Drafts:42: these attachments could not be fetched from WildDuck: "report.pdf". Nothing was changed and the draft is as it was; try again, or leave them out with removeAttachments.';

                    test('releases the reader once the body is read to its end, cancelling nothing', async () => {
                        original = { ...originalDraft, attachments: [REPORT] };
                        const { stream, calls } = recordedBody([Buffer.from('ab')]);
                        mockOpenStream.mockImplementation(async () => stream);

                        await amend();

                        expect(uploaded().attachments).toEqual([{ filename: 'report.pdf', contentType: 'application/pdf', content: base64('ab') }]);
                        expect(calls).toEqual(['read', 'read', 'releaseLock']);
                    });

                    test('cancels and releases the reader when a read fails, as an aborted fetch\'s does, and refuses', async () => {
                        original = { ...originalDraft, attachments: [REPORT] };
                        const { stream, calls } = recordedBody([Buffer.from('ab'), { fail: new TypeError('connection reset') }]);
                        mockOpenStream.mockImplementation(async () => stream);

                        const result = await amend();

                        expect(getText(result)).toBe(FETCH_FAILED);
                        expectNothingChanged();
                        expect(calls).toEqual(['read', 'read', 'cancel', 'releaseLock']);
                        expect(mockLogger.warn.mock.calls).toEqual([[{ uid: 42, attachmentId: 'ATT00001', error: 'TypeError', msg: 'Could not fetch an attachment to carry into the amended draft' }]]);
                    });

                    test('cancels and releases the reader once the bytes read overrun the budget', async () => {
                        original = { ...originalDraft, attachments: [REPORT] };
                        const { stream, calls } = recordedBody([{ length: CAP + 1 } as Uint8Array, Buffer.from('never read')]);
                        mockOpenStream.mockImplementation(async () => stream);

                        const result = await amend();

                        expect(result).toEqual(refused('Could not amend draft Drafts:42: the attachments it would keep come to more than the 25.0 MB an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.'));
                        expect(calls).toEqual(['read', 'cancel', 'releaseLock']);
                        expect(mockLogger.warn).not.toHaveBeenCalled();
                    });

                    test('still releases the reader when its cancel fails, logging the failure, and refuses', async () => {
                        original = { ...originalDraft, attachments: [REPORT] };
                        const { stream, calls } = recordedBody([{ fail: new TypeError('connection reset') }], async () => {
                            throw new RangeError('cancel failed');
                        });
                        mockOpenStream.mockImplementation(async () => stream);

                        const result = await amend();

                        expect(getText(result)).toBe(FETCH_FAILED);
                        expectNothingChanged();
                        expect(calls).toEqual(['read', 'cancel', 'releaseLock']);
                        expect(mockLogger.warn.mock.calls).toEqual([[{ uid: 42, attachmentId: 'ATT00001', error: 'RangeError', msg: 'Could not fetch an attachment to carry into the amended draft' }]]);
                    });
                });

                test('carries a body of exactly the length WildDuck declared for it', async () => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    mockOpenStream.mockImplementation(async () => streamOf([Buffer.from('12345')], 5));

                    await amend();

                    expect(uploaded().attachments).toEqual([{ filename: 'report.pdf', contentType: 'application/pdf', content: base64('12345') }]);
                });

                test.each([
                    ['shorter', 6],
                    ['longer', 4],
                ])('fails closed when a body is %s than WildDuck declared, uploading nothing', async (_label, contentLength) => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    mockOpenStream.mockImplementation(async () => streamOf([Buffer.from('12345')], contentLength));

                    const result = await amend();

                    expect(getText(result)).toBe('Could not amend draft Drafts:42: these attachments could not be fetched from WildDuck: "report.pdf". Nothing was changed and the draft is as it was; try again, or leave them out with removeAttachments.');
                    expectNothingChanged();
                    expect(mockLogger.warn.mock.calls).toEqual([[{ uid: 42, attachmentId: 'ATT00001', declared: contentLength, read: 5, msg: 'An attachment to carry into the amended draft was not the length WildDuck declared' }]]);
                });

                test('fetches nothing and uploads no attachments for a draft without any', async () => {
                    await amend();

                    expect(mockOpenStream).not.toHaveBeenCalled();
                    expect(uploaded().attachments).toEqual([]);
                });

                test('removeAttachments "all" drops every attachment, fetching none', async () => {
                    original = { ...originalDraft, attachments: [REPORT, PHOTO] };

                    const result = await amend({ removeAttachments: 'all' });

                    expect(mockOpenStream).not.toHaveBeenCalled();
                    expect(uploaded().attachments).toEqual([]);
                    expect(getText(result)).toBe(`${PENDING} Cc: 0 addresses (kept from the original draft). Attachments: 0 kept from the original draft, 2 removed, 0 added.`);
                });

                test('removeAttachments by filename drops only the attachments named', async () => {
                    original = { ...originalDraft, attachments: [REPORT, PHOTO] };

                    const result = await amend({ removeAttachments: ['photo.png'] });

                    expect(mockOpenStream.mock.calls.map(call => call.slice(0, 3))).toEqual([['Drafts', 42, 'ATT00001']]);
                    expect(uploaded().attachments).toEqual([{ filename: 'report.pdf', contentType: 'application/pdf', content: base64('bytes of ATT00001') }]);
                    expect(getText(result)).toBe(`${PENDING} Cc: 0 addresses (kept from the original draft). Attachments: 1 kept from the original draft, 1 removed, 0 added.`);
                });

                test('removing a filename drops every attachment with that name', async () => {
                    original = { ...originalDraft, attachments: [REPORT, PHOTO, { ...REPORT, id: 'ATT00003' }] };

                    const result = await amend({ removeAttachments: ['report.pdf'] });

                    expect(mockOpenStream.mock.calls.map(call => call.slice(0, 3))).toEqual([['Drafts', 42, 'ATT00002']]);
                    expect(getText(result)).toBe(`${PENDING} Cc: 0 addresses (kept from the original draft). Attachments: 1 kept from the original draft, 2 removed, 0 added.`);
                });

                test('refuses filenames the draft does not have, changing nothing', async () => {
                    original = { ...originalDraft, attachments: [REPORT, PHOTO] };

                    const result = await amend({ removeAttachments: ['photo.png', 'missing.txt', 'gone.doc'] });

                    expect(result).toEqual(refused('Could not amend draft Drafts:42: it has no attachment named "missing.txt", "gone.doc" (its attachments: "report.pdf", "photo.png"). Nothing was changed.'));
                    expect(mockOpenStream).not.toHaveBeenCalled();
                    expectNothingChanged();
                });

                test('says so when the draft has no attachments at all', async () => {
                    const result = await amend({ removeAttachments: ['x.pdf'] });

                    expect(result).toEqual(refused('Could not amend draft Drafts:42: it has no attachment named "x.pdf" (its attachments: none). Nothing was changed.'));
                    expectNothingChanged();
                });

                describe('filenames in the tool text', () => {
                    const refusedNaming = (unknown: string, known: string): CallToolResult => refused(`Could not amend draft Drafts:42: it has no attachment named ${unknown} (its attachments: ${known}). Nothing was changed.`);

                    test('strips control and bidi characters from each name, keeping its neighbours', async () => {
                        // Every range end is here, with the nearest character outside each range kept.
                        const name = 'a\u{0}b\u{7}c\u{7F}d\u{85}e\u{61C}f\u{200E}g\u{200F}h\u{202A}i\u{202E}j\u{2066}k\u{2069}l\u{2029}m\u{202F}n\u{2065}o\u{206A}p';
                        original = { ...originalDraft, attachments: [{ ...REPORT, filename: 'r\u{202E}fdp.exe' }] };

                        const result = await amend({ removeAttachments: [name] });

                        expect(result).toEqual(refusedNaming(JSON.stringify('abcdefghijkl\u{2029}m\u{202F}n\u{2065}o\u{206A}p'), '"rfdp.exe"'));
                    });

                    test('keeps a name of 80 characters whole and cuts a longer one to 80 and an ellipsis', async () => {
                        original = { ...originalDraft, attachments: [{ ...REPORT, filename: `${'k'.repeat(79)}😀` }] };

                        const result = await amend({ removeAttachments: ['x'.repeat(80), `${'y'.repeat(80)}z`] });

                        expect(result).toEqual(refusedNaming(`"${'x'.repeat(80)}", "${'y'.repeat(80)}…"`, `"${'k'.repeat(79)}😀"`));
                    });

                    test('names the first ten and counts the rest', async () => {
                        const names = (prefix: string, count: number): string[] => Array.from({ length: count }, (_value, index) => `${prefix}${index}`);
                        original = { ...originalDraft, attachments: names('k', 10).map((filename, index) => ({ ...REPORT, id: `ATT${index}`, filename, size: 1 })) };

                        const result = await amend({ removeAttachments: names('u', 11) });

                        expect(result).toEqual(refusedNaming(`${names('u', 10).map(name => `"${name}"`).join(', ')} and 1 more`, names('k', 10).map(name => `"${name}"`).join(', ')));
                    });

                    describe('bounding the work', () => {
                        afterEach(() => {
                            jest.restoreAllMocks();
                        });

                        test('formats only the first ten names, counting the rest unformatted', async () => {
                            original = { ...originalDraft, attachments: [REPORT] };
                            const segment = spyOn(Intl.Segmenter.prototype, 'segment');
                            const unknown = Array.from({ length: 1000 }, (_value, index) => `u${index}`);

                            const result = await amend({ removeAttachments: unknown });

                            expect(result).toEqual(refusedNaming(`${unknown.slice(0, 10).map(name => `"${name}"`).join(', ')} and 990 more`, '"report.pdf"'));
                            expect(segment.mock.calls.map(([text]) => text)).toEqual([...unknown.slice(0, 10), 'report.pdf']);
                        });

                        test('segments at most the first 1024 code units of a name', async () => {
                            original = { ...originalDraft, attachments: [REPORT] };
                            const segment = spyOn(Intl.Segmenter.prototype, 'segment');

                            await amend({ removeAttachments: ['n'.repeat(100_000)] });

                            expect(segment.mock.calls.map(([text]) => text.length)).toEqual([1024, 10]);
                        });
                    });

                    test.each([
                        ['keeps a name of exactly 1024 code units whole', `${'\u{0}'.repeat(1020)}abcd`, '"abcd"'],
                        ['cuts a longer name at 1024 code units, before its unsafe characters are stripped, and marks the cut', `${'\u{0}'.repeat(1020)}abcde`, '"abcd…"'],
                    ])('%s', async (_label, name, shown) => {
                        original = { ...originalDraft, attachments: [REPORT] };

                        const result = await amend({ removeAttachments: [name] });

                        expect(result).toEqual(refusedNaming(shown, '"report.pdf"'));
                    });
                });

                describe('attachment ids', () => {
                    test.each([
                        ['in another format', 'att-1'],
                        ['with anything after its digits', 'ATT1/../../users'],
                        ['missing', undefined],
                        ['that is not a string', ['ATT00002']],
                    ])('refuses the whole amend over an id %s, even on an attachment it would remove, fetching nothing', async (_label, id) => {
                        original = { ...originalDraft, attachments: [REPORT, { ...PHOTO, id }] };

                        const result = await amend({ removeAttachments: ['photo.png'] });

                        expect(result).toEqual(refused('Could not amend draft Drafts:42: WildDuck listed its attachments with an id that is missing, malformed or repeated, so they can\'t be carried safely. Nothing was changed; delete the draft and create a new one instead.'));
                        expect(mockOpenStream).not.toHaveBeenCalled();
                        expectNothingChanged();
                    });

                    test('refuses an id listed twice, fetching nothing', async () => {
                        original = { ...originalDraft, attachments: [REPORT, { ...PHOTO, id: REPORT.id }] };

                        const result = await amend();

                        expect(getText(result)).toBe('Could not amend draft Drafts:42: WildDuck listed its attachments with an id that is missing, malformed or repeated, so they can\'t be carried safely. Nothing was changed; delete the draft and create a new one instead.');
                        expect(mockOpenStream).not.toHaveBeenCalled();
                        expectNothingChanged();
                    });
                });

                describe('attachment count', () => {
                    const many = (count: number): WildDuckMessageAttachment[] => Array.from({ length: count }, (_value, index) => ({ id: `ATT${index}`, filename: `f${index}.txt`, contentType: 'text/plain', sizeKb: 1, size: 1 }));

                    test('carries 50 attachments', async () => {
                        original = { ...originalDraft, attachments: many(50) };
                        mockOpenStream.mockImplementation(async () => streamOf([Buffer.from('x')]));

                        const result = await amend();

                        expect(result.isError).toBeUndefined();
                        expect(uploaded().attachments).toHaveLength(50);
                    });

                    test('refuses to keep 51, fetching nothing', async () => {
                        original = { ...originalDraft, attachments: many(51) };

                        const result = await amend();

                        expect(result).toEqual(refused('Could not amend draft Drafts:42: it would keep 51 attachments, more than the 50 an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.'));
                        expect(mockOpenStream).not.toHaveBeenCalled();
                        expectNothingChanged();
                    });

                    test('counts only the attachments it keeps', async () => {
                        original = { ...originalDraft, attachments: many(51) };
                        mockOpenStream.mockImplementation(async () => streamOf([Buffer.from('x')]));

                        const result = await amend({ removeAttachments: ['f0.txt'] });

                        expect(result.isError).toBeUndefined();
                        expect(uploaded().attachments).toHaveLength(50);
                    });
                });

                test('fails closed when a kept attachment cannot be fetched, logging its status but never WildDuck\'s error text', async () => {
                    original = { ...originalDraft, attachments: [REPORT, PHOTO] };
                    mockOpenStream.mockImplementation(async (_mailbox: string, _uid: number, id: string) => {
                        if(id === 'ATT00002') {
                            throw new WildDuckError('WildDuck API error: 500 Error: secret body', undefined, { status: 500 });
                        }
                        return streamOf([Buffer.from('ok')]);
                    });

                    const result = await amend();

                    expect(result).toEqual(refused('Could not amend draft Drafts:42: these attachments could not be fetched from WildDuck: "photo.png". Nothing was changed and the draft is as it was; try again, or leave them out with removeAttachments.'));
                    expectNothingChanged();
                    expect(mockLogger.warn.mock.calls).toEqual([[{ uid: 42, attachmentId: 'ATT00002', status: 500, msg: 'Could not fetch an attachment to carry into the amended draft' }]]);
                });

                test.each([
                    ['WildDuck has no such attachment', async () => null, { status: 404 }],
                    ['the request fails without a status', async () => {
                        throw new WildDuckError('WildDuck API error: 400 Bad Request: secret body');
                    }, { error: 'WildDuckError' }],
                    ['the connection fails', async () => {
                        throw new TypeError('fetch failed');
                    }, { error: 'TypeError' }],
                    ['an error that is not WildDuck\'s, whatever status it carries, is thrown', async () => {
                        throw Object.assign(new RangeError('elsewhere'), { context: { status: 503 } });
                    }, { error: 'RangeError' }],
                    ['something that is not an error is thrown', async () => {
                        throw 'plain text';
                    }, { error: 'string' }],
                ])('names an attachment that could not be fetched because %s, logging only why', async (_label, open, logged) => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    mockOpenStream.mockImplementation(open);

                    const result = await amend();

                    expect(getText(result)).toBe('Could not amend draft Drafts:42: these attachments could not be fetched from WildDuck: "report.pdf". Nothing was changed and the draft is as it was; try again, or leave them out with removeAttachments.');
                    expectNothingChanged();
                    expect(mockLogger.warn.mock.calls).toEqual([[{ uid: 42, attachmentId: 'ATT00001', ...logged, msg: 'Could not fetch an attachment to carry into the amended draft' }]]);
                });

                test('names every attachment that could not be fetched', async () => {
                    original = { ...originalDraft, attachments: [REPORT, PHOTO] };
                    mockOpenStream.mockImplementation(async () => {
                        throw new Error('down');
                    });

                    const result = await amend();

                    expect(getText(result)).toBe('Could not amend draft Drafts:42: these attachments could not be fetched from WildDuck: "report.pdf", "photo.png". Nothing was changed and the draft is as it was; try again, or leave them out with removeAttachments.');
                    expectNothingChanged();
                });

                test('fetches at most two attachments at a time', async () => {
                    original = { ...originalDraft, attachments: [REPORT, PHOTO, { ...REPORT, id: 'ATT00003', filename: 'third.pdf' }] };
                    const gate = Promise.withResolvers<undefined>();
                    let active = 0;
                    let maxActive = 0;
                    mockOpenStream.mockImplementation(async (_mailbox: string, _uid: number, id: string) => {
                        active += 1;
                        maxActive = Math.max(maxActive, active);
                        try {
                            await gate.promise;
                            return streamOf([Buffer.from(id)]);
                        } finally {
                            active -= 1;
                        }
                    });

                    const amending = amend();
                    await drainMicrotasks(50);
                    expect(maxActive).toBe(2);
                    gate.resolve(undefined);
                    await amending;

                    expect(mockOpenStream).toHaveBeenCalledTimes(3);
                    expect(uploaded().attachments).toHaveLength(3);
                });

                describe('size limit', () => {
                    test.each([
                        ['reported sizes at the limit', [{ ...REPORT, size: CAP - 900 }, PHOTO]],
                        ['sizes reported only in KB, at the limit', [{ id: 'ATT00001', filename: 'big.bin', contentType: 'application/octet-stream', sizeKb: CAP / 1024 }]],
                        ['an exact size preferred to its KB rounding', [{ ...REPORT, size: 10, sizeKb: CAP / 1024 }, PHOTO]],
                    ])('carries %s', async (_label, attachments) => {
                        original = { ...originalDraft, attachments };

                        const result = await amend();

                        expect(result.isError).toBeUndefined();
                        expect(uploaded().attachments).toHaveLength(attachments.length);
                    });

                    test.each([
                        ['reported sizes one byte over', [{ ...REPORT, size: CAP - 899 }, PHOTO]],
                        ['sizes reported only in KB, one KB over', [{ id: 'ATT00001', filename: 'big.bin', contentType: 'application/octet-stream', sizeKb: (CAP / 1024) + 1 }]],
                    ])('refuses %s before fetching anything, changing nothing', async (_label, attachments) => {
                        original = { ...originalDraft, attachments };

                        const result = await amend();

                        expect(result).toEqual(refused('Could not amend draft Drafts:42: the attachments it would keep total 25.0 MB, over the 25.0 MB an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.'));
                        expect(mockOpenStream).not.toHaveBeenCalled();
                        expectNothingChanged();
                    });

                    test('counts only the attachments it keeps', async () => {
                        original = { ...originalDraft, attachments: [{ ...REPORT, size: CAP }, PHOTO] };

                        const result = await amend({ removeAttachments: ['photo.png'] });

                        expect(result.isError).toBeUndefined();
                    });

                    test.each([
                        ['a negative size', { size: -1 }],
                        ['a size that is not a number', { size: Number.NaN }],
                        ['an infinite size', { size: Number.POSITIVE_INFINITY }],
                        ['a size given as text', { size: '5' }],
                        ['a negative size, whatever its KB says', { size: -1, sizeKb: 1 }],
                        ['no size at all', { size: undefined, sizeKb: undefined }],
                    ])('refuses a kept attachment with %s before fetching anything', async (_label, fields) => {
                        original = { ...originalDraft, attachments: [{ ...REPORT, ...fields }, PHOTO] };

                        const result = await amend();

                        expect(result).toEqual(refused('Could not amend draft Drafts:42: WildDuck did not report a usable size for "report.pdf". Nothing was changed; leave them out with removeAttachments, or delete the draft and create a new one.'));
                        expect(mockOpenStream).not.toHaveBeenCalled();
                        expectNothingChanged();
                    });

                    test('carries an attachment reported as empty, and ignores the size of one it removes', async () => {
                        original = { ...originalDraft, attachments: [{ ...REPORT, size: 0 }, { ...PHOTO, size: -1 }] };

                        const result = await amend({ removeAttachments: ['photo.png'] });

                        expect(result.isError).toBeUndefined();
                        expect(uploaded().attachments).toHaveLength(1);
                    });

                    describe('the bytes read, whatever sizes were reported', () => {
                        const chunk = (length: number): unknown => ({ length });

                        afterEach(() => {
                            jest.restoreAllMocks();
                        });

                        test('uploads fetched bytes that come to exactly the limit', async () => {
                            original = { ...originalDraft, attachments: [REPORT, PHOTO] };
                            mockOpenStream.mockImplementation(async (_mailbox: string, _uid: number, id: string) => streamOf(id === 'ATT00001' ? [chunk(CAP - 150), chunk(50)] : [chunk(100)]));
                            spyOn(Buffer, 'concat').mockImplementation(((chunks: { length: number }[]) => ({ toString: () => `joined ${chunks.map(({ length }) => length).join('+')}` })) as unknown as typeof Buffer.concat);

                            const result = await amend();

                            expect(result.isError).toBeUndefined();
                            expect(uploaded().attachments).toEqual([
                                { filename: 'report.pdf', contentType: 'application/pdf', content: `joined ${CAP - 150}+50` },
                                { filename: 'photo.png', contentType: 'image/png', content: 'joined 100' },
                            ]);
                        });

                        test('stops reading as soon as the bytes read pass the limit, aborts every other fetch and refuses', async () => {
                            original = { ...originalDraft, attachments: [REPORT, PHOTO, { ...REPORT, id: 'ATT00003', filename: 'third.pdf' }] };
                            let pulls = 0;
                            let cancelled = false;
                            const signals: AbortSignal[] = [];
                            mockOpenStream.mockImplementation(async (_mailbox: string, _uid: number, id: string, signal: AbortSignal) => {
                                signals.push(signal);
                                if(id === 'ATT00001') {
                                    return stallingStream(signal);
                                }
                                return {
                                    status: 200,
                                    body:   new ReadableStream<Uint8Array>({
                                        pull(controller) {
                                            pulls += 1;
                                            controller.enqueue(chunk(pulls === 1 ? CAP : 1) as Uint8Array);
                                        },
                                        cancel() {
                                            cancelled = true;
                                        },
                                    }, { highWaterMark: 0 }),
                                };
                            });

                            const result = await amend();

                            expect(result).toEqual(refused('Could not amend draft Drafts:42: the attachments it would keep come to more than the 25.0 MB an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.'));
                            expect(mockOpenStream.mock.calls.map(call => call[2])).toEqual(['ATT00001', 'ATT00002']);
                            expect(signals.map(signal => signal.aborted)).toEqual([true, true]);
                            expect(pulls).toBe(2);
                            expect(cancelled).toBe(true);
                            expectNothingChanged();
                        });

                        test('waits for an overrun body\'s cancel, so one that fails is caught and logged, and still refuses', async () => {
                            original = { ...originalDraft, attachments: [REPORT] };
                            mockOpenStream.mockImplementation(async () => ({
                                status: 200,
                                body:   new ReadableStream<Uint8Array>({
                                    pull(controller) {
                                        controller.enqueue(chunk(CAP + 1) as Uint8Array);
                                    },
                                    cancel() {
                                        throw new TypeError('cancel failed');
                                    },
                                }, { highWaterMark: 0 }),
                            }));

                            const result = await amend();

                            expect(result).toEqual(refused('Could not amend draft Drafts:42: the attachments it would keep come to more than the 25.0 MB an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.'));
                            expect(mockLogger.warn.mock.calls).toEqual([[{ uid: 42, attachmentId: 'ATT00001', error: 'TypeError', msg: 'Could not fetch an attachment to carry into the amended draft' }]]);
                            expectNothingChanged();
                        });
                    });
                });

                describe('fetch deadline', () => {
                    beforeEach(() => {
                        jest.useFakeTimers();
                    });

                    afterEach(() => {
                        jest.useRealTimers();
                    });

                    test('gives up on attachments not fetched within 60 s, uploading nothing', async () => {
                        original = { ...originalDraft, attachments: [REPORT, PHOTO] };
                        mockOpenStream.mockImplementation(async (_mailbox: string, _uid: number, id: string, signal: AbortSignal) => (id === 'ATT00001'
                            ? new Promise((_resolve, reject) => {
                                signal.addEventListener('abort', () => {
                                    reject(signal.reason as Error);
                                });
                            })
                            : stallingStream(signal, [Buffer.from('partial')])));
                        let settled = false;

                        const amending = amend().finally(() => {
                            settled = true;
                        });
                        await drainMicrotasks(50);
                        jest.advanceTimersByTime(59_999);
                        await drainMicrotasks(50);
                        expect(settled).toBe(false);
                        jest.advanceTimersByTime(1);
                        const result = await amending;

                        expect(getText(result)).toBe('Could not amend draft Drafts:42: these attachments could not be fetched from WildDuck: "report.pdf", "photo.png". Nothing was changed and the draft is as it was; try again, or leave them out with removeAttachments.');
                        expectNothingChanged();
                    });

                    test('passes one deadline to every fetch and stands it down once they finish', async () => {
                        original = { ...originalDraft, attachments: [REPORT, PHOTO] };
                        const { controller, clear, spy: deadline } = controlDeadline(60_000);
                        try {
                            await amend();

                            expect(deadline.mock.calls.map(([ms]) => ms)).toContain(60_000);
                            expect(clear).toHaveBeenCalledTimes(1);
                            const signals = mockOpenStream.mock.calls.map(call => call[3]);
                            expect(signals.map(signal => signal.aborted)).toEqual([false, false]);
                            controller.abort();
                            expect(signals.map(signal => signal.aborted)).toEqual([true, true]);
                        } finally {
                            deadline.mockRestore();
                        }
                    });
                });
            });

            describe('adding files (addAttachments)', () => {
                test('uploads the added files from the working directory after the kept attachments, and counts them', async () => {
                    original = { ...originalDraft, attachments: [REPORT, PHOTO] };
                    localFiles = attachmentFiles({ 'docs/new.pdf': 'new pdf', 'notes.txt': 'notes' });

                    const result = await amend({ removeAttachments: ['photo.png'], addAttachments: ['docs/new.pdf', '/work/izzy/notes.txt'] });

                    expect(uploaded().attachments).toEqual([
                        { filename: 'report.pdf', contentType: 'application/pdf', content: base64('bytes of ATT00001') },
                        { filename: 'new.pdf', contentType: 'application/pdf', content: base64('new pdf') },
                        { filename: 'notes.txt', contentType: 'text/plain', content: base64('notes') },
                    ]);
                    expect(getText(result)).toBe(`${PENDING} Cc: 0 addresses (kept from the original draft). Attachments: 1 kept from the original draft, 1 removed, 2 added.`);
                });

                test('caps the added files at what the kept attachments left of the 25 MiB budget', async () => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    localFiles = attachmentFiles({ 'new.txt': 'new' });

                    await amend({ addAttachments: ['new.txt'] });

                    expect(localFiles.mock.calls).toEqual([[ATTACHMENT_ROOT, 'new.txt', CAP - Buffer.byteLength('bytes of ATT00001')]]);
                });

                test('refuses added files that do not fit in what the kept attachments left, changing nothing', async () => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    localFiles = attachmentFiles(() => 'x'.repeat(30));
                    const keptBytes = Buffer.byteLength('bytes of ATT00001');
                    localFiles.mockImplementation(async (_root, relPath, maxBytes) => {
                        expect(maxBytes).toBe(CAP - keptBytes);
                        throw new PathSecurityError(`File is larger than the ${maxBytes}-byte limit: ${relPath}`, relPath, 'too_large');
                    });

                    const result = await amend({ addAttachments: ['big.bin'] });

                    expect(result).toEqual(refused('Could not amend draft Drafts:42: the attachments come to more than the 25.0 MB one email can carry. Nothing was changed.'));
                    expectNothingChanged();
                });

                test.each([
                    ['outside the working directory', '/Users/craig/.ssh/id_ed25519', 'the attachment "/Users/craig/.ssh/id_ed25519" is outside your working directory'],
                    ['a dotfile', '.env', 'the attachment ".env" is a hidden file or in a hidden folder (a name starting with ".")'],
                    ['an unusable name', String.raw`a\b.txt`, String.raw`the attachment "a\\b.txt" has a file name that can't be sent (it contains a backslash)`],
                ])('refuses an added path %s before fetching or reading anything, changing nothing', async (_label, given, problem) => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    localFiles = attachmentFiles(() => 'x');

                    const result = await amend({ addAttachments: [given] });

                    expect(result).toEqual(refused(`Could not amend draft Drafts:42: ${problem}. Nothing was changed.`));
                    expect(mockOpenStream).not.toHaveBeenCalled();
                    expect(localFiles).not.toHaveBeenCalled();
                    expectNothingChanged();
                });

                test('refuses an added file the contained reader refuses, changing nothing', async () => {
                    const result = await amend({ addAttachments: ['missing.pdf'] });

                    expect(result).toEqual(refused('Could not amend draft Drafts:42: the attachment "missing.pdf" was not found. Nothing was changed.'));
                    expectNothingChanged();
                });

                test.each([
                    ['the name of a kept attachment', ['docs/report.pdf']],
                    ['the name of another added file', ['a/new.txt', 'b/new.txt']],
                ])('refuses an added file with %s, fetching and reading nothing', async (_label, addAttachments) => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    localFiles = attachmentFiles(() => 'x');

                    const result = await amend({ addAttachments });

                    const name = addAttachments.at(-1)!.split('/').at(-1)!;
                    expect(result).toEqual(refused(`Could not amend draft Drafts:42: the added attachment ${JSON.stringify(name)} has the same name as another attachment of the draft. Nothing was changed.`));
                    expect(mockOpenStream).not.toHaveBeenCalled();
                    expect(localFiles).not.toHaveBeenCalled();
                    expectNothingChanged();
                });

                test('adds a file with the name of an attachment it removes', async () => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    localFiles = attachmentFiles({ 'report.pdf': 'v2' });

                    const result = await amend({ removeAttachments: ['report.pdf'], addAttachments: ['report.pdf'] });

                    expect(uploaded().attachments).toEqual([{ filename: 'report.pdf', contentType: 'application/pdf', content: base64('v2') }]);
                    expect(getText(result)).toBe(`${PENDING} Cc: 0 addresses (kept from the original draft). Attachments: 0 kept from the original draft, 1 removed, 1 added.`);
                });

                const many = (count: number, prefix: string): WildDuckMessageAttachment[] => Array.from({ length: count }, (_value, index) => ({ id: `ATT${index}`, filename: `${prefix}${index}.txt`, contentType: 'text/plain', sizeKb: 1, size: 1 }));

                test('carries 50 attachments, kept and added together', async () => {
                    original = { ...originalDraft, attachments: many(48, 'k') };
                    mockOpenStream.mockImplementation(async () => streamOf([Buffer.from('x')]));
                    localFiles = attachmentFiles(() => 'y');

                    const result = await amend({ addAttachments: ['a1.txt', 'a2.txt'] });

                    expect(result.isError).toBeUndefined();
                    expect(uploaded().attachments).toHaveLength(50);
                });

                test('refuses 51 attachments, kept and added together, fetching and reading nothing', async () => {
                    original = { ...originalDraft, attachments: many(49, 'k') };
                    localFiles = attachmentFiles(() => 'y');

                    const result = await amend({ addAttachments: ['a1.txt', 'a2.txt'] });

                    expect(result).toEqual(refused('Could not amend draft Drafts:42: that would be 51 attachments, more than the 50 one email can carry. Nothing was changed.'));
                    expect(mockOpenStream).not.toHaveBeenCalled();
                    expect(localFiles).not.toHaveBeenCalled();
                    expectNothingChanged();
                });

                test('checks the stored attachment count against the kept and added ones together', async () => {
                    original = { ...originalDraft, attachments: [REPORT] };
                    localFiles = attachmentFiles({ 'new.txt': 'n' });
                    stored = { id: 55, draft: true, cc: [], attachments: [{}], references: [] };

                    const result = await amend({ addAttachments: ['new.txt'] });

                    expect(getText(result)).toBe(`${PENDING} Warning: the amended draft stores 0 Cc addresses and 1 attachment, but 0 and 2 were intended; check it before it is approved.`);
                });

                test('says what it added when the stored draft could not be read back', async () => {
                    localFiles = attachmentFiles({ 'new.txt': 'n' });
                    stored = null;

                    const result = await amend({ addAttachments: ['new.txt'] });

                    expect(getText(result)).toBe(`${PENDING} Cc and attachments were sent to WildDuck (0 Cc, 0 attachments kept, 0 removed, 1 added) but could not be confirmed on the stored draft.`);
                });

                test('accepts an array of paths only', async () => {
                    const schema = (createEmailMCPServer({ wildDuckClient: mockWildDuck }).instance as unknown as RegisteredToolInstance)._registeredTools.amendAndResubmitDraft.inputSchema;
                    const results = await Promise.all([{ addAttachments: ['a.txt'] }, { addAttachments: [] }, { addAttachments: 'a.txt' }, { addAttachments: [1] }]
                        .map(args => schema.safeParseAsync({ message: 'Drafts:42', ...args })));
                    expect(results.map(result => result.success)).toEqual([true, true, false, false]);
                });
            });

            describe('what the stored new version carries', () => {
                const CARRIED = ' Cc: 1 address (kept from the original draft). Attachments: 2 kept from the original draft, 0 removed, 0 added.';

                beforeEach(() => {
                    original = { ...originalDraft, cc: [{ address: 'cc@example.com' }], attachments: [REPORT, PHOTO] };
                });

                test('reads the new version back once, under its own deadline, and states what it stores', async () => {
                    const result = await amend();

                    expect(mockGetMessageAmend.mock.calls).toEqual([['Drafts', 42, expect.any(AbortSignal)], ['Drafts', 55, expect.any(AbortSignal)]]);
                    expect(getText(result)).toBe(`${PENDING}${CARRIED}`);
                });

                test.each([
                    ['fewer Cc addresses than intended', { cc: [] }, ' Warning: the amended draft stores 0 Cc addresses and 2 attachments, but 1 and 2 were intended; check it before it is approved.'],
                    ['more Cc addresses than intended', { cc: [{ address: 'a@example.com' }, { address: 'b@example.com' }] }, ' Warning: the amended draft stores 2 Cc addresses and 2 attachments, but 1 and 2 were intended; check it before it is approved.'],
                    ['fewer attachments than intended', { attachments: [{ id: 'ATT1' }] }, ' Warning: the amended draft stores 1 Cc address and 1 attachment, but 1 and 2 were intended; check it before it is approved.'],
                    ['more attachments than intended', { attachments: [{}, {}, {}] }, ' Warning: the amended draft stores 1 Cc address and 3 attachments, but 1 and 2 were intended; check it before it is approved.'],
                    ['no Cc or attachment list at all', { cc: undefined, attachments: undefined }, ' Warning: the amended draft stores 0 Cc addresses and 0 attachments, but 1 and 2 were intended; check it before it is approved.'],
                ])('warns, naming both counts, when the stored draft has %s', async (_label, fields, warning) => {
                    stored = { id: 55, draft: true, cc: [{ address: 'cc@example.com' }], attachments: [{}, {}], references: [], ...fields };

                    const result = await amend();

                    expect(getText(result)).toBe(`${PENDING}${warning}`);
                });

                const UNCONFIRMED = ' Cc and attachments were sent to WildDuck (1 Cc, 2 attachments kept, 0 removed, 0 added) but could not be confirmed on the stored draft.';

                test.each([
                    ['is not found', null],
                    ['is not an object', 'draft'],
                    ['lists its Cc as something other than a list', { id: 55, cc: 'cc@example.com', attachments: [{}, {}], references: [] }],
                    ['lists its attachments as something other than a list', { id: 55, cc: [{}], attachments: 2, references: [] }],
                ])('says the carry could not be confirmed when the stored draft %s', async (_label, readBack) => {
                    stored = readBack;

                    const result = await amend();

                    expect(getText(result)).toBe(`${PENDING}${UNCONFIRMED}`);
                    expect(mockLogger.warn).toHaveBeenCalledWith({ newUid: 55, msg: 'The amended draft read back from WildDuck was missing or unreadable' });
                });

                test('says the carry could not be confirmed when the read-back fails, logging only why', async () => {
                    original = { ...originalDraft, cc: [{ address: 'cc@example.com' }], attachments: [REPORT], references: [] };
                    mockGetMessageAmend.mockImplementation(async (_folder: string, uid: number) => {
                        if(uid === 55) {
                            throw new WildDuckError('WildDuck API error: 502 Bad Gateway: secret body', undefined, { status: 502 });
                        }
                        return original;
                    });

                    const result = await amend({ removeAttachments: [] });

                    expect(getText(result)).toBe(`${PENDING} Cc and attachments were sent to WildDuck (1 Cc, 1 attachment kept, 0 removed, 0 added) but could not be confirmed on the stored draft.`);
                    expect(mockLogger.warn.mock.calls).toEqual([[{ newUid: 55, status: 502, msg: 'Could not read back the amended draft' }]]);
                });

                describe('read-back deadline', () => {
                    beforeEach(() => {
                        jest.useFakeTimers();
                    });

                    afterEach(() => {
                        jest.useRealTimers();
                    });

                    test('gives up on a read-back that takes 10 s, still reporting the new draft', async () => {
                        original = { ...originalDraft, references: REFERENCES, reference: REPLY_REFERENCE };
                        mockGetMessageAmend.mockImplementation(async (folder: string, uid: number, signal?: AbortSignal) => (folder !== 'Drafts' || uid === 42
                            ? original
                            : new Promise((_resolve, reject) => {
                                signal?.addEventListener('abort', () => {
                                    reject(signal.reason as Error);
                                });
                            })));
                        let settled = false;

                        const amending = amend().finally(() => {
                            settled = true;
                        });
                        await drainMicrotasks(50);
                        jest.advanceTimersByTime(9999);
                        await drainMicrotasks(50);
                        expect(settled).toBe(false);
                        jest.advanceTimersByTime(1);
                        const result = await amending;

                        expect(result.isError).toBeUndefined();
                        expect(getText(result)).toBe(`${PENDING} Cc and attachments were sent to WildDuck (0 Cc, 0 attachments kept, 0 removed, 0 added) but could not be confirmed on the stored draft.${THREAD_UNVERIFIED}`);
                        expect(mockLogger.warn).toHaveBeenCalledWith({ newUid: 55, error: 'TimeoutError', msg: 'Could not read back the amended draft' });
                    });

                    test('stands the read-back deadline down once the read-back is done', async () => {
                        await amend();

                        expect(jest.getTimerCount()).toBe(0);
                    });
                });
            });

            describe('reply threading', () => {
                test('re-passes a reply draft\'s stored reference once the message it points at is found, and confirms the threading from the stored new draft', async () => {
                    original = { ...originalDraft, references: REFERENCES, reference: { ...REPLY_REFERENCE, extra: 'dropped' } };
                    stored = { id: 55, references: [...REFERENCES] };

                    const result = await amend();

                    expect(uploaded().reference).toEqual(REPLY_REFERENCE);
                    expect(uploaded()).not.toHaveProperty('headers');
                    // The referenced message is looked up by the folder its WildDuck mailbox id belongs to, under the amend's budget.
                    expect(mockGetMessageAmend.mock.calls).toEqual([['Drafts', 42, expect.any(AbortSignal)], ['CleanInbox', 7, expect.any(AbortSignal)], ['Drafts', 55, expect.any(AbortSignal)]]);
                    expect(mockThreadingHeaders).not.toHaveBeenCalled();
                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_KEPT}`);
                });

                test('looks a reference into Archive up in Archive', async () => {
                    original = { ...originalDraft, references: REFERENCES, reference: { ...REPLY_REFERENCE, mailbox: MAILBOX_IDS.Archive, id: 9 } };

                    await amend();

                    expect(mockGetMessageAmend.mock.calls[1]).toEqual(['Archive', 9, expect.any(AbortSignal)]);
                });

                describe('when the message replied to cannot be used (#200)', () => {
                    const PARENT = '<parent@example.com>';
                    const OWN_HEADERS = { inReplyTo: PARENT, references: REFERENCES };
                    const AS_HEADERS = [{ key: 'In-Reply-To' as const, value: PARENT }, { key: 'References' as const, value: REFERENCES.join(' ') }];

                    beforeEach(() => {
                        mockThreadingHeaders.mockImplementation(async () => OWN_HEADERS);
                        stored = { id: 55, references: REFERENCES };
                    });

                    test('threads the new version from the old draft\'s own In-Reply-To and References once the referenced message has moved, passing no reference', async () => {
                        original = { ...originalDraft, references: REFERENCES, reference: REPLY_REFERENCE };
                        referenced = null;

                        const result = await amend();

                        expect(uploaded().headers).toEqual(AS_HEADERS);
                        expect(uploaded()).not.toHaveProperty('reference');
                        expect(mockThreadingHeaders.mock.calls).toEqual([['Drafts', 42, expect.any(AbortSignal)]]);
                        expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_KEPT_VIA_HEADERS}`);
                    });

                    test.each([
                        ['a reference into a mailbox replyToEmail cannot reply from', { reference: { ...REPLY_REFERENCE, mailbox: MAILBOX_IDS.Quarantine } }, {}],
                        ['a reference that does not parse', { reference: { ...REPLY_REFERENCE, action: 'forward' } }, {}],
                        ['no reference, only References', { reference: undefined }, {}],
                        ['an amend that empties the subject', { reference: REPLY_REFERENCE }, { subject: '' }],
                    ])('threads from the old draft\'s own headers for %s, without looking the reference up', async (_label, fields, args) => {
                        original = { ...originalDraft, references: REFERENCES, ...fields };

                        const result = await amend(args);

                        expect(uploaded().headers).toEqual(AS_HEADERS);
                        expect(uploaded()).not.toHaveProperty('reference');
                        expect(mockGetMessageAmend.mock.calls.map(([folder]) => folder)).toEqual(['Drafts', 'Drafts']);
                        expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_KEPT_VIA_HEADERS}`);
                    });

                    test('keeps an empty subject empty: without a reference WildDuck derives none', async () => {
                        original = { ...originalDraft, references: REFERENCES, reference: REPLY_REFERENCE };

                        await amend({ subject: '' });

                        expect(uploaded().subject).toBe('');
                        expect(uploaded().headers).toEqual(AS_HEADERS);
                    });

                    test('accepts every character of the Message-ID grammar: each special in the local part, letters, digits, dots and hyphens in the domain, and a one-character domain', async () => {
                        const special = '!#$%&\'*+/=?^`{|}~-_';
                        const ids = [
                            `<x${special}.y${special}.z@Ex4mple-b.0rg>`,
                            '<a@a.B>',
                            '<b@0Z9>',
                            '<c@b>',
                        ];
                        original = { ...originalDraft, references: ids, reference: undefined };
                        mockThreadingHeaders.mockImplementation(async () => ({ inReplyTo: ids[0], references: ids }));
                        stored = { id: 55, references: ids };

                        await amend();

                        expect(uploaded().headers).toEqual([{ key: 'In-Reply-To', value: ids[0] }, { key: 'References', value: ids.join(' ') }]);
                    });

                    test.each([
                        ['a space inside it', '<par ent@example.com>'],
                        ['an angle bracket inside it', '<par<ent@example.com>'],
                        ['two at signs', '<parent@ex@ample.com>'],
                        ['a domain starting with a hyphen', '<parent@-example.com>'],
                        ['a domain ending with a hyphen', '<parent@example->'],
                        ['a local part starting with a dot', '<.parent@example.com>'],
                        ['a local part ending with a dot', '<parent.@example.com>'],
                        ['a control character', '<par\u0000ent@example.com>'],
                    ])('passes no threading headers for an In-Reply-To with %s', async (_label, inReplyTo) => {
                        original = { ...originalDraft, references: REFERENCES, reference: undefined };
                        mockThreadingHeaders.mockImplementation(async () => ({ inReplyTo, references: REFERENCES }));

                        await amend();

                        expect(uploaded()).not.toHaveProperty('headers');
                    });

                    test('accepts a 320-character Message-ID and 50 References', async () => {
                        const long = `<${'a'.repeat(306)}@example.com>`;
                        const fifty = [...Array.from({ length: 49 }, (_value, index) => `<r${index}@example.com>`), long];
                        expect(long).toHaveLength(320);
                        original = { ...originalDraft, references: fifty, reference: undefined };
                        mockThreadingHeaders.mockImplementation(async () => ({ inReplyTo: long, references: fifty }));
                        stored = { id: 55, references: fifty };

                        await amend();

                        expect(uploaded().headers).toEqual([{ key: 'In-Reply-To', value: long }, { key: 'References', value: fifty.join(' ') }]);
                    });

                    test.each([
                        ['no In-Reply-To', { inReplyTo: undefined }],
                        ['an In-Reply-To that is not text', { inReplyTo: 5 }],
                        ['two In-Reply-To headers', { inReplyTo: [PARENT, PARENT] }],
                        ['an In-Reply-To without angle brackets', { inReplyTo: 'parent@example.com' }],
                        ['an In-Reply-To with a second id', { inReplyTo: `${PARENT} <other@example.com>` }],
                        ['an In-Reply-To with surrounding space', { inReplyTo: ` ${PARENT}` }],
                        ['an In-Reply-To with a line break and another header', { inReplyTo: `${PARENT}\r\nBcc: spy@example.com` }],
                        ['an In-Reply-To with a comment', { inReplyTo: `${PARENT} (comment)` }],
                        ['an In-Reply-To with no domain', { inReplyTo: '<parent@>' }],
                        ['an In-Reply-To with no local part', { inReplyTo: '<@example.com>' }],
                        ['an In-Reply-To with two dots in its domain', { inReplyTo: '<parent@example..com>' }],
                        ['an In-Reply-To with two dots in its local part', { inReplyTo: '<par..ent@example.com>' }],
                        ['an In-Reply-To with a domain ending in a dot', { inReplyTo: '<parent@example.>' }],
                        ['a 321-character In-Reply-To', { inReplyTo: `<${'a'.repeat(307)}@example.com>` }],
                        ['References that are not a list', { references: REFERENCES.join(' ') }],
                        ['no References', { references: [] }],
                        ['51 References', { references: Array.from({ length: 51 }, (_value, index) => `<r${index}@example.com>`) }],
                        ['a malformed Reference', { references: [PARENT, 'root@example.com'] }],
                        ['a Reference with a line break', { references: [PARENT, '<root@example.com>\r\nX-Evil: 1'] }],
                        ['a Reference that is not text', { references: [PARENT, 7] }],
                        ['a repeated Reference', { references: [PARENT, PARENT] }],
                    ])('passes no threading headers when the old draft has %s, and warns that the threading is lost', async (_label, fields) => {
                        original = { ...originalDraft, references: REFERENCES, reference: REPLY_REFERENCE };
                        referenced = null;
                        mockThreadingHeaders.mockImplementation(async () => ({ ...OWN_HEADERS, ...fields }));

                        const result = await amend();

                        expect(uploaded()).not.toHaveProperty('headers');
                        expect(uploaded()).not.toHaveProperty('reference');
                        expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_LOST}`);
                    });

                    test('warns that the threading is lost when WildDuck finds no such old draft to read its headers from', async () => {
                        original = { ...originalDraft, references: REFERENCES, reference: REPLY_REFERENCE };
                        referenced = null;
                        mockThreadingHeaders.mockImplementation(async () => null);

                        const result = await amend();

                        expect(uploaded()).not.toHaveProperty('headers');
                        expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_LOST}`);
                    });

                    test('judges the threading from the stored new draft: different References are lost, unreadable ones unconfirmed', async () => {
                        original = { ...originalDraft, references: REFERENCES, reference: undefined };
                        stored = { id: 55, references: ['<other@example.com>'] };
                        expect(getText(await amend())).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_LOST}`);

                        stored = { id: 55 };
                        expect(getText(await amend())).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_UNVERIFIED}`);
                    });

                    test.each([
                        ['the referenced message', 'referenced'],
                        ['the old draft\'s headers', 'headers'],
                    ])('changes nothing when reading %s fails before the upload', async (_label, which) => {
                        original = { ...originalDraft, references: REFERENCES, reference: REPLY_REFERENCE };
                        referenced = null;
                        const failure = new WildDuckError('WildDuck API error: 503: secret body', undefined, { status: 503 });
                        if(which === 'referenced') {
                            mockGetMessageAmend.mockImplementation(async (folder: string) => {
                                if(folder !== 'Drafts') {
                                    throw failure;
                                }
                                return original;
                            });
                        } else {
                            mockThreadingHeaders.mockImplementation(async () => {
                                throw failure;
                            });
                        }

                        const result = await amend();

                        expect(result).toEqual({ content: [{ type: 'text', text: failureText('amendAndResubmitDraft', 'unavailable') }], isError: true });
                        expectNothingChanged();
                    });
                });

                test('re-passes a reply-all reference to a message in Archive', async () => {
                    const reference = { ...REPLY_REFERENCE, action: 'replyAll' as const, mailbox: MAILBOX_IDS.Archive };
                    original = { ...originalDraft, references: REFERENCES, reference };
                    stored = { id: 55, references: REFERENCES };

                    const result = await amend();

                    expect(uploaded().reference).toEqual(reference);
                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_KEPT}`);
                });

                test('re-passes a reference whose id is the largest safe integer', async () => {
                    original = { ...originalDraft, references: REFERENCES, reference: { ...REPLY_REFERENCE, id: Number.MAX_SAFE_INTEGER } };

                    await amend();

                    expect(uploaded().reference).toEqual({ ...REPLY_REFERENCE, id: Number.MAX_SAFE_INTEGER });
                });

                test.each([
                    ['a forward reference', { ...REPLY_REFERENCE, action: 'forward' }],
                    ['a reference whose mailbox is not a string', { ...REPLY_REFERENCE, mailbox: 5 }],
                    ['a reference whose id is not a number', { ...REPLY_REFERENCE, id: '7' }],
                    ['a reference whose id is zero', { ...REPLY_REFERENCE, id: 0 }],
                    ['a reference whose id is negative', { ...REPLY_REFERENCE, id: -7 }],
                    ['a reference whose id is not whole', { ...REPLY_REFERENCE, id: 7.5 }],
                    ['a reference whose id is past the safe integers', { ...REPLY_REFERENCE, id: 2 ** 53 }],
                    ['a reference to a mailbox replyToEmail cannot reply from', { ...REPLY_REFERENCE, mailbox: MAILBOX_IDS.Quarantine }],
                    ['a reference to a mailbox WildDuck does not have', { ...REPLY_REFERENCE, mailbox: 'f'.repeat(24) }],
                    ['no reference', undefined],
                ])('passes no reference for %s, and warns that the reply threading is lost', async (_label, reference) => {
                    original = { ...originalDraft, references: REFERENCES, reference };

                    const result = await amend();

                    expect(uploaded().reference).toBeUndefined();
                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_LOST}`);
                });

                test.each([
                    ['an amend that empties the subject', { ...originalDraft }, { subject: '' }],
                    ['a draft with no subject kept as it is', { ...originalDraft, subject: undefined }, {}],
                ])('passes no reference for %s, so WildDuck cannot put the replied-to subject back, and warns', async (_label, draft, args) => {
                    original = { ...draft, references: REFERENCES, reference: REPLY_REFERENCE };

                    const result = await amend(args);

                    expect(uploaded().reference).toBeUndefined();
                    expect(uploaded().subject).toBe('');
                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_LOST}`);
                });

                test('warns of the lost threading of a reply with no References of its own when it passes no reference', async () => {
                    original = { ...originalDraft, references: [], reference: { ...REPLY_REFERENCE, mailbox: MAILBOX_IDS.Quarantine } };

                    const result = await amend();

                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_LOST}`);
                });

                test.each([
                    ['carries different References', { id: 55, references: ['<other@example.com>'] }],
                    ['has the same Message-IDs in another order', { id: 55, references: REFERENCES.toReversed() }],
                    ['has no References', { id: 55, references: [] }],
                ])('warns that the threading is lost when the stored new draft %s', async (_label, readBack) => {
                    original = { ...originalDraft, references: REFERENCES, reference: REPLY_REFERENCE };
                    stored = readBack;

                    const result = await amend();

                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_LOST}`);
                });

                test('warns that the threading is lost when the original had no References and the stored new draft has none either', async () => {
                    original = { ...originalDraft, references: [], reference: REPLY_REFERENCE };
                    stored = { id: 55, references: [] };

                    const result = await amend();

                    expect(uploaded().reference).toEqual(REPLY_REFERENCE);
                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_LOST}`);
                });

                test.each([
                    ['one Reference', ['<new@example.com>']],
                    ['several References', ['<parent@example.com>', '<new@example.com>']],
                ])('says the threading could not be confirmed when the original had no References to match and the stored new draft has %s', async (_label, references) => {
                    original = { ...originalDraft, references: [], reference: REPLY_REFERENCE };
                    stored = { id: 55, references };

                    const result = await amend();

                    expect(uploaded().reference).toEqual(REPLY_REFERENCE);
                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_UNVERIFIED}`);
                });

                test.each([
                    ['lists no References field', { id: 55 }],
                    ['lists References that are not all text', { id: 55, references: ['<parent@example.com>', 5] }],
                ])('says the threading could not be confirmed when the stored new draft %s', async (_label, readBack) => {
                    original = { ...originalDraft, references: REFERENCES, reference: REPLY_REFERENCE };
                    stored = readBack;

                    const result = await amend();

                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_UNVERIFIED}`);
                });

                test('says neither the carry nor the threading could be confirmed when the stored new draft is not found', async () => {
                    original = { ...originalDraft, references: REFERENCES, reference: REPLY_REFERENCE };
                    stored = null;

                    const result = await amend();

                    expect(getText(result)).toBe(`${PENDING} Cc and attachments were sent to WildDuck (0 Cc, 0 attachments kept, 0 removed, 0 added) but could not be confirmed on the stored draft.${THREAD_UNVERIFIED}`);
                });

                test('says the threading could not be confirmed, and logs why, when the new draft cannot be read back', async () => {
                    original = { ...originalDraft, references: REFERENCES, reference: REPLY_REFERENCE };
                    mockGetMessageAmend.mockImplementation(async (_folder: string, uid: number) => {
                        if(uid === 55) {
                            throw new Error('read-back failed');
                        }
                        return original;
                    });

                    const result = await amend();

                    expect(getText(result)).toBe(`${PENDING} Cc and attachments were sent to WildDuck (0 Cc, 0 attachments kept, 0 removed, 0 added) but could not be confirmed on the stored draft.${THREAD_UNVERIFIED}`);
                    expect(mockLogger.warn).toHaveBeenCalledWith({ newUid: 55, error: 'Error', msg: 'Could not read back the amended draft' });
                });

                test('warns that the threading is lost, read-back or not, when no reference could be passed', async () => {
                    original = { ...originalDraft, references: REFERENCES };
                    stored = null;

                    const result = await amend();

                    expect(getText(result)).toBe(`${PENDING} Cc and attachments were sent to WildDuck (0 Cc, 0 attachments kept, 0 removed, 0 added) but could not be confirmed on the stored draft.${THREAD_LOST}`);
                });

                test('counts a single Reference as a reply, and warns that the threading is lost when no reference could be passed', async () => {
                    original = { ...originalDraft, references: ['<parent@example.com>'] };
                    stored = { id: 55, references: [] };

                    const result = await amend();

                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_LOST}`);
                });

                test.each([
                    ['missing', undefined],
                    ['not a list', '<parent@example.com>'],
                    ['a list with something other than text in it', ['<parent@example.com>', null]],
                ].flatMap(([label, references]) => [
                    [label, 'with', references, REPLY_REFERENCE],
                    [label, 'without', references, undefined],
                ]))('says the threading could not be confirmed when the original\'s References are %s, %s a reply reference', async (_label, _with, references, reference) => {
                    original = { ...originalDraft, references, reference };
                    stored = { id: 55, references: REFERENCES };

                    const result = await amend();

                    expect(uploaded().reference).toEqual(reference);
                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}${THREAD_UNVERIFIED}`);
                });

                test.each([
                    ['no reply reference', undefined],
                    ['a reference that is not a reply', { ...REPLY_REFERENCE, action: 'forward' }],
                ])('says nothing about threading for a draft that was not a reply (%s)', async (_label, reference) => {
                    original = { ...originalDraft, references: [], reference };
                    stored = { id: 55, references: ['<anything@example.com>'] };

                    const result = await amend();

                    expect(uploaded().reference).toBeUndefined();
                    expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}`);
                });
            });

            test.each([
                ['posted', PENDING, undefined],
                ['queued', PENDING, undefined],
                ['updated', 'Draft saved as Drafts:55; the admin\'s approval card was updated in place (edit 1).', undefined],
                ['failed', 'Draft saved as Drafts:55 but failed to notify admin. Please check pending drafts manually.', undefined],
                ['missing', 'Draft Drafts:55 not found after upload.', true],
            ])('keeps what was carried and every warning when the card is %s', async (presentation, lead, isError) => {
                original = { ...originalDraft, cc: [{ address: 'cc@example.com' }], attachments: [REPORT], references: REFERENCES };
                mockUploadMessageAmend.mockImplementation(async () => ({ id: 55, previousDeleted: false }));
                mockDeleteMessageAmend.mockImplementation(async () => {
                    throw new Error('network down');
                });

                const result = await amend({}, cardPort(mock(async () => presentation), { markSuperseded: mock(async () => false) }));

                expect(result.isError).toBe(isError);
                expect(getText(result)).toBe(`${lead} Cc: 1 address (kept from the original draft). Attachments: 1 kept from the original draft, 0 removed, 0 added.${THREAD_LOST}${OLD_UID_LEFT}`);
            });

            test('schema takes Cc in the To shapes plus an empty array, and removeAttachments as "all" or filenames', async () => {
                const schema = (createEmailMCPServer({ wildDuckClient: mockWildDuck }).instance as unknown as RegisteredToolInstance)._registeredTools.amendAndResubmitDraft.inputSchema;
                const valid = await Promise.all([
                    { cc: [] }, { cc: 'a@example.com' }, { cc: { name: 'A', email_address: 'a@example.com' } }, { cc: ['a@example.com', 'b@example.com'] },
                    { removeAttachments: 'all' }, { removeAttachments: ['a.pdf', 'b.pdf'] }, { removeAttachments: [] },
                ].map(args => schema.safeParseAsync({ message: 'Drafts:42', ...args })));
                const invalid = await Promise.all([
                    { cc: 'not-an-address' }, { removeAttachments: 'some' }, { removeAttachments: [1] },
                ].map(args => schema.safeParseAsync({ message: 'Drafts:42', ...args })));

                expect(valid.map(result => result.success)).toEqual([true, true, true, true, true, true, true]);
                expect(invalid.map(result => result.success)).toEqual([false, false, false]);
            });

            test('the tool description says what an amend carries and adds, and how it keeps a reply threaded', () => {
                const registered = (createEmailMCPServer({ wildDuckClient: mockWildDuck }).instance as unknown as RegisteredToolInstance)._registeredTools.amendAndResubmitDraft;

                expect(registered.description).toBe('Amend a pending or rejected draft and resubmit it for admin approval. Reads the existing draft, applies your changes, and re-uploads it as a new draft UID, replacing the old one. The new version keeps the draft\'s Cc addresses and attachments unless you override them (cc, removeAttachments), and adds the files you name in addAttachments; kept and added together it carries at most 50 attachments, 25.0 MB in all. The result says how many Cc addresses and attachments the stored new version has, and warns if they differ from what was intended or could not be confirmed. Omitting body keeps the draft\'s text and its HTML version; a new markdown body replaces both, and a new plain-text body removes the HTML version; the result says which, and warns if the stored HTML version is not what was uploaded. An amended reply stays in its conversation: it is threaded from the message it replies to while that is still in the inbox or archive and the subject is not empty, and otherwise from the original draft\'s own In-Reply-To and References headers; the result says whether that was confirmed. A pending draft\'s approval card is updated in place; a rejected draft gets a new card. A draft the admin has approved cannot be amended.');
                expect(registered.description).not.toContain('cannot attach');
            });

            test('says which files the email tools attach, and what an added file may not be called', () => {
                const tools = (createEmailMCPServer({ wildDuckClient: mockWildDuck }).instance as unknown as RegisteredToolInstance)._registeredTools;
                const fieldText = (toolName: string, field: string): string | undefined => (tools[toolName].inputSchema.shape[field] as { description?: string }).description;
                const rules = 'paths relative to your working directory, or absolute paths inside it. Only a regular file inside it can be attached: a path that leaves it or passes through a symbolic link, a hidden file or one in a hidden folder (any name starting with "."), and a file name with a control character, "=?", a backslash, or leading or trailing whitespace are refused.';

                expect(fieldText('sendEmail', 'attachments')).toBe(`Files to attach: ${rules} At most 50 files, 25.0 MB in all; a file that is refused means nothing is saved or sent.`);
                expect(fieldText('replyToEmail', 'attachments')).toBe(`Files to attach: ${rules} At most 50 files, 25.0 MB in all; a file that is refused means nothing is saved or sent.`);
                expect(fieldText('amendAndResubmitDraft', 'addAttachments')).toBe(`Files to attach to the new version, read as sendEmail reads its attachments: ${rules} An added file whose name is the same as a kept attachment's or another added file's refuses the amend and changes nothing.`);
            });

            test('says that subject, body and To are kept only when omitted', () => {
                const shape = (createEmailMCPServer({ wildDuckClient: mockWildDuck }).instance as unknown as RegisteredToolInstance)._registeredTools.amendAndResubmitDraft.inputSchema.shape;

                expect(['subject', 'body', 'to'].map(field => (shape[field] as { description?: string }).description)).toEqual([
                    'New subject line (omit to keep the original)',
                    'New body: plain text, or markdown with bodyFormat "markdown". Omit to keep the original body, its HTML version included.',
                    'New To address(es) (omit to keep the original)',
                ]);
            });
        });

        describe('under the draft lock', () => {
            let events: string[];
            let draftLocks: { acquire: ReturnType<typeof mock> };
            let present: ReturnType<typeof mock>;

            beforeEach(() => {
                events = [];
                draftLocks = {
                    acquire: mock(async (key: string) => {
                        events.push(`acquire ${key}`);
                        return () => {
                            events.push(`release ${key}`);
                        };
                    }),
                };
                mockGetMessageAmend.mockImplementation(async () => {
                    events.push('read');
                    return originalDraft;
                });
                mockUploadMessageAmend.mockImplementation(async () => {
                    events.push('upload');
                    return { id: 55, previousDeleted: true };
                });
                mockDeleteMessageAmend.mockImplementation(async () => {
                    events.push('delete');
                });
                present = mock(async () => {
                    events.push('present');
                    return 'posted';
                });
            });

            test('reads the files it adds while holding the key, after the fresh read and before the upload', async () => {
                const read = attachmentFiles({ 'new.txt': 'new' });
                read.mockImplementationOnce(async () => {
                    events.push('read file');
                    return { bytes: Buffer.from('new'), size: 3 };
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, draftLocks, approvalCards: cardPort(present), attachmentRoot: ATTACHMENT_ROOT, readAttachmentFile: read });

                await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42', addAttachments: ['new.txt'] });

                expect(events).toEqual(['acquire email-draft:42', 'read', 'read file', 'upload', 'read', 'release email-draft:42', 'present']);
            });

            test('reads, uploads and releases email-draft:<uid> before presenting the new draft', async () => {
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, draftLocks, approvalCards: cardPort(present) });

                const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

                expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}`);
                expect(events).toEqual(['acquire email-draft:42', 'read', 'upload', 'read', 'release email-draft:42', 'present']);
            });

            test('fetches the kept attachments and reads the new draft back while holding the key', async () => {
                mockGetMessageAmend.mockImplementation(async (_folder: string, uid: number) => {
                    events.push(`read ${uid}`);
                    return uid === 42
                        ? { ...originalDraft, attachments: [{ id: 'ATT00001', filename: 'a.pdf', contentType: 'application/pdf', sizeKb: 1 }], references: ['<p@example.com>'], reference: { action: 'reply', mailbox: MAILBOX_IDS.CleanInbox, id: 3 } }
                        : { id: 55, attachments: [{ id: 'ATT1' }], references: ['<p@example.com>'] };
                });
                mockWildDuckAmend.openAttachmentStream = mock(async (_mailbox: string, _uid: number, id: string) => {
                    events.push(`attachment ${id}`);
                    return { status: 200, body: new Blob(['x']).stream() };
                });
                mockUploadMessageAmend.mockImplementation(async () => {
                    events.push('upload');
                    return { id: 55, previousDeleted: false };
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, draftLocks, approvalCards: cardPort(present) });

                const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

                // The replied-to message (uid 3) is looked up while the key is held, before the upload.
                expect(events).toEqual(['acquire email-draft:42', 'read 42', 'attachment ATT00001', 'read 3', 'upload', 'delete', 'read 55', 'release email-draft:42', 'present']);
                expect(getText(result)).toBe(`${PENDING} Cc: 0 addresses (kept from the original draft). Attachments: 1 kept from the original draft, 0 removed, 0 added.${THREAD_KEPT}`);
            });

            test('releases the key when an attachment cannot be fetched, uploading and presenting nothing', async () => {
                mockGetMessageAmend.mockImplementation(async () => {
                    events.push('read');
                    return { ...originalDraft, attachments: [{ id: 'ATT00001', filename: 'a.pdf', contentType: 'application/pdf', sizeKb: 1 }] };
                });
                mockWildDuckAmend.openAttachmentStream = mock(async (_mailbox: string, _uid: number, id: string) => {
                    events.push(`attachment ${id}`);
                    throw new Error('down');
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, draftLocks, approvalCards: cardPort(present) });

                const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

                expect(result.isError).toBe(true);
                expect(events).toEqual(['acquire email-draft:42', 'read', 'attachment ATT00001', 'release email-draft:42']);
            });

            test('deletes a left-behind old draft before releasing the key', async () => {
                mockUploadMessageAmend.mockImplementation(async () => {
                    events.push('upload');
                    return { id: 55, previousDeleted: false };
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, draftLocks, approvalCards: cardPort(present) });

                await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

                expect(events).toEqual(['acquire email-draft:42', 'read', 'upload', 'delete', 'read', 'release email-draft:42', 'present']);
            });

            test('marks an undeletable old draft superseded before releasing the key', async () => {
                mockUploadMessageAmend.mockImplementation(async () => {
                    events.push('upload');
                    return { id: 55, previousDeleted: false };
                });
                mockDeleteMessageAmend.mockImplementation(async () => {
                    events.push('delete');
                    throw new Error('network down');
                });
                const markSuperseded = mock(async () => {
                    events.push('superseded');
                    return true;
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, draftLocks, approvalCards: cardPort(present, { markSuperseded }) });

                const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

                expect(getText(result)).toBe(`${PENDING}${NOTHING_CARRIED}`);
                expect(events).toEqual(['acquire email-draft:42', 'read', 'upload', 'delete', 'superseded', 'read', 'release email-draft:42', 'present']);
            });

            test.each([
                ['an approved draft', { ...originalDraft, metaData: { approval: { actionId: 'a', at: 'b' } } }, 'Draft Drafts:42 has an admin approval recorded; it can\'t be amended.'],
                ['a replaced draft', { ...originalDraft, metaData: { supersededBy: 60 } }, 'Draft Drafts:42 was already replaced by Drafts:60.'],
                ['a missing draft', null, 'Draft Drafts:42 not found.'],
                ['a message that is not a draft', { ...originalDraft, draft: false }, 'Drafts:42 is not a draft; it can\'t be amended.'],
                ['an attachment id WildDuck could not have issued', { ...originalDraft, attachments: [{ id: '../x', filename: 'a.pdf', contentType: 'application/pdf', sizeKb: 1 }] }, 'Could not amend draft Drafts:42: WildDuck listed its attachments with an id that is missing, malformed or repeated, so they can\'t be carried safely. Nothing was changed; delete the draft and create a new one instead.'],
                ['more attachments than an amend carries', { ...originalDraft, attachments: Array.from({ length: 51 }, (_value, index) => ({ id: `ATT${index}`, filename: `f${index}`, contentType: 'text/plain', sizeKb: 1 })) }, 'Could not amend draft Drafts:42: it would keep 51 attachments, more than the 50 an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.'],
                ['an attachment without a usable size', { ...originalDraft, attachments: [{ id: 'ATT1', filename: 'a.pdf', contentType: 'application/pdf', sizeKb: Number.NaN }] }, 'Could not amend draft Drafts:42: WildDuck did not report a usable size for "a.pdf". Nothing was changed; leave them out with removeAttachments, or delete the draft and create a new one.'],
            ])('releases the key after refusing %s, uploading nothing', async (_label, draft, text) => {
                mockGetMessageAmend.mockImplementation(async () => {
                    events.push('read');
                    return draft;
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, draftLocks, approvalCards: cardPort(present) });

                const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

                expect(result).toEqual({ content: [{ type: 'text', text }], isError: true });
                expect(events).toEqual(['acquire email-draft:42', 'read', 'release email-draft:42']);
            });

            test.each([
                ['the read', 'read', ['acquire email-draft:42', 'read', 'release email-draft:42']],
                ['the upload', 'upload', ['acquire email-draft:42', 'read', 'upload', 'release email-draft:42']],
                ['marking the old draft superseded', 'superseded', ['acquire email-draft:42', 'read', 'upload', 'delete', 'superseded', 'release email-draft:42']],
            ])('releases the key when %s throws, presenting nothing', async (_label, failing, expected) => {
                const fail = (step: string): void => {
                    events.push(step);
                    if(step === failing) {
                        throw new Error(`${step} failed`);
                    }
                };
                mockGetMessageAmend.mockImplementation(async () => {
                    fail('read');
                    return originalDraft;
                });
                mockUploadMessageAmend.mockImplementation(async () => {
                    fail('upload');
                    return { id: 55, previousDeleted: false };
                });
                mockDeleteMessageAmend.mockImplementation(async () => {
                    events.push('delete');
                    throw new Error('network down');
                });
                const markSuperseded = mock(async () => {
                    fail('superseded');
                    return true;
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, draftLocks, approvalCards: cardPort(present, { markSuperseded }) });

                const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

                expect(result).toEqual({ content: [{ type: 'text', text: failureText('amendAndResubmitDraft', 'unavailable') }], isError: true });
                expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'amendAndResubmitDraft', detail: `${failing} failed`, msg: 'Email tool failed' }));
                expect(present).not.toHaveBeenCalled();
                expect(events).toEqual(expected);
            });

            test('releases the key after refusing attachments whose bytes pass the limit, uploading nothing', async () => {
                mockGetMessageAmend.mockImplementation(async () => {
                    events.push('read');
                    return { ...originalDraft, attachments: [{ id: 'ATT1', filename: 'a.pdf', contentType: 'application/pdf', sizeKb: 1 }] };
                });
                mockWildDuckAmend.openAttachmentStream = mock(async (_mailbox: string, _uid: number, id: string) => {
                    events.push(`attachment ${id}`);
                    const body = new ReadableStream({ start: (controller) => {
                        controller.enqueue({ length: (25 * 1024 * 1024) + 1 });
                        controller.close();
                    } });
                    return { status: 200, contentLength: (25 * 1024 * 1024) + 1, body };
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, draftLocks, approvalCards: cardPort(present) });

                const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

                expect(getText(result)).toBe('Could not amend draft Drafts:42: the attachments it would keep come to more than the 25.0 MB an amend can carry. Nothing was changed; leave some out with removeAttachments, or delete the draft and create a new one.');
                expect(events).toEqual(['acquire email-draft:42', 'read', 'attachment ATT1', 'release email-draft:42']);
                expect(mockLogger.warn).not.toHaveBeenCalled();
            });

            test('releases the key after a failed read-back, still presenting the new draft', async () => {
                mockGetMessageAmend.mockImplementation(async (_folder: string, uid: number) => {
                    events.push(`read ${uid}`);
                    if(uid === 55) {
                        throw new Error('read-back failed');
                    }
                    return originalDraft;
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, draftLocks, approvalCards: cardPort(present) });

                const result = await getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

                expect(result.isError).toBeUndefined();
                expect(getText(result)).toBe(`${PENDING} Cc and attachments were sent to WildDuck (0 Cc, 0 attachments kept, 0 removed, 0 added) but could not be confirmed on the stored draft.`);
                expect(events).toEqual(['acquire email-draft:42', 'read 42', 'upload', 'read 55', 'release email-draft:42', 'present']);
            });

            test('builds the upload from the read taken inside the lock, not from the draft as it was before', async () => {
                let stored: Record<string, unknown> = { ...originalDraft, metaData: { approvalCard: LINK } };
                mockGetMessageAmend.mockImplementation(async () => stored);
                const held = Promise.withResolvers<undefined>();
                draftLocks.acquire.mockImplementation(async () => {
                    await held.promise;
                    return () => { /* intentionally empty */ };
                });
                const server = createEmailMCPServer({ wildDuckClient: mockWildDuckAmend, draftLocks, approvalCards: cardPort(present) });

                const amending = getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42' });
                await drainMicrotasks(50);
                expect(draftLocks.acquire.mock.calls).toEqual([['email-draft:42']]);
                expect(mockGetMessageAmend).not.toHaveBeenCalled();
                stored = { id: 42, draft: true, subject: 'Fresh Subject', text: 'Fresh body', to: [{ address: 'fresh@example.com' }], references: [], metaData: { approvalCard: { ...LINK, edits: 4 } } };
                held.resolve(undefined);
                const result = await amending;

                const [payload] = mockUploadMessageAmend.mock.calls[0] as [Record<string, unknown>, number];
                expect(payload).toMatchObject({ subject: 'Fresh Subject', text: 'Fresh body', to: [{ address: 'fresh@example.com' }], metaData: { approvalCard: { ...LINK, edits: 5 } } });
                expect(mockGetMessageAmend.mock.calls).toEqual([['Drafts', 42, expect.any(AbortSignal)], ['Drafts', 55, expect.any(AbortSignal)]]);
                expect(present.mock.calls).toEqual([[55, 42]]);
                expect(result.isError).toBeUndefined();
            });
        });

        describe('against a concurrent admin approval on the shared gate (#161)', () => {
            const CARD_REF = { channelId: 'admin-ch', messageId: 'card-1' };
            const notFoundError = (): WildDuckError => new WildDuckError('WildDuck API error: 404 Not Found', undefined, { status: 404 });

            let events: string[];
            let drafts: Map<number, WildDuckMessage>;
            let rows: Map<string, ApprovedOutboundAction>;
            let gate: ApprovalCardEditGate;
            let approvals: EmailOutboundApprovals;
            let raceClient: WildDuckClient;
            let previousDeleted: boolean;
            let uploadHold: Promise<unknown>;
            let markerHold: Promise<unknown>;
            let deleteFailure: Error | undefined;
            let metadataFailure: Error | undefined;

            const serverWithGate = (): ReturnType<typeof createEmailMCPServer> => createEmailMCPServer({
                wildDuckClient: raceClient,
                draftLocks:     gate,
                markSuperseded: async (oldUid: number, newUid: number) => approvals.markSupersededLocked(oldUid, newUid),
            });

            beforeEach(() => {
                jest.useFakeTimers();
                events = [];
                drafts = new Map([[42, {
                    id:         42,
                    draft:      true,
                    messageId:  '<draft-42@example.com>',
                    date:       '2026-11-17T09:00:00.000Z',
                    subject:    'Original Subject',
                    to:         [{ address: 'original-to@example.com' }],
                    text:       'Original body text',
                    references: [],
                    metaData:   { approvalCard: LINK },
                }]]);
                rows = new Map();
                gate = new ApprovalCardEditGate();
                previousDeleted = true;
                uploadHold = Promise.resolve();
                markerHold = Promise.resolve();
                deleteFailure = undefined;
                metadataFailure = undefined;
                raceClient = {
                    getUserAddresses: mockGetUserAddresses,
                    getMessage:       mock(async (_folder: string, uid: number) => {
                        events.push(`read ${uid}`);
                        const draft = drafts.get(uid);
                        return draft === undefined ? null : { ...draft };
                    }),
                    updateMessageMetadata: mock(async (_folder: string, uid: number, metaData: Record<string, unknown>) => {
                        events.push(`metadata ${uid}`);
                        await markerHold;
                        if(metadataFailure) {
                            throw metadataFailure;
                        }
                        const draft = drafts.get(uid);
                        if(draft === undefined) {
                            throw notFoundError();
                        }
                        drafts.set(uid, { ...draft, metaData });
                    }),
                    uploadReplacingDraft: mock(async (payload: WildDuckUploadPayload, previousUid: number) => {
                        events.push('upload');
                        await uploadHold;
                        drafts.set(55, { id: 55, draft: true, subject: payload.subject, to: payload.to, text: payload.text, metaData: payload.metaData });
                        if(previousDeleted) {
                            drafts.delete(previousUid);
                        }
                        return { id: 55, previousDeleted };
                    }),
                    deleteMessage: mock(async (_folder: string, uid: number) => {
                        events.push(`delete ${uid}`);
                        if(deleteFailure) {
                            throw deleteFailure;
                        }
                        if(!drafts.delete(uid)) {
                            throw notFoundError();
                        }
                    }),
                } as unknown as WildDuckClient;
                approvals = new EmailOutboundApprovals({
                    wildDuckClient: raceClient,
                    actionWriter:   {
                        create: async (action: ApprovedOutboundAction) => {
                            events.push('row');
                            rows.set(action.id, action);
                        },
                    },
                    actionReader: { get: async (id: string) => rows.get(id) },
                    draftLocks:   gate,
                    notify:       () => true,
                });
            });

            afterEach(() => {
                jest.useRealTimers();
            });

            test('an approval arriving while the amend uploads waits for it, then finds the old draft gone', async () => {
                const upload = Promise.withResolvers<undefined>();
                uploadHold = upload.promise;

                const amending = getToolHandler(serverWithGate(), 'amendAndResubmitDraft')({ message: 'Drafts:42', body: 'New body' });
                await drainMicrotasks(50);
                expect(events).toEqual(['read 42', 'upload']);
                const approving = approvals.approveSend(42, 'direct', CARD_REF);
                await drainMicrotasks(50);
                expect(events).toEqual(['read 42', 'upload']);
                upload.resolve(undefined);
                const [amended, approved] = await Promise.all([amending, approving]);

                expect(approved).toEqual({ status: 'refused', reason: 'gone', detail: 'The draft is no longer in Drafts' });
                expect(rows.size).toBe(0);
                expect(getText(amended)).toBe(`${PENDING}${NOTHING_CARRIED}`);
                expect(events).toEqual(['read 42', 'upload', 'read 55', 'read 42']);
            });

            test('an approval waits while the amend deletes the old draft WildDuck left behind', async () => {
                previousDeleted = false;
                const upload = Promise.withResolvers<undefined>();
                uploadHold = upload.promise;

                const amending = getToolHandler(serverWithGate(), 'amendAndResubmitDraft')({ message: 'Drafts:42' });
                await drainMicrotasks(50);
                const approving = approvals.approveSend(42, 'direct', CARD_REF);
                await drainMicrotasks(50);
                upload.resolve(undefined);
                const [amended, approved] = await Promise.all([amending, approving]);

                expect(approved).toEqual({ status: 'refused', reason: 'gone', detail: 'The draft is no longer in Drafts' });
                expect(rows.size).toBe(0);
                expect(getText(amended)).toBe(`${PENDING}${NOTHING_CARRIED}`);
                expect(events).toEqual(['read 42', 'upload', 'delete 42', 'read 55', 'read 42']);
            });

            test('an approval waits while the amend marks an undeletable old draft superseded, under the held key and without deadlock', async () => {
                previousDeleted = false;
                deleteFailure = new Error('network down');
                const upload = Promise.withResolvers<undefined>();
                uploadHold = upload.promise;

                const amending = getToolHandler(serverWithGate(), 'amendAndResubmitDraft')({ message: 'Drafts:42' });
                await drainMicrotasks(50);
                const approving = approvals.approveSend(42, 'direct', CARD_REF);
                await drainMicrotasks(50);
                upload.resolve(undefined);
                const [amended, approved] = await Promise.all([amending, approving]);

                expect(approved).toEqual({ status: 'refused', reason: 'gone', detail: 'The draft was replaced by Drafts:55' });
                expect(rows.size).toBe(0);
                expect(drafts.get(42)?.metaData).toEqual({ approvalCard: LINK, supersededBy: 55 });
                expect(getText(amended)).toBe(`${PENDING}${NOTHING_CARRIED}`);
                expect(events).toEqual(['read 42', 'upload', 'delete 42', 'read 42', 'metadata 42', 'read 55', 'read 42']);
            });

            test('an approval that took the key first is seen by the amend, which uploads and deletes nothing', async () => {
                const marker = Promise.withResolvers<undefined>();
                markerHold = marker.promise;

                const approving = approvals.approveSend(42, 'direct', CARD_REF);
                await drainMicrotasks(50);
                expect(events).toEqual(['read 42', 'metadata 42']);
                const amending = getToolHandler(serverWithGate(), 'amendAndResubmitDraft')({ message: 'Drafts:42', body: 'New body' });
                await drainMicrotasks(50);
                expect(events).toEqual(['read 42', 'metadata 42']);
                marker.resolve(undefined);
                const [approved, amended] = await Promise.all([approving, amending]);

                expect(approved).toEqual({ status: 'recorded' });
                expect(amended).toEqual({ content: [{ type: 'text', text: 'Draft Drafts:42 has an admin approval recorded; it can\'t be amended.' }], isError: true });
                expect(events).toEqual(['read 42', 'metadata 42', 'row', 'read 42']);
                expect(drafts.has(42)).toBe(true);
                expect(drafts.has(55)).toBe(false);
            });

            test('when the old draft can be neither deleted nor marked superseded, warns and releases the key', async () => {
                previousDeleted = false;
                deleteFailure = new Error('network down');
                metadataFailure = new Error('wildduck down');

                const amended = await getToolHandler(serverWithGate(), 'amendAndResubmitDraft')({ message: 'Drafts:42' });

                expect(getText(amended)).toBe(`${PENDING}${NOTHING_CARRIED}${OLD_UID_LEFT}`);
                expect(gate.pendingEdit('email-draft:42')).toBeUndefined();
            });
        });
    });

    describe('getEmailThread tool', () => {
        const THREAD = '0123456789abcdef01234567';

        /** WildDuck's mailbox ids, by the folder names Isambard uses. */
        const MAILBOX_IDS: Record<string, string> = { CleanInbox: 'mbx-clean', Archive: 'mbx-archive', Drafts: 'mbx-drafts', 'Sent Mail': 'mbx-sent', Quarantine: 'mbx-quarantine', Trash: 'mbx-trash' };

        /** A thread row in WildDuck's mailbox `mailboxId`, as WildDuckClient.searchPage maps it. */
        const threadRow = (uid: number, mailboxId: string, overrides: Partial<WildDuckSearchRow> = {}): WildDuckSearchRow => ({
            message: `Path:${uid}`, uid, mailboxId, intro: `Intro ${uid}`, from: { address: `sender${uid}@example.com` }, to: [{ address: 'me@example.com' }], subject: `Subject ${uid}`, date: `2025-01-0${uid % 10}T10:00:00.000Z`, ...overrides,
        });

        interface ThreadClient {
            getMessage:         ReturnType<typeof mock<(folder: string, uid: number) => Promise<WildDuckMessage | null>>>
            searchPage:         ReturnType<typeof mock<(request: WildDuckSearchPageRequest) => Promise<WildDuckSearchPage>>>
            getMailboxId:       ReturnType<typeof mock<(folder: string) => string | undefined>>
            updateMessageFlags: ReturnType<typeof mock<() => Promise<void>>>
        }

        /** A client whose message GET carries `fields` (by default the thread id) and whose thread search answers `page`. */
        const threadClient = (page: WildDuckSearchPage, fields?: Record<string, unknown>): ThreadClient => ({
            getMessage:         mock(async (_folder: string, uid: number) => ({ id: uid, ...(fields ?? { thread: THREAD }) })),
            searchPage:         mock(async () => page),
            getMailboxId:       mock((folder: string) => MAILBOX_IDS[folder]),
            updateMessageFlags: mock(async () => undefined),
        });

        const threadHandler = (client: ThreadClient, extra: Partial<Parameters<typeof createEmailMCPServer>[0]> = {}): ((args: unknown) => Promise<CallToolResult>) => getToolHandler(createEmailMCPServer({ wildDuckClient: client as unknown as WildDuckClient, ...extra }), 'getEmailThread');

        test('is described, read-only, with a documented message reference', () => {
            const registered = (createEmailMCPServer({ wildDuckClient: mockWildDuck }).instance as unknown as RegisteredToolInstance)._registeredTools.getEmailThread;
            expect(registered.description).toBe('List the messages in an email\'s conversation, oldest first: each one\'s Mailbox:UID reference, From, To, Date, Subject and a short snippet; read one in full with getEmailContent. Lists only messages in CleanInbox, Archive, Drafts and Sent Mail (saying how many others were left out), at most 50, and marks nothing as read.');
            expect((registered.inputSchema.shape.message as { description?: string }).description).toBe('The email reference in Mailbox:UID format (e.g., CleanInbox:42)');
            expect(registered.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        });

        test('lists the thread\'s messages oldest first, by the mailbox names getEmailContent takes, marking nothing as read', async () => {
            const client = threadClient({ results: [
                threadRow(1, 'mbx-clean'),
                threadRow(2, 'mbx-sent', { from: { name: 'Me', address: 'me@example.com' }, to: [{ address: 'a@example.com' }, { name: 'B', address: 'b@example.com' }] }),
                threadRow(3, 'mbx-archive', { to: [], intro: '' }),
                threadRow(4, 'mbx-drafts'),
            ] });

            const result = await threadHandler(client)({ message: 'CleanInbox:1' });

            expect(client.getMessage).toHaveBeenCalledWith('CleanInbox', 1);
            expect(client.searchPage).toHaveBeenCalledWith({ thread: THREAD, order: 'asc', limit: 50 });
            expect(client.updateMessageFlags).not.toHaveBeenCalled();
            expect(result.isError).toBeUndefined();
            expect(getText(result)).toBe([
                'Thread of CleanInbox:1, oldest first (4 messages):',
                '- CleanInbox:1 | From: sender1@example.com | To: me@example.com | Date: 2025-01-01T10:00:00.000Z | Subject: Subject 1 | Snippet: Intro 1',
                '- Sent Mail:2 | From: Me <me@example.com> | To: a@example.com, B <b@example.com> | Date: 2025-01-02T10:00:00.000Z | Subject: Subject 2 | Snippet: Intro 2',
                '- Archive:3 | From: sender3@example.com | To: (none) | Date: 2025-01-03T10:00:00.000Z | Subject: Subject 3 | Snippet: ',
                '- Drafts:4 | From: sender4@example.com | To: me@example.com | Date: 2025-01-04T10:00:00.000Z | Subject: Subject 4 | Snippet: Intro 4',
            ].join('\n'));
        });

        test('leaves out messages in mailboxes Izzy cannot read, saying only how many', async () => {
            const client = threadClient({ results: [threadRow(1, 'mbx-quarantine', { subject: 'secret' }), threadRow(2, 'mbx-clean'), threadRow(3, 'mbx-trash'), threadRow(4, 'mbx-unknown')] });

            const text = getText(await threadHandler(client)({ message: 'CleanInbox:2' }));

            expect(text.split('\n')).toEqual([
                'Thread of CleanInbox:2, oldest first (1 message):',
                '- CleanInbox:2 | From: sender2@example.com | To: me@example.com | Date: 2025-01-02T10:00:00.000Z | Subject: Subject 2 | Snippet: Intro 2',
                '3 messages in mailboxes you cannot read were left out.',
            ]);
            expect(text).not.toContain('secret');
        });

        test('says so in the singular when one message was left out', async () => {
            const client = threadClient({ results: [threadRow(1, 'mbx-quarantine'), threadRow(2, 'mbx-clean')] });

            const text = getText(await threadHandler(client)({ message: 'CleanInbox:2' }));

            expect(text.split('\n').at(-1)).toBe('1 message in a mailbox you cannot read was left out.');
        });

        test('says when the thread has more messages than it looked at', async () => {
            const client = threadClient({ results: [threadRow(1, 'mbx-clean')], nextCursor: 'more' });

            const text = getText(await threadHandler(client)({ message: 'CleanInbox:1' }));

            expect(text.split('\n').at(-1)).toBe('This thread has more than 50 messages; only its oldest 50 were looked at.');
        });

        test('shows a short, single-line, safe snippet', async () => {
            const client = threadClient({ results: [threadRow(1, 'mbx-clean', { intro: `  Line one\n\tline‮two ${'x'.repeat(100)}` })] });

            const text = getText(await threadHandler(client)({ message: 'CleanInbox:1' }));

            expect(text.split('\n')[1]?.split(' | Snippet: ')[1]).toBe(`Line one linetwo ${'x'.repeat(63)}…`);
        });

        test('refuses a message in a mailbox Izzy cannot read as getEmailContent does, before any WildDuck call', async () => {
            const client = threadClient({ results: [] });

            const result = await threadHandler(client, { sendAdminNotification: mockSendAdminNotification })({ message: 'Quarantine:7' });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Access to Quarantine requires admin review. A notification has been sent to #admin.' }], isError: true });
            expect(mockSendAdminNotification).toHaveBeenCalledWith({ folder: 'Quarantine', uid: 7 });
            expect(client.getMessage).not.toHaveBeenCalled();
            expect(client.searchPage).not.toHaveBeenCalled();
        });

        test('says when the message is not found', async () => {
            const client = threadClient({ results: [] });
            client.getMessage.mockImplementation(async () => null);

            const result = await threadHandler(client)({ message: 'Archive:9' });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Email Archive:9 not found.' }], isError: true });
            expect(client.searchPage).not.toHaveBeenCalled();
        });

        test.each([['no thread id', {}], ['a thread id that is not a string', { thread: 42 }]])('says when WildDuck gave the message %s', async (_label, fields) => {
            const client = threadClient({ results: [] }, fields);

            const result = await threadHandler(client)({ message: 'Archive:9' });

            expect(result).toEqual({ content: [{ type: 'text', text: 'Email Archive:9 has no thread information; read it with getEmailContent.' }], isError: true });
            expect(client.searchPage).not.toHaveBeenCalled();
        });

        test('reports a WildDuck failure by its classified code', async () => {
            const client = threadClient({ results: [] });
            client.searchPage.mockImplementation(async () => {
                throw new WildDuckError('WildDuck search returned a message from outside the mailbox searched', undefined, { kind: 'bad_response' });
            });

            const result = await threadHandler(client)({ message: 'CleanInbox:1' });

            expect(result).toEqual({ content: [{ type: 'text', text: failureText('getEmailThread', 'unavailable') }], isError: true });
        });

        test('fails fast while the email service is offline', async () => {
            const client = threadClient({ results: [] });

            const result = await threadHandler(client, { healthRegistry: makeOfflineHealthRegistry() })({ message: 'CleanInbox:1' });

            expect(result.isError).toBe(true);
            expect(client.getMessage).not.toHaveBeenCalled();
        });
    });

    describe('getRejectedDrafts tool', () => {
        test('reports the registered tool name when search fails', async () => {
            const wildDuckClient = { searchByKeyword: mock(async () => {
                throw new Error('search unavailable');
            }) } as unknown as WildDuckClient;
            const server = createEmailMCPServer({ wildDuckClient });
            const result = await getToolHandler(server, 'getRejectedDrafts')({});
            expect(result).toEqual({ content: [{ type: 'text', text: failureText('getRejectedDrafts', 'unavailable') }], isError: true });
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'getRejectedDrafts', detail: 'search unavailable', msg: 'Email tool failed' }));
        });
        test('should return an empty-but-valid result when admin-rejection search is empty', async () => {
            const wildDuckClient = {
                searchByKeyword: mock(async () => []),
                getMessage:      mock(() => Promise.resolve(null)),
            } as unknown as WildDuckClient;

            const server = createEmailMCPServer({ wildDuckClient });
            const handler = getToolHandler(server, 'getRejectedDrafts');
            const result = await handler({});

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toBe('No drafts rejected by admin review.');
            expect(wildDuckClient.searchByKeyword).toHaveBeenCalledTimes(1);
            expect(wildDuckClient.searchByKeyword).toHaveBeenCalledWith('Drafts', 'SendRejectedByAdmin');
        });

        test('should return the same empty result when rejected UIDs format to no line', async () => {
            // The admin-rejected message is missing rejectedAt, so its formatter returns undefined.
            const wildDuckClient = {
                searchByKeyword: mock(async () => [55]),
                getMessage:      mock(async () => ({ id: 55, subject: 'Pending', to: [{ address: 'alice@example.com' }], metaData: {} })),
            } as unknown as WildDuckClient;

            const server = createEmailMCPServer({ wildDuckClient });
            const handler = getToolHandler(server, 'getRejectedDrafts');
            const result = await handler({});

            expect(result.isError).toBeUndefined();
            expect(getText(result)).toBe('No drafts rejected by admin review.');
        });

        test('should render admin-rejected-only output byte-identical to buildAdminRejectedSubsection', async () => {
            const wildDuckClient = {
                searchByKeyword: mock(async (_folder: string, keyword: string) => (keyword === 'SendRejectedByAdmin' ? [99] : [])),
                getMessage:      mock(async () => ({
                    id:       99,
                    subject:  'Hi there',
                    to:       [{ address: 'bob@example.com' }],
                    metaData: { rejectedAt: '2024-01-01T00:00:00.000Z', reason: 'Inappropriate content' },
                })),
            } as unknown as WildDuckClient;

            const expected = await buildAdminRejectedSubsection([99], wildDuckClient);

            const server = createEmailMCPServer({ wildDuckClient });
            const handler = getToolHandler(server, 'getRejectedDrafts');
            const result = await handler({});

            expect(expected).toBeDefined();
            expect(getText(result)).toBe(expected!);
        });

        test('should return the unavailable result when email is offline, without calling WildDuck', async () => {
            const wildDuckClient = {
                searchByKeyword: mock(async () => []),
                getMessage:      mock(() => Promise.resolve(null)),
            } as unknown as WildDuckClient;
            const healthRegistry = makeOfflineHealthRegistry();

            const server = createEmailMCPServer({ wildDuckClient, healthRegistry });
            const handler = getToolHandler(server, 'getRejectedDrafts');
            const result = await handler({});

            expect(result.isError).toBe(true);
            expect(wildDuckClient.searchByKeyword).not.toHaveBeenCalled();
        });
    });

    describe('a bound on every WildDuck call under a draft key (#202)', () => {
        let events: string[];
        let draftLocks: { acquire: ReturnType<typeof mock> };

        beforeEach(() => {
            events = [];
            draftLocks = {
                acquire: mock(async (key: string) => {
                    events.push(`acquire ${key}`);
                    return () => {
                        events.push(`release ${key}`);
                    };
                }),
            };
        });

        afterEach(() => {
            jest.restoreAllMocks();
            jest.useRealTimers();
        });

        describe('deleteDraft', () => {
            const draft = { id: 42, draft: true, metaData: {} };

            test('gives the read and the delete one signal, aborted 45 s after the key is taken and stood down once they finish', async () => {
                const { controller, clear, spy } = controlDeadline(45_000);
                const getMessage = mock(async (_folder: string, _uid: number, _signal?: AbortSignal) => draft);
                const deleteMessage = mock(async (_folder: string, _uid: number, _signal?: AbortSignal) => undefined);
                const server = createEmailMCPServer({ wildDuckClient: { getMessage, deleteMessage } as unknown as WildDuckClient, draftLocks });

                expect(getText(await getToolHandler(server, 'deleteDraft')({ message: 'Drafts:42' }))).toBe('Draft Drafts:42 deleted.');

                expect(spy.mock.calls).toEqual([[45_000]]);
                expect(clear).toHaveBeenCalledTimes(1);
                expect(getMessage.mock.calls[0]?.[2]).toBe(controller.signal);
                expect(deleteMessage.mock.calls[0]?.[2]).toBe(controller.signal);
            });

            test('fails as a timeout at exactly 45 s, not a millisecond earlier, releasing the key', async () => {
                jest.useFakeTimers();
                const deleteMessage = mock(async (_folder: string, _uid: number, signal?: AbortSignal) => untilAborted(signal));
                const server = createEmailMCPServer({ wildDuckClient: { getMessage: mock(async () => draft), deleteMessage } as unknown as WildDuckClient, draftLocks });
                let settled = false;

                const deleting = getToolHandler(server, 'deleteDraft')({ message: 'Drafts:42' }).finally(() => {
                    settled = true;
                });
                await drainMicrotasks(50);
                jest.advanceTimersByTime(44_999);
                await drainMicrotasks(50);
                expect(settled).toBe(false);
                jest.advanceTimersByTime(1);
                const result = await deleting;

                expect(result).toEqual({ content: [{ type: 'text', text: `deleteDraft failed (timeout): The mail server did not answer in time, so it is not known whether this took effect. Check the current state (search or list again) before trying again. Reference: ${lastFailureReference()}.` }], isError: true });
                expect(events).toEqual(['acquire email-draft:42', 'release email-draft:42']);
                expect(jest.getTimerCount()).toBe(0);
            });
        });

        describe('amendAndResubmitDraft', () => {
            const ATTACHMENT = { id: 'ATT00001', filename: 'a.txt', contentType: 'text/plain', sizeKb: 1, size: 3 };
            const original = { id: 42, draft: true, subject: 'S', to: [{ address: 'to@example.com' }], cc: [], text: 'body', references: [], metaData: {}, attachments: [ATTACHMENT] };
            const PENDING = 'Message saved to Drafts, pending admin approval (draft UID: 55).';
            let client: Record<string, ReturnType<typeof mock>>;

            const amend = async (): Promise<CallToolResult> => {
                const server = createEmailMCPServer({ wildDuckClient: client as unknown as WildDuckClient, draftLocks, approvalCards: cardPort(mock(async () => 'posted')) });
                return getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42', body: 'new body' });
            };

            beforeEach(() => {
                client = {
                    getUserAddresses: mock(async () => [{ id: '1', address: 'formal@example.com', name: 'Izzy', main: false, tags: ['formal'] }]),
                    getMailboxId:     mock(() => undefined),
                    getMessage:       mock(async (_folder: string, uid: number, signal?: AbortSignal) => {
                        signal?.throwIfAborted();
                        return uid === 42 ? original : { id: 55, cc: [], attachments: [ATTACHMENT], references: [] };
                    }),
                    openAttachmentStream: mock(async (_folder: string, _uid: number, _id: string, _signal?: AbortSignal) => ({
                        status: 200, body: new Response('abc').body, contentLength: 3,
                    })),
                    uploadReplacingDraft: mock(async (_payload: unknown, _uid: number, _signal?: AbortSignal) => ({ id: 55, previousDeleted: false })),
                    deleteMessage:        mock(async (_folder: string, _uid: number, _signal?: AbortSignal) => undefined),
                };
            });

            test('ties every WildDuck call under the key to one 120 s budget, stood down once the locked section ends', async () => {
                const { controller, clear, spy } = controlDeadline(120_000);

                expect(getText(await amend())).toBe(`${PENDING} Cc: 0 addresses (kept from the original draft). Attachments: 1 kept from the original draft, 0 removed, 0 added.`);

                expect(spy.mock.calls.map(([ms]) => ms)).toEqual([120_000, 60_000, 10_000]);
                expect(clear).toHaveBeenCalledTimes(1);
                const signals = [
                    ...client.getMessage.mock.calls.map(call => call[2] as AbortSignal),
                    client.openAttachmentStream.mock.calls[0]?.[3] as AbortSignal,
                    client.uploadReplacingDraft.mock.calls[0]?.[2] as AbortSignal,
                    client.deleteMessage.mock.calls[0]?.[2] as AbortSignal,
                ];
                expect(signals).toHaveLength(5);
                expect(signals.map(signal => signal.aborted)).toEqual([false, false, false, false, false]);
                controller.abort();
                expect(signals.map(signal => signal.aborted)).toEqual([true, true, true, true, true]);
            });

            test('ties the replied-to message\'s lookup and the old draft\'s header read to the same budget, before the upload', async () => {
                const { controller } = controlDeadline(120_000);
                const reply = { ...original, references: ['<p@example.com>'], reference: { action: 'reply', mailbox: 'a'.repeat(24), id: 7 } };
                client.getMailboxId.mockImplementation((folder: string) => (folder === 'CleanInbox' ? 'a'.repeat(24) : undefined));
                client.getMessage.mockImplementation(async (folder: string, uid: number) => {
                    if(folder !== 'Drafts') {
                        return null;
                    }
                    return uid === 42 ? reply : { id: 55, cc: [], attachments: [ATTACHMENT], references: ['<p@example.com>'] };
                });
                client.getThreadingHeaders = mock(async (_folder: string, _uid: number, _signal?: AbortSignal) => ({ inReplyTo: '<p@example.com>', references: ['<p@example.com>'] }));

                await amend();

                const signals = [client.getMessage.mock.calls[1]?.[2] as AbortSignal, client.getThreadingHeaders.mock.calls[0]?.[2] as AbortSignal];
                expect(client.getMessage.mock.calls[1]?.slice(0, 2)).toEqual(['CleanInbox', 7]);
                expect(signals.map(signal => signal.aborted)).toEqual([false, false]);
                controller.abort();
                expect(signals.map(signal => signal.aborted)).toEqual([true, true]);
            });

            test('an upload still unanswered at exactly 120 s, not a millisecond earlier, fails as a timeout and releases the key', async () => {
                jest.useFakeTimers();
                client.uploadReplacingDraft.mockImplementation(async (_payload: unknown, _uid: number, signal?: AbortSignal) => untilAborted(signal));
                let settled = false;

                const amending = amend().finally(() => {
                    settled = true;
                });
                await drainMicrotasks(100);
                jest.advanceTimersByTime(119_999);
                await drainMicrotasks(50);
                expect(settled).toBe(false);
                jest.advanceTimersByTime(1);
                const result = await amending;

                expect(result).toEqual({ content: [{ type: 'text', text: `amendAndResubmitDraft failed (timeout): The mail server did not answer in time, so it is not known whether this took effect. Check the current state (search or list again) before trying again. Reference: ${lastFailureReference()}.` }], isError: true });
                expect(events).toEqual(['acquire email-draft:42', 'release email-draft:42']);
                expect(client.uploadReplacingDraft).toHaveBeenCalledTimes(1);
                expect(jest.getTimerCount()).toBe(0);
            });

            test('a budget spent after the upload still reports the new draft and what could not be completed', async () => {
                jest.useFakeTimers();
                client.deleteMessage.mockImplementation(async (_folder: string, _uid: number, signal?: AbortSignal) => untilAborted(signal));
                const markSuperseded = mock(async () => false);
                const server = createEmailMCPServer({ wildDuckClient: client as unknown as WildDuckClient, draftLocks, approvalCards: cardPort(mock(async () => 'posted'), { markSuperseded }) });

                const amending = getToolHandler(server, 'amendAndResubmitDraft')({ message: 'Drafts:42', body: 'new body' });
                await drainMicrotasks(100);
                jest.advanceTimersByTime(120_000);
                const result = await amending;

                expect(result.isError).toBeUndefined();
                expect(getText(result)).toBe(`${PENDING} Cc and attachments were sent to WildDuck (0 Cc, 1 attachment kept, 0 removed, 0 added) but could not be confirmed on the stored draft. Warning: the previous version Drafts:42 could not be removed; delete it with deleteDraft.`);
                expect(markSuperseded).toHaveBeenCalledWith(42, 55);
                expect(client.deleteMessage).toHaveBeenCalledTimes(1);
                expect(events).toEqual(['acquire email-draft:42', 'release email-draft:42']);
            });
        });
    });

    describe('the outcome of a direct send whose submit failed', () => {
        const DRAFT = { id: 99, messageId: '<draft-99@example.com>', date: '2026-11-17T10:00:00.000Z', draft: true };
        let client: Record<string, ReturnType<typeof mock>>;
        let rateLimiter: { isAtLimit: ReturnType<typeof mock>, tokensRemaining: ReturnType<typeof mock>, increment: ReturnType<typeof mock> };
        const allowlist = { isAllowed: mock(() => true) } as unknown as PersonAllowlist;

        const send = async (): Promise<CallToolResult> => {
            const server = createEmailMCPServer({ wildDuckClient: client as unknown as WildDuckClient, allowlist, rateLimiter: rateLimiter as unknown as TokenBucketRateLimiter });
            return getToolHandler(server, 'sendEmail')({ to: 'alice@example.com', subject: 'Hi', body: 'Hello' });
        };
        const refusal = (status: number): WildDuckError => new WildDuckError(`WildDuck API error: ${status} Error: upstream says no`, undefined, { status, kind: 'http' });
        const timeout = (): DOMException => new DOMException('The operation timed out.', 'TimeoutError');
        /** A WildDuck call that fails with `error`. */
        const throwing = (error: unknown) => async (): Promise<never> => {
            throw error;
        };
        const notSent = (code: string, notes = ''): string => `Not sent: the mail server refused to send this message (${code}), and it is still an unsent draft, Drafts:99. To try again, delete it with deleteDraft, then send or reply again; if it is refused again, tell the admin. Reference: ${lastFailureReference()}.${notes}`;
        const unknown = (code: string, notes = ''): string => `Outcome unknown: the mail server did not confirm sending this message (${code}), so it may or may not have gone out (draft Drafts:99). Do not send this again; check Sent Mail later. Reference: ${lastFailureReference()}.${notes}`;

        beforeEach(() => {
            client = {
                getUserAddresses:       mock(async () => [{ id: '1', address: 'formal@example.com', name: 'Izzy', main: false, tags: ['formal'] }]),
                uploadMessage:          mock(async () => 99),
                getMessage:             mock(async (_folder: string, _uid: number, _signal?: AbortSignal) => DRAFT),
                submitMessage:          mock(async () => undefined),
                findMessageByMessageId: mock(async (_folder: string, _messageId: string, _signal?: AbortSignal) => false),
            };
            rateLimiter = { isAtLimit: mock(() => false), tokensRemaining: mock(() => 3), increment: mock(() => undefined) };
        });

        afterEach(() => {
            jest.restoreAllMocks();
            jest.useRealTimers();
        });

        test('reads the draft\'s Message-ID and Date before submitting, and a submit that succeeds is reported as before', async () => {
            const result = await send();

            expect(result).toEqual({ content: [{ type: 'text', text: 'Sent successfully.' }] });
            expect(client.getMessage).toHaveBeenCalledWith('Drafts', 99, expect.any(AbortSignal));
            expect(client.getMessage.mock.invocationCallOrder[0]).toBeLessThan(client.submitMessage.mock.invocationCallOrder[0]);
            expect(client.submitMessage).toHaveBeenCalledWith('Drafts', 99);
            expect(client.findMessageByMessageId).not.toHaveBeenCalled();
            expect(rateLimiter.increment).toHaveBeenCalledTimes(1);
        });

        test('a failed submit whose message is in Sent Mail is reported sent, and charged once', async () => {
            client.submitMessage.mockImplementation(async () => {
                throw timeout();
            });
            client.findMessageByMessageId.mockImplementation(async () => true);

            const result = await send();

            expect(result).toEqual({ content: [{ type: 'text', text: 'Sent successfully. The mail server reported an error, but the message was found in Sent Mail.' }] });
            expect(client.findMessageByMessageId).toHaveBeenCalledWith('Sent Mail', '<draft-99@example.com>', expect.any(AbortSignal));
            expect(client.submitMessage).toHaveBeenCalledTimes(1);
            expect(rateLimiter.increment).toHaveBeenCalledTimes(1);
        });

        test.each([
            ['a 4xx refusal', async () => { throw refusal(400); }, 'refused'],
            ['a 499 refusal', async () => { throw refusal(499); }, 'refused'],
            ['a refused login', async () => { throw new WildDuckAuthError('WildDuck authentication failed (401)', { kind: 'auth' }); }, 'auth'],
            ['a request refused before it was sent', async () => { throw new WildDuckError('WildDuck: unknown mailbox path: Drafts', undefined, { kind: 'invalid_request' }); }, 'invalid_request'],
        ] as const)('%s with the draft untouched in Drafts is reported not sent, kept as its draft, and not charged', async (_label, submit, code) => {
            client.submitMessage.mockImplementation(submit);

            const result = await send();

            expect(result).toEqual({ content: [{ type: 'text', text: notSent(code) }], isError: true });
            expect(client.submitMessage).toHaveBeenCalledTimes(1);
            expect(client.getMessage).toHaveBeenCalledTimes(2);
            expect(client.getMessage.mock.calls[1]).toEqual(['Drafts', 99, expect.any(AbortSignal)]);
            expect(rateLimiter.increment).not.toHaveBeenCalled();
            expect(getText(result)).not.toContain('upstream says no');
        });

        test.each([
            ['a timeout', async () => { throw timeout(); }, 'timeout'],
            ['a 408', async () => { throw refusal(408); }, 'timeout'],
            ['a 5xx', async () => { throw refusal(503); }, 'unavailable'],
            ['a 404', async () => { throw refusal(404); }, 'not_found'],
            ['a network failure', async () => { throw new TypeError('fetch failed'); }, 'unavailable'],
        ] as const)('%s is reported unknown even with the draft untouched (the submit may still be running), and charged', async (_label, submit, code) => {
            client.submitMessage.mockImplementation(submit);

            const result = await send();

            expect(result).toEqual({ content: [{ type: 'text', text: unknown(code) }], isError: true });
            expect(client.submitMessage).toHaveBeenCalledTimes(1);
            expect(rateLimiter.increment).toHaveBeenCalledTimes(1);
        });

        test('a refusal whose draft has changed since it was read is reported unknown, and charged', async () => {
            client.submitMessage.mockImplementation(throwing(refusal(400)));
            client.getMessage.mockImplementationOnce(async () => DRAFT).mockImplementationOnce(async () => ({ ...DRAFT, date: '2026-11-17T10:00:05.000Z' }));

            expect(getText(await send())).toBe(unknown('refused'));
            expect(rateLimiter.increment).toHaveBeenCalledTimes(1);
        });

        test('a refusal whose outcome check fails is reported unknown, and the check failure is logged', async () => {
            client.submitMessage.mockImplementation(throwing(refusal(400)));
            client.findMessageByMessageId.mockImplementation(throwing(refusal(502)));

            expect(getText(await send())).toBe(unknown('refused'));
            expect(mockLogger.warn).toHaveBeenCalledWith({ uid: 99, status: 502, msg: 'Could not check whether a failed send went out' });
            expect(rateLimiter.increment).toHaveBeenCalledTimes(1);
        });

        const READ_FAILED = 'Could not read the draft before sending it; a failed send will be reported as unknown';
        const CHECK_FAILED = 'Could not check whether a failed send went out';

        test.each([
            ['the read fails', throwing(new TypeError('fetch failed')), [READ_FAILED]],
            ['the draft is not found', async () => null, []],
            ['the draft has no Date', async () => ({ ...DRAFT, date: null }), []],
        ])('when %s before the submit, the send still goes ahead, and a refusal is reported unknown', async (_label, read, logged) => {
            client.getMessage.mockImplementation(read);
            client.submitMessage.mockImplementationOnce(async () => undefined).mockImplementationOnce(throwing(refusal(400)));

            expect(getText(await send())).toBe('Sent successfully.');
            expect(getText(await send())).toBe(unknown('refused'));
            expect(client.findMessageByMessageId).not.toHaveBeenCalled();
            const messages = mockLogger.warn.mock.calls.map(([entry]) => (entry as { msg?: string }).msg);
            const outcomeLogs = new Set<string | undefined>([READ_FAILED, CHECK_FAILED]);
            expect(messages.filter(msg => outcomeLogs.has(msg))).toEqual([...logged, ...logged]);
        });

        test('stands down the read\'s and the check\'s deadlines once each is done', async () => {
            jest.useFakeTimers();

            expect(getText(await send())).toBe('Sent successfully.');
            expect(jest.getTimerCount()).toBe(0);
            client.submitMessage.mockImplementation(throwing(refusal(400)));
            expect(getText(await send())).toBe(notSent('refused'));
            expect(jest.getTimerCount()).toBe(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'sendEmail', code: 'refused', status: 400, msg: 'Email tool failed' }));
        });

        test('logs a failed read before the submit by its error name, never its text', async () => {
            client.getMessage.mockImplementation(throwing(new TypeError('fetch failed')));

            await send();

            expect(mockLogger.warn).toHaveBeenCalledWith({ uid: 99, error: 'TypeError', msg: 'Could not read the draft before sending it; a failed send will be reported as unknown' });
        });

        test('appends the rate-limit note to each outcome', async () => {
            rateLimiter.isAtLimit.mockImplementation(() => true);
            const NOTE = ' Warning: send rate limit reached (3 tokens remaining).';

            client.submitMessage.mockImplementation(throwing(refusal(400)));
            expect(getText(await send())).toBe(notSent('refused', NOTE));
            client.submitMessage.mockImplementation(throwing(timeout()));
            expect(getText(await send())).toBe(unknown('timeout', NOTE));
            client.findMessageByMessageId.mockImplementation(async () => true);
            expect(getText(await send())).toBe(`Sent successfully. The mail server reported an error, but the message was found in Sent Mail.${NOTE}`);
        });

        test('gives up on the read before the submit at exactly 10 s, not a millisecond earlier, then submits', async () => {
            jest.useFakeTimers();
            client.getMessage.mockImplementation(async (_folder: string, _uid: number, signal?: AbortSignal) => untilAborted(signal));
            const sending = send();
            await drainMicrotasks(50);
            jest.advanceTimersByTime(9999);
            await drainMicrotasks(50);
            expect(client.submitMessage).not.toHaveBeenCalled();
            jest.advanceTimersByTime(1);

            expect(getText(await sending)).toBe('Sent successfully.');
            expect(jest.getTimerCount()).toBe(0);
        });

        test('gives up on the outcome check at exactly 20 s, not a millisecond earlier, reporting unknown', async () => {
            jest.useFakeTimers();
            client.submitMessage.mockImplementation(throwing(refusal(400)));
            client.findMessageByMessageId.mockImplementation(async (_folder: string, _id: string, signal?: AbortSignal) => untilAborted(signal));
            let settled = false;
            const sending = send().finally(() => {
                settled = true;
            });
            await drainMicrotasks(50);
            jest.advanceTimersByTime(19_999);
            await drainMicrotasks(50);
            expect(settled).toBe(false);
            jest.advanceTimersByTime(1);

            expect(getText(await sending)).toBe(unknown('refused'));
            expect(mockLogger.warn).toHaveBeenCalledWith({ uid: 99, error: 'TimeoutError', msg: 'Could not check whether a failed send went out' });
            expect(jest.getTimerCount()).toBe(0);
        });

        test('replyToEmail\'s direct reply reports the same outcomes, confirming a sent reply with its own text', async () => {
            const original = { id: 7, subject: 'Hello', from: { address: 'alice@example.com' } };
            client.getMessage.mockImplementation(async (folder: string) => (folder === 'Drafts' ? DRAFT : original));
            client.getMailboxId = mock(() => 'mbx-clean');
            client.submitMessage.mockImplementation(throwing(timeout()));
            const server = createEmailMCPServer({ wildDuckClient: client as unknown as WildDuckClient, allowlist, rateLimiter: rateLimiter as unknown as TokenBucketRateLimiter });
            const reply = async (): Promise<CallToolResult> => getToolHandler(server, 'replyToEmail')({ message: 'CleanInbox:7', body: 'Thanks', mode: 'reply' });

            expect(getText(await reply())).toBe(unknown('timeout'));
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'replyToEmail', code: 'timeout', msg: 'Email tool failed' }));
            client.findMessageByMessageId.mockImplementation(async () => true);
            expect(getText(await reply())).toBe('Reply sent to alice@example.com. The mail server reported an error, but the message was found in Sent Mail.');
        });
    });

    describe('mutation regression contracts', () => {
        test('attachment downloads never exceed two active requests and eventually return every attachment', async () => {
            const gate = Promise.withResolvers<void>();
            let active = 0;
            let maxActive = 0;
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            7,
                messageId:      '<m>',
                from:           { address: 'from@example.com' },
                to:             [],
                cc:             [],
                subject:        '',
                date:           new Date(0),
                bodyText:       '',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [
                    { id: 'a', filename: 'a.txt', contentType: 'text/plain', sizeKb: 1 },
                    { id: 'b', filename: 'b.txt', contentType: 'text/plain', sizeKb: 1 },
                    { id: 'c', filename: 'c.txt', contentType: 'text/plain', sizeKb: 1 },
                ],
            }));
            mockFsPromises.access.mockRejectedValue(new Error('missing'));
            mockWildDuck.getAttachment = mock(async (_mailbox: string, _uid: number, id: string) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                try {
                    await gate.promise;
                    return Buffer.from(id);
                } finally {
                    active -= 1;
                }
            });
            const pending = getToolHandler(createEmailMCPServer({ wildDuckClient: mockWildDuck }), 'getEmailContent')({ message: 'CleanInbox:7' });
            try {
                await drainMicrotasks();
                expect(maxActive).toBeLessThanOrEqual(2);
                gate.resolve();
                const result = await pending;
                expect(getText(result)).toContain('a.txt');
                expect(getText(result)).toContain('b.txt');
                expect(getText(result)).toContain('c.txt');
            } finally {
                gate.resolve();
                await pending.catch(() => undefined);
            }
        });

        test('embedded video text in an audio MIME type is handled as a generic attachment', async () => {
            mockWildDuck.getFullMessage = mock(async () => ({
                uid:            7,
                messageId:      '<m>',
                from:           { address: 'from@example.com' },
                to:             [],
                cc:             [],
                subject:        '',
                date:           new Date(0),
                bodyText:       '',
                hasAttachments: true,
                headers:        {},
                attachments:    [],
                attachmentMeta: [{ id: 'a', filename: 'a.mid', contentType: 'audio/x-video/midi', sizeKb: 1 }],
            }));
            mockFsPromises.access.mockRejectedValue(new Error('missing'));
            mockWildDuck.getAttachment = mock(async () => Buffer.from('midi'));
            const videoSpy = spyOn(utils, 'processLocalVideo').mockResolvedValue({
                metadata:         { duration: 1, width: 1, height: 1, videoCodec: 'midi', frameRate: 1, subtitleTracks: [] },
                frames:           [],
                text:             { kind: 'transcription', outcome: { kind: 'empty' } },
                metadataMarkdown: 'not a video',
                outputDir:        'unused',
            });
            try {
                const result = await getToolHandler(createEmailMCPServer({ wildDuckClient: mockWildDuck }), 'getEmailContent')({ message: 'CleanInbox:7' });
                expect(videoSpy).not.toHaveBeenCalled();
                expect(getText(result)).toContain('audio/x-video/midi');
            } finally {
                videoSpy.mockRestore();
            }
        });

        test('concurrent sends await the shared address load and an allowed send awaits submission', async () => {
            const addressGate = Promise.withResolvers<{ address: string, tags: string[] }[]>();
            const submitGate = Promise.withResolvers<void>();
            const client = {
                ...mockWildDuck,
                getUserAddresses: mock(() => addressGate.promise),
                uploadMessage:    mock(() => Promise.resolve(10)),
                submitMessage:    mock(() => submitGate.promise),
            } as unknown as WildDuckClient;
            const allowlist = { isAllowed: mock(() => true) } as unknown as PersonAllowlist;
            const handler = getToolHandler(createEmailMCPServer({ wildDuckClient: client, allowlist }), 'sendEmail');
            let settled = false;
            const first = handler({ to: 'a@example.com', subject: 'A', body: 'A', senderProfile: 'formal' }).finally(() => {
                settled = true;
            });
            const second = handler({ to: 'b@example.com', subject: 'B', body: 'B', senderProfile: 'formal' });
            try {
                await drainMicrotasks();
                expect(client.uploadMessage).not.toHaveBeenCalled();
                addressGate.resolve([{ address: 'me@example.com', tags: ['formal'] }]);
                await drainMicrotasks(50);
                expect(client.uploadMessage).toHaveBeenCalledTimes(2);
                expect(settled).toBe(false);
                submitGate.resolve();
                await Promise.all([first, second]);
            } finally {
                addressGate.resolve([{ address: 'me@example.com', tags: ['formal'] }]);
                submitGate.resolve();
                await Promise.allSettled([first, second]);
            }
        });

        test('getEmailContent awaits the Seen update before returning', async () => {
            const seenGate = Promise.withResolvers<void>();
            mockWildDuck.updateMessageFlags = mock(() => seenGate.promise);
            let settled = false;
            const pending = getToolHandler(createEmailMCPServer({ wildDuckClient: mockWildDuck }), 'getEmailContent')({ message: 'CleanInbox:1' }).finally(() => {
                settled = true;
            });
            try {
                await drainMicrotasks();
                expect(settled).toBe(false);
                seenGate.resolve();
                await pending;
            } finally {
                seenGate.resolve();
                await pending.catch(() => undefined);
            }
        });

        test('one send attachment is uploaded with its exact name, type, and content', async () => {
            const client = {
                ...mockWildDuck,
                getUserAddresses: mock(() => Promise.resolve([{ address: 'me@example.com', tags: ['formal'] }])),
                uploadMessage:    mock(() => Promise.resolve(10)),
                getMessage:       mock(() => Promise.resolve(null)),
            } as unknown as WildDuckClient;
            await getToolHandler(createEmailMCPServer({ wildDuckClient: client, attachmentRoot: ATTACHMENT_ROOT, readAttachmentFile: attachmentFiles({ 'tmp/one.txt': 'file' }) }), 'sendEmail')({ to: 'a@example.com', subject: 'A', body: 'A', senderProfile: 'formal', attachments: ['tmp/one.txt'] });
            expect(client.uploadMessage).toHaveBeenCalledWith('Drafts', expect.objectContaining({
                attachments: [{
                    filename:    'one.txt',
                    contentType: 'text/plain',
                    content:     Buffer.from('file').toString('base64'),
                }],
            }));
        });

        test('a missing reply names its requested identifier', async () => {
            const client = {
                ...mockWildDuck,
                getUserAddresses: mock(() => Promise.resolve([{ address: 'me@example.com', tags: ['formal'] }])),
                getMessage:       mock(() => Promise.resolve(null)),
            } as unknown as WildDuckClient;
            const missing = await getToolHandler(createEmailMCPServer({ wildDuckClient: client }), 'replyToEmail')({ message: 'Archive:987', body: 'x', mode: 'reply', senderProfile: 'formal' });
            expect(getText(missing)).toBe("Cannot reply: message 'Archive:987' not found.");
        });

        test('an allowlisted reply identifies its recipient and includes one attachment', async () => {
            const uploadMessage = mock(() => Promise.resolve(44));
            const client = {
                ...mockWildDuck,
                getUserAddresses: mock(() => Promise.resolve([{ address: 'me@example.com', tags: ['formal'] }])),
                getMessage:       mock(() => Promise.resolve({ from: { address: 'sender@example.com' }, replyTo: undefined, cc: [], subject: 'S' })),
                getMailboxId:     mock(() => 'mailbox-id'),
                uploadMessage,
                submitMessage:    mock(() => Promise.resolve()),
            } as unknown as WildDuckClient;
            const allowlist = { isAllowed: mock(() => true) } as unknown as PersonAllowlist;
            const result = await getToolHandler(createEmailMCPServer({ wildDuckClient: client, allowlist, attachmentRoot: ATTACHMENT_ROOT, readAttachmentFile: attachmentFiles({ 'tmp/one.txt': 'file' }) }), 'replyToEmail')({ message: 'CleanInbox:2', body: 'reply', mode: 'reply', senderProfile: 'formal', attachments: ['/work/izzy/tmp/one.txt'] });
            expect(getText(result)).toBe('Reply sent to sender@example.com.');
            expect(uploadMessage).toHaveBeenCalledWith('Drafts', expect.objectContaining({
                attachments: [{
                    filename:    'one.txt',
                    contentType: 'text/plain',
                    content:     Buffer.from('file').toString('base64'),
                }],
            }));
        });

        test('amend accepts a single recipient in its recipient array', async () => {
            const server = createEmailMCPServer({ wildDuckClient: mockWildDuck });
            const registered = (server.instance as unknown as RegisteredToolInstance)._registeredTools.amendAndResubmitDraft;
            await expect(registered.inputSchema.safeParseAsync({
                message: 'Drafts:1',
                to:      ['one@example.com'],
            })).resolves.toMatchObject({ success: true });
        });
    });
});

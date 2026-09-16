import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { Client, Message, Collection, Attachment } from 'discord.js';
import { mockLogger } from '../../../setup';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import {
    createReadyHandler,
    createErrorHandler,
    createMessageHandler,
    extractAttachmentMetadata
} from '@/integrations/discord/handlers';
import type { IngressGate } from '@/integrations/discord/ingress-gate';
import type { MessageCoordinator } from '@/integrations/discord/message-coordinator';
import { createChannelId, createUserId, type DiscordMessageContext  } from '@/integrations/discord/types';

// Helper to create a mock coordinator for tests
function createMockCoordinator() {
    return {
        handleMessage: mock(() => undefined),
    } as unknown as MessageCoordinator;
}

// Helper to create an ingress gate stub that always admits ('pass') — most tests here are not
// about boot-time buffering, so the gate should simply get out of the way.
function createPassingIngressGate() {
    return { admit: mock(() => 'pass' as const) } as unknown as IngressGate<Message>;
}

describe('Discord Event Handlers', () => {
    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
    });

    describe('createReadyHandler', () => {
        it('should log bot user tag when ready event fires', () => {
            const handler = createReadyHandler();

            const mockClient = {
                user: {
                    tag: 'TestBot#1234'
                }
            } as Client;

            handler(mockClient);

            expect(mockLogger.info).toHaveBeenCalled();
            const lastCall = mockLogger.info.mock.calls[mockLogger.info.mock.calls.length - 1];
            const message = lastCall[0] as string;
            expect(message).toContain('TestBot#1234');
        });

        it('should log "ready" or "logged in" message', () => {
            const handler = createReadyHandler();

            const mockClient = {
                user: {
                    tag: 'TestBot#9999'
                }
            } as Client;

            handler(mockClient);

            expect(mockLogger.info).toHaveBeenCalled();
            const logMessage = (mockLogger.info.mock.calls[0])[0] as string;

            const lower = logMessage.toLowerCase();

            expect(lower.includes('ready') || lower.includes('logged in')).toBe(true);
        });

        it('should handle client without user gracefully', () => {
            const handler = createReadyHandler();

            const mockClient = {
                user: null
            } as unknown as Client;

            // Should not throw
            expect(() => handler(mockClient)).not.toThrow();
            expect(mockLogger.info).toHaveBeenCalled();
        });

        it('should log fallback message when client.user is null', () => {
            const handler = createReadyHandler();

            const mockClient = {
                user: null
            } as unknown as Client;

            handler(mockClient);

            expect(mockLogger.info).toHaveBeenCalled();
            const lastCall = mockLogger.info.mock.calls[mockLogger.info.mock.calls.length - 1];
            expect((lastCall[0] as string).includes('not available')).toBe(true);
        });
    });

    describe('createErrorHandler', () => {
        it('should log error when error event fires', () => {
            const handler = createErrorHandler();

            const testError = new Error('Test error message');
            handler(testError);

            expect(mockLogger.error).toHaveBeenCalled();
            const firstCall = mockLogger.error.mock.calls[mockLogger.error.mock.calls.length - 1];
            // logger.error({ error, msg }) - single object with error and msg properties
            const loggedObject = firstCall[0] as { error: Error, msg: string };
            expect(loggedObject).toHaveProperty('error', testError);
            expect(loggedObject.msg.includes('Test error message')).toBe(true);
        });

        it('should log error with context about Discord', () => {
            const handler = createErrorHandler();

            const testError = new Error('Connection failed');
            handler(testError);

            expect(mockLogger.error).toHaveBeenCalled();
            const lastCall = mockLogger.error.mock.calls[mockLogger.error.mock.calls.length - 1];
            // logger.error({ error, msg }) - single object with error and msg properties
            const loggedObject = lastCall[0] as { error: Error, msg: string };
            expect(loggedObject).toHaveProperty('error', testError);

            const lower = loggedObject.msg.toLowerCase();

            expect(lower.includes('discord') || lower.includes('error')).toBe(true);
        });

        it('should handle non-Error objects', () => {
            const handler = createErrorHandler();

            // Discord.js might emit string errors or other types
            handler('String error' as unknown as Error);

            expect(mockLogger.error).toHaveBeenCalled();
        });
    });

    describe('Content Type Inference for Attachments', () => {
        const botUserId = createUserId('bot-123');
        const monitoredChannelId = createChannelId('channel-456');

        const createMockMessage = (attachments: { name: string, contentType: string | null }[]): Message => {
            const attachmentCollection = new Map() as Collection<string, Attachment>;

            for(const [index, att] of attachments.entries()) {
                attachmentCollection.set(`att-${index}`, {
                    id:          `att-${index}`,
                    name:        att.name,
                    contentType: att.contentType,
                    url:         `https://cdn.discord.com/attachments/test-${index}`,
                    size:        1024,
                    width:       null,
                    height:      null,
                } as Attachment);
            }

            return {
                id:     'msg-123',
                author: {
                    id:  'user-789',
                    tag: 'TestUser#1234',
                    bot: false,
                },
                content:      'Test message',
                cleanContent: 'Test message',
                channel:      {
                    id:         monitoredChannelId,
                    isThread:   () => false,
                    sendTyping: mock(async () => {}),
                },
                guild: {
                    id: 'guild-123',
                },
                attachments: attachmentCollection,
                createdAt:   new Date(),
            } as unknown as Message;
        };

        it.each([
            { desc: 'should infer image/heic for .heic files with null contentType', filename: 'photo.heic', expectedType: 'image/heic' },
            { desc: 'should infer image/heif for .heif files with null contentType', filename: 'photo.heif', expectedType: 'image/heif' },
            { desc: 'should infer image/jpeg for .jpg files with null contentType', filename: 'photo.jpg', expectedType: 'image/jpeg' },
            { desc: 'should infer image/png for .png files with null contentType', filename: 'image.png', expectedType: 'image/png' },
            { desc: 'should fallback to application/octet-stream for unknown extensions with null contentType', filename: 'file.xyz', expectedType: 'application/octet-stream' },
            { desc: 'should handle case-insensitive file extensions', filename: 'photo.HEIC', expectedType: 'image/heic' },
            { desc: 'should handle file without extension and return octet-stream', filename: 'README', expectedType: 'application/octet-stream' }
        ])('$desc', async ({ filename, expectedType }) => {
            const coordinator = createMockCoordinator();
            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator,
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessage([{ name: filename, contentType: null }]);
            await handler(message);

            expect(coordinator.handleMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachments: [expect.objectContaining({ filename, contentType: expectedType })],
                }),
                message,
                expect.anything()
            );
        });

        it('should use provided contentType when Discord provides a valid image type', async () => {
            const coordinator = createMockCoordinator();
            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator,
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessage([{ name: 'photo.heic', contentType: 'image/webp' }]);
            await handler(message);

            // Discord-provided valid image type wins over extension inference
            expect(coordinator.handleMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachments: [expect.objectContaining({ filename: 'photo.heic', contentType: 'image/webp' })],
                }),
                message,
                expect.anything()
            );
        });

        it('should infer from extension when Discord provides application/octet-stream', async () => {
            const coordinator = createMockCoordinator();
            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator,
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessage([{ name: 'photo.heic', contentType: 'application/octet-stream' }]);
            await handler(message);

            // octet-stream is not an image/* type, so inference from .heic wins
            expect(coordinator.handleMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachments: [expect.objectContaining({ filename: 'photo.heic', contentType: 'image/heic' })],
                }),
                message,
                expect.anything()
            );
        });

        it('should reject contentType that ends with image/ instead of starting with it', async () => {
            const coordinator = createMockCoordinator();
            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator,
                ingressGate:     createPassingIngressGate(),
            });

            // Discord provides invalid contentType 'text/image/' - should be ignored
            const message = createMockMessage([{ name: 'photo.png', contentType: 'text/image/' }]);
            await handler(message);

            // 'text/image/' does not start with 'image/', so inference from .png wins
            expect(coordinator.handleMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachments: [expect.objectContaining({ filename: 'photo.png', contentType: 'image/png' })],
                }),
                message,
                expect.anything()
            );
        });

        it('should prefer Discord contentType over extension when valid image type provided', async () => {
            const coordinator = createMockCoordinator();
            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator,
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessage([{ name: 'file.txt', contentType: 'image/png' }]);
            await handler(message);

            // Discord's valid image/png is preferred over the .txt extension
            expect(coordinator.handleMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachments: [expect.objectContaining({ filename: 'file.txt', contentType: 'image/png' })],
                }),
                message,
                expect.anything()
            );
        });

        it.each([
            { desc: 'should return exact image/heic string for .heic extension', filename: 'photo.heic', expectedType: 'image/heic' },
            { desc: 'should return exact image/jpeg string for .jpg extension', filename: 'photo.jpg', expectedType: 'image/jpeg' },
            { desc: 'should return exact image/png string for .png extension', filename: 'image.png', expectedType: 'image/png' },
            { desc: 'should return exact application/octet-stream string for unknown extension', filename: 'file.xyz', expectedType: 'application/octet-stream' },
            { desc: 'should return non-empty string for heic contentType', filename: 'photo.heic', expectedType: 'image/heic' },
            { desc: 'should return non-empty string for heif contentType', filename: 'photo.heif', expectedType: 'image/heif' },
            { desc: 'should return non-empty string for jpeg contentType', filename: 'photo.jpeg', expectedType: 'image/jpeg' },
            { desc: 'should return non-empty string for png contentType', filename: 'image.png', expectedType: 'image/png' },
            { desc: 'should return non-empty string for gif contentType', filename: 'animation.gif', expectedType: 'image/gif' },
            { desc: 'should return non-empty string for webp contentType', filename: 'photo.webp', expectedType: 'image/webp' },
            { desc: 'should return non-empty string for octet-stream', filename: 'file.unknown', expectedType: 'application/octet-stream' },
            { desc: 'should handle null Discord contentType correctly (test always-true conditional)', filename: 'test.png', expectedType: 'image/png' }
        ])('$desc', async ({ filename, expectedType }) => {
            const coordinator = createMockCoordinator();
            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator,
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessage([{ name: filename, contentType: null }]);
            await handler(message);

            expect(coordinator.handleMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachments: [expect.objectContaining({ contentType: expectedType })],
                }),
                message,
                expect.anything()
            );
        });

        it('should use actual filename when attachment name is provided', async () => {
            const coordinator = createMockCoordinator();
            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator,
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessage([{ name: 'my-photo.jpg', contentType: 'image/jpeg' }]);
            await handler(message);

            expect(coordinator.handleMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachments: [expect.objectContaining({ filename: 'my-photo.jpg', contentType: 'image/jpeg' })],
                }),
                message,
                expect.anything()
            );
        });

        it('should include attachments in context when present', async () => {
            const coordinator = createMockCoordinator();
            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator,
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessage([
                { name: 'photo1.png', contentType: 'image/png' },
                { name: 'photo2.jpg', contentType: 'image/jpeg' }
            ]);
            await handler(message);

            expect(coordinator.handleMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachments: [
                        expect.objectContaining({ filename: 'photo1.png', contentType: 'image/png' }),
                        expect.objectContaining({ filename: 'photo2.jpg', contentType: 'image/jpeg' }),
                    ],
                }),
                message,
                expect.anything()
            );
        });

        it('should NOT include attachments in context when empty', async () => {
            const coordinator = createMockCoordinator();
            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator,
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessage([]);
            await handler(message);

            expect(coordinator.handleMessage).toHaveBeenCalledWith(
                expect.objectContaining({ attachments: undefined }),
                message,
                expect.anything()
            );
        });

        it('should verify startsWith not endsWith for image/ prefix', async () => {
            const coordinator = createMockCoordinator();
            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator,
                ingressGate:     createPassingIngressGate(),
            });

            // This ends with 'image/' but doesn't start with it - should be rejected
            const message = createMockMessage([{ name: 'test.png', contentType: 'data/image/' }]);
            await handler(message);

            // 'data/image/' does not start with 'image/', so inference from .png wins
            expect(coordinator.handleMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    attachments: [expect.objectContaining({ contentType: 'image/png' })],
                }),
                message,
                expect.anything()
            );
        });

        it('should NOT set attachments when size is 0 (test for size === 0 logic)', async () => {
            let contextCaptured: DiscordMessageContext | null = null;
            const mockCoordinator = {
                handleMessage: mock((context: DiscordMessageContext) => {
                    contextCaptured = context;
                }),
            } as unknown as MessageCoordinator;

            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId, coordinator:     mockCoordinator,
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessage([]);
            await handler(message);

            expect(contextCaptured).not.toBeNull();
            // CRITICAL: If attachments.size === 0 is mutated to !== 0, this will fail
            // because the empty array would NOT be excluded
            expect(contextCaptured!.attachments).toBeUndefined();
            expect(Array.isArray(contextCaptured!.attachments)).toBe(false);
        });

        it('should ONLY include attachments when length > 0, not >= 0', async () => {
            let contextCaptured: DiscordMessageContext | null = null;
            const mockCoordinator = {
                handleMessage: mock((context: DiscordMessageContext) => {
                    contextCaptured = context;
                }),
            } as unknown as MessageCoordinator;

            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId, coordinator:     mockCoordinator,
                ingressGate:     createPassingIngressGate(),
            });

            // Test with zero attachments
            const message = createMockMessage([]);
            await handler(message);

            expect(contextCaptured).not.toBeNull();
            // If mutated to >= 0, empty arrays would be included as []
            // But we want undefined for empty
            if(contextCaptured!.attachments !== undefined) {
                throw new Error(`Expected attachments to be undefined, got ${JSON.stringify(contextCaptured!.attachments)}`);
            }
        });

        it('should set attachments in context when length > 0 (kills ConditionalExpression → false)', async () => {
            let contextCaptured: DiscordMessageContext | null = null;
            const mockCoordinator = {
                handleMessage: mock((context: DiscordMessageContext) => {
                    contextCaptured = context;
                }),
            } as unknown as MessageCoordinator;

            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mock(() => true), getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId, coordinator:     mockCoordinator,
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessage([{ name: 'photo.png', contentType: 'image/png' }]);
            await handler(message);

            expect(contextCaptured).not.toBeNull();
            // CRITICAL: If ConditionalExpression mutated to false, attachments would always be undefined
            expect(contextCaptured!.attachments).toBeDefined();
            expect(contextCaptured!.attachments).toHaveLength(1);
            expect(contextCaptured!.attachments![0].filename).toBe('photo.png');
        });
    });

    describe('extractAttachmentMetadata', () => {
        const createMockMessageForExtraction = (
            attachments: { name: string, contentType: string | null }[]
        ): Message => {
            const attachmentCollection = new Map() as Collection<string, Attachment>;
            for(const [index, att] of attachments.entries()) {
                attachmentCollection.set(`att-${index}`, {
                    id:          `att-${index}`,
                    name:        att.name,
                    contentType: att.contentType,
                    url:         `https://cdn.discord.com/attachments/test-${index}`,
                    size:        1024,
                    width:       null,
                    height:      null,
                } as Attachment);
            }

            return {
                id:          'msg-123',
                attachments: attachmentCollection,
            } as unknown as Message;
        };

        it('should return empty array when attachments.size is 0', () => {
            // Mutant 2374: === 0 → !== 0 (would invert logic)
            const message = createMockMessageForExtraction([]);
            const result = extractAttachmentMetadata(message);
            expect(result).toEqual([]);
            expect(result).toHaveLength(0);
        });

        it('does not iterate an empty Discord attachment collection', () => {
            // Discord exposes a Collection at runtime, but only `size` is needed in this branch.
            // Keeping iteration out of the empty case avoids touching an unavailable/lazy iterator.
            const message = {
                attachments: {
                    size:   0,
                    values: () => {
                        throw new Error('empty attachment collection must not be iterated');
                    },
                },
            } as unknown as Message;

            expect(extractAttachmentMetadata(message)).toEqual([]);
        });

        it('should return array with metadata when attachments exist', () => {
            const message = createMockMessageForExtraction([
                { name: 'photo.jpg', contentType: 'image/jpeg' }
            ]);
            const result = extractAttachmentMetadata(message);
            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                filename:    'photo.jpg',
                contentType: 'image/jpeg',
                url:         'https://cdn.discord.com/attachments/test-0',
                size:        1024,
            });
        });

        it('should use actual name when attachment.name is provided', () => {
            // Tests that ?? operator doesn't incorrectly use 'unknown'
            const message = createMockMessageForExtraction([
                { name: 'my-photo.heic', contentType: null }
            ]);
            const result = extractAttachmentMetadata(message);
            expect(result).toHaveLength(1);
            expect(result[0].filename).toBe('my-photo.heic');
            expect(result[0].filename).not.toBe('unknown');
        });

        it('should use actual filename for contentType inference, not "unknown"', () => {
            // Mutant on line 34: attachment.name ?? 'unknown' → attachment.name && 'unknown'
            // If mutated to &&, would always pass 'unknown' to inferImageContentType
            // inferImageContentType('unknown', null) → 'application/octet-stream'
            // inferImageContentType('photo.heic', null) → 'image/heic'
            const message = createMockMessageForExtraction([
                { name: 'photo.heic', contentType: null }
            ]);
            const result = extractAttachmentMetadata(message);
            expect(result).toHaveLength(1);
            expect(result[0].filename).toBe('photo.heic');
            // CRITICAL: contentType should be inferred from actual filename, not 'unknown'
            expect(result[0].contentType).toBe('image/heic');
            expect(result[0].contentType).not.toBe('application/octet-stream');
        });

        it('should map a null height/width to undefined, not 0', () => {
            // Kills llm mutant: attachment.height ?? undefined -> attachment.height ?? 0
            // (attachment.width/height are number | null in discord.js; the helper's mock sets
            // both to null). A fallback of 0 is observably different from undefined: 0 is a
            // meaningful "zero-size" value, whereas undefined means "size unknown".
            const message = createMockMessageForExtraction([
                { name: 'photo.png', contentType: 'image/png' }
            ]);
            const result = extractAttachmentMetadata(message);
            expect(result).toHaveLength(1);
            expect(result[0].height).toBeUndefined();
            expect(result[0].width).toBeUndefined();
        });

        it('should handle multiple attachments', () => {
            const message = createMockMessageForExtraction([
                { name: 'photo1.jpg', contentType: 'image/jpeg' },
                { name: 'photo2.png', contentType: 'image/png' },
                { name: 'doc.pdf', contentType: 'application/pdf' }
            ]);
            const result = extractAttachmentMetadata(message);
            expect(result).toHaveLength(3);
            expect(result[0].filename).toBe('photo1.jpg');
            expect(result[1].filename).toBe('photo2.png');
            expect(result[2].filename).toBe('doc.pdf');
        });

        it('should NOT return empty array when size is not 0', () => {
            // Kill mutant 2374: === 0 → !== 0
            // If mutated, this would return [] for non-empty attachments
            const message = createMockMessageForExtraction([
                { name: 'test.png', contentType: 'image/png' }
            ]);
            const result = extractAttachmentMetadata(message);
            // If mutant survives, this would be []
            expect(result.length).toBeGreaterThan(0);
            expect(result).not.toEqual([]);
        });

        it('should return empty array ONLY when undefined or size 0, not always', () => {
            // Kill mutant 2369: conditional → true
            // If always true, would always return [] even with attachments
            const messageWithAttachments = createMockMessageForExtraction([
                { name: 'test.jpg', contentType: 'image/jpeg' }
            ]);
            const resultWithAttachments = extractAttachmentMetadata(messageWithAttachments);
            expect(resultWithAttachments).not.toEqual([]);
            expect(resultWithAttachments).toHaveLength(1);
        });
    });

    describe('Reply-to-bot detection', () => {
        const botUserId = createUserId('bot-123');
        const monitoredChannelId = createChannelId('channel-456');

        const createMockMessageForReply = (hasReference: boolean, referencedAuthorId: string | null, fetchFails: boolean): Message => {
            const message: Record<string, unknown> = {
                id:     'msg-123',
                author: {
                    id:  'user-789',
                    tag: 'TestUser#1234',
                    bot: false,
                },
                content:      'Test message',
                cleanContent: 'Test message',
                channel:      {
                    id:         monitoredChannelId,
                    isThread:   () => false,
                    sendTyping: mock(async () => {}),
                },
                guild: {
                    id: 'guild-123',
                },
                attachments: new Map(),
                createdAt:   new Date(),
            };

            if(hasReference) {
                message.reference = {
                    messageId: 'referenced-msg-id',
                };

                message.fetchReference = fetchFails
                    ? mock(async () => {
                        throw new Error('Failed to fetch reference');
                    })
                    : mock(async () => ({
                        author: {
                            id: referencedAuthorId,
                        },
                    }));
            } else {
                message.reference = undefined;
            }

            return message as unknown as Message;
        };

        it('should pass isReplyToBot=true to shouldProcess when message references bot message', async () => {
            // Capture shouldProcess arguments to verify isReplyToBot is true
            let shouldProcessArgs: unknown[] = [];
            const mockShouldProcess = mock((...args: unknown[]) => {
                shouldProcessArgs = args;
                return true;
            });

            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mockShouldProcess, getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator:     createMockCoordinator(),
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessageForReply(true, botUserId, false);
            await handler(message);

            // shouldProcess(channelId, isDM, isMention, isReplyToBot)
            expect(mockShouldProcess).toHaveBeenCalled();
            expect(shouldProcessArgs[3]).toBe(true); // isReplyToBot should be true
        });

        it('should pass isReplyToBot=false to shouldProcess when message.reference.messageId is missing', async () => {
            // Capture shouldProcess arguments to verify isReplyToBot is false
            let shouldProcessArgs: unknown[] = [];
            const mockShouldProcess = mock((...args: unknown[]) => {
                shouldProcessArgs = args;
                return true;
            });

            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mockShouldProcess, getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator:     createMockCoordinator(),
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessageForReply(false, null, false);
            const fetchReference = mock(async () => ({ author: { id: botUserId } }));
            Object.defineProperty(message, 'fetchReference', { value: fetchReference });
            await handler(message);

            // shouldProcess(channelId, isDM, isMention, isReplyToBot)
            expect(mockShouldProcess).toHaveBeenCalled();
            expect(shouldProcessArgs[3]).toBe(false); // isReplyToBot should be false
            expect(fetchReference).not.toHaveBeenCalled();
        });

        it('should not call fetchReference when message.reference exists but has no messageId', async () => {
            // Kills llm mutant: message.reference?.messageId -> message.reference
            // (a truthy reference object with no messageId must still short-circuit — otherwise
            // the mutant enters the fetchReference branch on a reference object that Discord
            // itself never sends without a messageId, but a defensive guard should not fire on it)
            let shouldProcessArgs: unknown[] = [];
            const mockShouldProcess = mock((...args: unknown[]) => {
                shouldProcessArgs = args;
                return true;
            });

            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mockShouldProcess, getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator:     createMockCoordinator(),
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessageForReply(false, null, false);
            // A truthy reference object with no messageId (distinct from `reference: undefined`).
            (message as unknown as Record<string, unknown>).reference = {};
            const fetchReference = mock(async () => ({ author: { id: botUserId } }));
            Object.defineProperty(message, 'fetchReference', { value: fetchReference });
            await handler(message);

            expect(mockShouldProcess).toHaveBeenCalled();
            expect(shouldProcessArgs[3]).toBe(false); // isReplyToBot should be false
            expect(fetchReference).not.toHaveBeenCalled();
        });

        it('should pass isReplyToBot=false to shouldProcess when referenced message is from different user', async () => {
            // Capture shouldProcess arguments to verify isReplyToBot is false
            let shouldProcessArgs: unknown[] = [];
            const mockShouldProcess = mock((...args: unknown[]) => {
                shouldProcessArgs = args;
                return true;
            });

            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mockShouldProcess, getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator:     createMockCoordinator(),
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessageForReply(true, 'other-user-id', false);
            await handler(message);

            // shouldProcess(channelId, isDM, isMention, isReplyToBot)
            expect(mockShouldProcess).toHaveBeenCalled();
            expect(shouldProcessArgs[3]).toBe(false); // isReplyToBot should be false
        });

        it('should pass isReplyToBot=false to shouldProcess when fetchReference throws', async () => {
            // Capture shouldProcess arguments to verify isReplyToBot is false
            let shouldProcessArgs: unknown[] = [];
            const mockShouldProcess = mock((...args: unknown[]) => {
                shouldProcessArgs = args;
                return true;
            });

            const handler = createMessageHandler({
                channelRegistry: { shouldProcess: mockShouldProcess, getChannel: mock(() => null), warmCache: mock(() => Promise.resolve()) } as unknown as ChannelRegistryManager,
                botUserId,
                coordinator:     createMockCoordinator(),
                ingressGate:     createPassingIngressGate(),
            });

            const message = createMockMessageForReply(true, botUserId, true);
            await handler(message);

            // shouldProcess(channelId, isDM, isMention, isReplyToBot)
            expect(mockShouldProcess).toHaveBeenCalled();
            expect(shouldProcessArgs[3]).toBe(false); // isReplyToBot should be false after error
        });
    });
});

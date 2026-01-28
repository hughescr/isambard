import { describe, it, expect, beforeEach, mock } from 'bun:test';
import _ from 'lodash';
import type { Client, Message, Collection, Attachment } from 'discord.js';
import { mockLogger } from '../../../setup';
import {
    createReadyHandler,
    createErrorHandler,
    createMessageHandler,
    extractAttachmentMetadata
} from '@/integrations/discord/handlers';
import { createChannelId, createUserId } from '@/integrations/discord/types';
import type { DiscordMessageContext } from '@/integrations/discord/types';

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
            const lastCall = mockLogger.info.mock.calls[mockLogger.info.mock.calls.length - 1] as unknown[];
            const message = lastCall[0] as string;
            expect(message.includes('TestBot#1234')).toBe(true);
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
            const logMessage = (mockLogger.info.mock.calls[0] as unknown[])[0] as string;
            // eslint-disable-next-line lodash/prefer-lodash-method -- Simple string check
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
            const lastCall = mockLogger.info.mock.calls[mockLogger.info.mock.calls.length - 1] as unknown[];
            expect((lastCall[0] as string).includes('not available')).toBe(true);
        });
    });

    describe('createErrorHandler', () => {
        it('should log error when error event fires', () => {
            const handler = createErrorHandler();

            const testError = new Error('Test error message');
            handler(testError);

            expect(mockLogger.error).toHaveBeenCalled();
            const firstCall = mockLogger.error.mock.calls[mockLogger.error.mock.calls.length - 1] as unknown[];
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
            const lastCall = mockLogger.error.mock.calls[mockLogger.error.mock.calls.length - 1] as unknown[];
            // logger.error({ error, msg }) - single object with error and msg properties
            const loggedObject = lastCall[0] as { error: Error, msg: string };
            expect(loggedObject).toHaveProperty('error', testError);
            // eslint-disable-next-line lodash/prefer-lodash-method -- Simple string check
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

        const createMockMessage = (attachments: { name: string | null, contentType: string | null }[]): Message => {
            const attachmentCollection = new Map() as Collection<string, Attachment>;

            // eslint-disable-next-line lodash/prefer-lodash-method -- forEach needed for Map.set side effect
            attachments.forEach((att, index) => {
                attachmentCollection.set(`att-${index}`, {
                    id:          `att-${index}`,
                    name:        att.name,
                    contentType: att.contentType,
                    url:         `https://cdn.discord.com/attachments/test-${index}`,
                    size:        1024,
                    width:       null,
                    height:      null,
                } as Attachment);
            });

            return {
                id:     'msg-123',
                author: {
                    id:  'user-789',
                    tag: 'TestUser#1234',
                    bot: false,
                },
                content: 'Test message',
                channel: {
                    id:         monitoredChannelId,
                    // Stryker disable next-line all: Mock function for testing only
                    sendTyping: mock(async () => { return; }),
                },
                guild: {
                    id: 'guild-123',
                },
                attachments: attachmentCollection,
                createdAt:   new Date(),
            } as unknown as Message;
        };

        it('should infer image/heic for .heic files with null contentType', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(1);
                expect(context.attachments![0].contentType).toBe('image/heic');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'photo.heic', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should infer image/heif for .heif files with null contentType', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(1);
                expect(context.attachments![0].contentType).toBe('image/heif');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'photo.heif', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should infer image/jpeg for .jpg files with null contentType', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(1);
                expect(context.attachments![0].contentType).toBe('image/jpeg');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'photo.jpg', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should infer image/png for .png files with null contentType', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(1);
                expect(context.attachments![0].contentType).toBe('image/png');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'image.png', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should fallback to application/octet-stream for unknown extensions with null contentType', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(1);
                expect(context.attachments![0].contentType).toBe('application/octet-stream');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'file.xyz', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should use provided contentType when Discord provides a valid image type', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(1);
                expect(context.attachments![0].contentType).toBe('image/webp');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'photo.heic', contentType: 'image/webp' }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should infer from extension when Discord provides application/octet-stream', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(1);
                expect(context.attachments![0].contentType).toBe('image/heic');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'photo.heic', contentType: 'application/octet-stream' }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should handle case-insensitive file extensions', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(1);
                expect(context.attachments![0].contentType).toBe('image/heic');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'photo.HEIC', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should reject contentType that ends with image/ instead of starting with it', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(1);
                // Should fallback to extension inference, not use invalid contentType
                expect(context.attachments![0].contentType).toBe('image/png');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            // Discord provides invalid contentType 'text/image/' - should be ignored
            const message = createMockMessage([{ name: 'photo.png', contentType: 'text/image/' }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should prefer Discord contentType over extension when valid image type provided', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(1);
                // Discord says image/png for .txt file - should trust Discord
                expect(context.attachments![0].contentType).toBe('image/png');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'file.txt', contentType: 'image/png' }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should return exact image/heic string for .heic extension', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments![0].contentType).toBe('image/heic');
                // Verify exact string, not just truthy
                expect(context.attachments![0].contentType === 'image/heic').toBe(true);
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'photo.heic', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should return exact image/jpeg string for .jpg extension', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments![0].contentType).toBe('image/jpeg');
                // Verify exact string, not just truthy
                expect(context.attachments![0].contentType === 'image/jpeg').toBe(true);
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'photo.jpg', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should return exact image/png string for .png extension', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments![0].contentType).toBe('image/png');
                // Verify exact string, not just truthy
                expect(context.attachments![0].contentType === 'image/png').toBe(true);
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'image.png', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should return exact application/octet-stream string for unknown extension', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments![0].contentType).toBe('application/octet-stream');
                // Verify exact string, not just truthy
                expect(context.attachments![0].contentType === 'application/octet-stream').toBe(true);
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'file.xyz', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should handle file without extension and return octet-stream', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments![0].contentType).toBe('application/octet-stream');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'README', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should use filename "unknown" when attachment name is null', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(1);
                expect(context.attachments![0].filename).toBe('unknown');
                // Verify exact string match
                expect(context.attachments![0].filename === 'unknown').toBe(true);
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: null, contentType: 'image/png' }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should use actual filename when attachment name is provided', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(1);
                expect(context.attachments![0].filename).toBe('my-photo.jpg');
                // Verify NOT "unknown"
                expect(context.attachments![0].filename === 'unknown').toBe(false);
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'my-photo.jpg', contentType: 'image/jpeg' }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should include attachments in context when present', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                // Kill mutant 2454: attachments.length > 0 ? attachments : undefined → false ? ...
                // If conditional is always false, attachments would ALWAYS be undefined
                expect(context.attachments).toBeDefined();
                expect(context.attachments).toHaveLength(2);
                expect(_.isArray(context.attachments)).toBe(true);
                expect(context.attachments).not.toBeUndefined();
                // This will throw if attachments is undefined (accessing undefined[0])
                const firstAttachment = context.attachments![0];
                expect(firstAttachment).toBeDefined();
                expect(firstAttachment.filename).toBeDefined();
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([
                { name: 'photo1.png', contentType: 'image/png' },
                { name: 'photo2.jpg', contentType: 'image/jpeg' }
            ]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should NOT include attachments in context when empty', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                // Verify attachments is undefined, not an empty array
                expect(context.attachments).toBeUndefined();
                expect(context.attachments === undefined).toBe(true);
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should verify startsWith not endsWith for image/ prefix', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                // If using endsWith, 'something/image/' would match - verify it doesn't
                expect(context.attachments![0].contentType).toBe('image/png');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            // This ends with 'image/' but doesn't start with it - should be rejected
            const message = createMockMessage([{ name: 'test.png', contentType: 'data/image/' }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should return non-empty string for heic contentType', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                const contentType = context.attachments![0].contentType;
                // Verify NOT empty string
                expect(contentType).not.toBe('');
                expect(contentType.length).toBeGreaterThan(0);
                expect(contentType).toBe('image/heic');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'photo.heic', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should return non-empty string for heif contentType', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                const contentType = context.attachments![0].contentType;
                expect(contentType).not.toBe('');
                expect(contentType.length).toBeGreaterThan(0);
                expect(contentType).toBe('image/heif');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'photo.heif', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should return non-empty string for jpeg contentType', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                const contentType = context.attachments![0].contentType;
                expect(contentType).not.toBe('');
                expect(contentType.length).toBeGreaterThan(0);
                expect(contentType).toBe('image/jpeg');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'photo.jpeg', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should return non-empty string for png contentType', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                const contentType = context.attachments![0].contentType;
                expect(contentType).not.toBe('');
                expect(contentType.length).toBeGreaterThan(0);
                expect(contentType).toBe('image/png');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'image.png', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should return non-empty string for gif contentType', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                const contentType = context.attachments![0].contentType;
                expect(contentType).not.toBe('');
                expect(contentType.length).toBeGreaterThan(0);
                expect(contentType).toBe('image/gif');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'animation.gif', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should return non-empty string for webp contentType', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                const contentType = context.attachments![0].contentType;
                expect(contentType).not.toBe('');
                expect(contentType.length).toBeGreaterThan(0);
                expect(contentType).toBe('image/webp');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'photo.webp', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should return non-empty string for unknown filename', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                const filename = context.attachments![0].filename;
                expect(filename).not.toBe('');
                expect(filename.length).toBeGreaterThan(0);
                expect(filename).toBe('unknown');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: null, contentType: 'image/png' }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should return non-empty string for octet-stream', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                const contentType = context.attachments![0].contentType;
                expect(contentType).not.toBe('');
                expect(contentType.length).toBeGreaterThan(0);
                expect(contentType).toBe('application/octet-stream');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([{ name: 'file.unknown', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });

        it('should NOT set attachments when size is 0 (test for size === 0 logic)', async () => {
            let contextCaptured: DiscordMessageContext | null = null;
            const onMessage = mock(async (context: DiscordMessageContext) => {
                contextCaptured = context;
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            const message = createMockMessage([]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
            expect(contextCaptured).not.toBeNull();
            // CRITICAL: If attachments.size === 0 is mutated to !== 0, this will fail
            // because the empty array would NOT be excluded
            expect(contextCaptured!.attachments).toBeUndefined();
            expect(_.isArray(contextCaptured!.attachments)).toBe(false);
        });

        it('should ONLY include attachments when length > 0, not >= 0', async () => {
            let contextCaptured: DiscordMessageContext | null = null;
            const onMessage = mock(async (context: DiscordMessageContext) => {
                contextCaptured = context;
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            // Test with zero attachments
            const message = createMockMessage([]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
            expect(contextCaptured).not.toBeNull();
            // If mutated to >= 0, empty arrays would be included as []
            // But we want undefined for empty
            if(contextCaptured!.attachments !== undefined) {
                throw new Error(`Expected attachments to be undefined, got ${JSON.stringify(contextCaptured!.attachments)}`);
            }
        });

        it('should handle null Discord contentType correctly (test always-true conditional)', async () => {
            const onMessage = mock(async (context: DiscordMessageContext) => {
                expect(context.attachments).toBeDefined();
                // If conditional is always true, would use null contentType causing error
                // Should fallback to extension inference
                expect(context.attachments![0].contentType).toBe('image/png');
                return null;
            });

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
            });

            // Discord provides null contentType
            const message = createMockMessage([{ name: 'test.png', contentType: null }]);
            await handler(message);

            expect(onMessage).toHaveBeenCalled();
        });
    });

    describe('Catch-up interruption handling', () => {
        const botUserId = createUserId('bot-123');
        const monitoredChannelId = createChannelId('channel-456');

        const createMockMessageForCatchUp = (): Message => {
            return {
                id:     'msg-123',
                author: {
                    id:  'user-789',
                    tag: 'TestUser#1234',
                    bot: false,
                },
                content: 'Test message',
                channel: {
                    id:         monitoredChannelId,
                    // Stryker disable next-line all: Mock function for testing only
                    sendTyping: mock(async () => { return; }),
                },
                guild: {
                    id: 'guild-123',
                },
                attachments: new Map(),
                createdAt:   new Date(),
            } as unknown as Message;
        };

        it('should call handleCatchUpInterruption when state is catching_up and runner exists', async () => {
            const mockBotStateManager = {
                getMode: mock(_.constant('catching_up' as const)),
            };

            const mockCatchUpSessionRunner = {
                interrupt: mock(async () => { /* intentionally empty */ }),
            };

            const mockPresenceManager = {
                // Stryker disable next-line all: Mock functions for testing only
                setPhase:              mock(() => _.noop()),
                // Stryker disable next-line all: Mock functions for testing only
                transitionCatchUpMode: mock(() => _.noop()),
            };

            const onMessage = mock(_.constant(Promise.resolve(null)));

            const handler = createMessageHandler({
                monitoredChannelIds:  [monitoredChannelId],
                botUserId,
                onMessage,
                catchUpSessionRunner: mockCatchUpSessionRunner as unknown as import('@/integrations/discord/catchup').CatchUpSessionRunner,
                presenceManager:      mockPresenceManager as unknown as import('@/integrations/discord/presence').PresenceManager,
                botStateManager:      mockBotStateManager as unknown as import('@/integrations/discord/state').BotStateManager,
            });

            const message = createMockMessageForCatchUp();
            await handler(message);

            // Verify handleCatchUpInterruption was called (which calls interrupt)
            expect(mockCatchUpSessionRunner.interrupt).toHaveBeenCalled();
        });

        it('should NOT call handleCatchUpInterruption when state is NOT catching_up', async () => {
            const mockBotStateManager = {
                getMode:                mock(_.constant('idle' as const)),
                startProcessingMessage: mock(() => _.noop()),
            };

            const mockCatchUpSessionRunner = {
                interrupt: mock(async () => { /* intentionally empty */ }),
            };

            const mockPresenceManager = {
                // Stryker disable next-line all: Mock functions for testing only
                setPhase:              mock(() => _.noop()),
                // Stryker disable next-line all: Mock functions for testing only
                transitionCatchUpMode: mock(() => _.noop()),
            };

            const onMessage = mock(_.constant(Promise.resolve(null)));

            const handler = createMessageHandler({
                monitoredChannelIds:  [monitoredChannelId],
                botUserId,
                onMessage,
                catchUpSessionRunner: mockCatchUpSessionRunner as unknown as import('@/integrations/discord/catchup').CatchUpSessionRunner,
                presenceManager:      mockPresenceManager as unknown as import('@/integrations/discord/presence').PresenceManager,
                botStateManager:      mockBotStateManager as unknown as import('@/integrations/discord/state').BotStateManager,
            });

            const message = createMockMessageForCatchUp();
            await handler(message);

            // Verify handleCatchUpInterruption was NOT called
            expect(mockCatchUpSessionRunner.interrupt).not.toHaveBeenCalled();
        });

        it('should NOT call handleCatchUpInterruption when catchUpSessionRunner is undefined', async () => {
            const mockPresenceManager = {
                // Stryker disable next-line all: Mock functions for testing only
                setPhase:              mock(() => _.noop()),
                // Stryker disable next-line all: Mock functions for testing only
                transitionCatchUpMode: mock(() => _.noop()),
            };

            const mockBotStateManager = {
                getMode:                mock(_.constant('idle' as const)),
                startProcessingMessage: mock(() => _.noop()),
            };

            const onMessage = mock(_.constant(Promise.resolve(null)));

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
                // catchUpSessionRunner is undefined
                presenceManager:     mockPresenceManager as unknown as import('@/integrations/discord/presence').PresenceManager,
                botStateManager:     mockBotStateManager as unknown as import('@/integrations/discord/state').BotStateManager,
            });

            const message = createMockMessageForCatchUp();
            // Should not throw
            await handler(message);

            // No exception should be thrown when catchUpSessionRunner is undefined
            expect(onMessage).toHaveBeenCalled();
        });
    });

    describe('State manager idle mode transition', () => {
        const botUserId = createUserId('bot-123');
        const monitoredChannelId = createChannelId('channel-456');

        const createMockMessageForState = (): Message => {
            return {
                id:     'msg-123',
                author: {
                    id:  'user-789',
                    tag: 'TestUser#1234',
                    bot: false,
                },
                content: 'Test message content',
                channel: {
                    id:         monitoredChannelId,
                    // Stryker disable next-line all: Mock function for testing only
                    sendTyping: mock(async () => { return; }),
                },
                guild: {
                    id: 'guild-123',
                },
                attachments: new Map(),
                createdAt:   new Date(),
            } as unknown as Message;
        };

        it('should call startProcessingMessage when bot state is idle', async () => {
            const mockBotStateManager = {
                getMode:                mock(_.constant('idle' as const)),
                startProcessingMessage: mock(() => _.noop()),
            };

            const onMessage = mock(_.constant(Promise.resolve(null)));

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
                botStateManager:     mockBotStateManager as unknown as import('@/integrations/discord/state').BotStateManager,
            });

            const message = createMockMessageForState();
            await handler(message);

            // Verify startProcessingMessage was called when mode is idle
            expect(mockBotStateManager.startProcessingMessage).toHaveBeenCalled();
            expect(mockBotStateManager.startProcessingMessage).toHaveBeenCalledWith(
                monitoredChannelId,
                'Test message content'
            );
        });

        it('should NOT call startProcessingMessage when bot state is not idle', async () => {
            const mockBotStateManager = {
                getMode:                mock(_.constant('processing_message' as const)),
                startProcessingMessage: mock(() => _.noop()),
            };

            const onMessage = mock(_.constant(Promise.resolve(null)));

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
                botStateManager:     mockBotStateManager as unknown as import('@/integrations/discord/state').BotStateManager,
            });

            const message = createMockMessageForState();
            await handler(message);

            // Verify startProcessingMessage was NOT called when mode is not idle
            expect(mockBotStateManager.startProcessingMessage).not.toHaveBeenCalled();
        });

        it('should NOT call startProcessingMessage when bot state is catching_up', async () => {
            const mockBotStateManager = {
                getMode:                mock(_.constant('catching_up' as const)),
                startProcessingMessage: mock(() => _.noop()),
            };

            const onMessage = mock(_.constant(Promise.resolve(null)));

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
                botStateManager:     mockBotStateManager as unknown as import('@/integrations/discord/state').BotStateManager,
            });

            const message = createMockMessageForState();
            await handler(message);

            // Verify startProcessingMessage was NOT called when mode is catching_up
            expect(mockBotStateManager.startProcessingMessage).not.toHaveBeenCalled();
        });

        it('should handle undefined botStateManager gracefully', async () => {
            const onMessage = mock(_.constant(Promise.resolve(null)));

            const handler = createMessageHandler({
                monitoredChannelIds: [monitoredChannelId],
                botUserId,
                onMessage,
                // botStateManager is undefined
            });

            const message = createMockMessageForState();
            // Should not throw when botStateManager is undefined
            await handler(message);
            expect(onMessage).toHaveBeenCalled();
        });
    });

    describe('extractAttachmentMetadata', () => {
        const createMockMessageForExtraction = (
            attachments: { name: string | null, contentType: string | null }[] | null | undefined
        ): Message => {
            let attachmentCollection: Collection<string, Attachment> | undefined;

            if(attachments !== null && attachments !== undefined) {
                attachmentCollection = new Map() as Collection<string, Attachment>;
                // eslint-disable-next-line lodash/prefer-lodash-method -- forEach needed for Map.set side effect
                attachments.forEach((att, index) => {
                    attachmentCollection!.set(`att-${index}`, {
                        id:          `att-${index}`,
                        name:        att.name,
                        contentType: att.contentType,
                        url:         `https://cdn.discord.com/attachments/test-${index}`,
                        size:        1024,
                        width:       null,
                        height:      null,
                    } as Attachment);
                });
            }

            return {
                id:          'msg-123',
                attachments: attachmentCollection,
            } as unknown as Message;
        };

        it('should return empty array when attachments is undefined', () => {
            // Mutant 2373: conditional → false (would try to access undefined.size and throw)
            const message = createMockMessageForExtraction(null);
            // Should not throw when attachments is undefined
            expect(() => extractAttachmentMetadata(message)).not.toThrow();
            const result = extractAttachmentMetadata(message);
            expect(result).toEqual([]);
            expect(result).toHaveLength(0);
            expect(_.isArray(result)).toBe(true);
        });

        it('should return empty array when attachments.size is 0', () => {
            // Mutant 2374: === 0 → !== 0 (would invert logic)
            const message = createMockMessageForExtraction([]);
            const result = extractAttachmentMetadata(message);
            expect(result).toEqual([]);
            expect(result).toHaveLength(0);
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

        it('should use "unknown" when attachment.name is null', () => {
            // Mutants 2379-2382: attachment.name ?? 'unknown' mutations
            // Line 33: filename uses 'unknown'
            // Line 34: contentType inference uses 'unknown'
            const message = createMockMessageForExtraction([
                { name: null, contentType: 'image/png' }
            ]);
            const result = extractAttachmentMetadata(message);
            expect(result).toHaveLength(1);
            expect(result[0].filename).toBe('unknown');
            // Verify exact string match
            expect(result[0].filename === 'unknown').toBe(true);
            // ContentType should use Discord's value (image/png)
            expect(result[0].contentType).toBe('image/png');
        });

        it('should pass "unknown" to inferImageContentType when name is null', () => {
            // Mutant 2382 specifically targets line 34: attachment.name ?? 'unknown' in contentType
            // If mutated to '', empty filename would be treated differently
            // Create scenario where filename matters for content type inference
            const message = createMockMessageForExtraction([
                { name: null, contentType: null }
            ]);
            const result = extractAttachmentMetadata(message);
            expect(result).toHaveLength(1);
            // inferImageContentType('unknown', null) → 'application/octet-stream'
            // inferImageContentType('', null) → 'application/octet-stream' (SAME!)
            // This mutant requires checking that 'unknown' filename is used in the call
            expect(result[0].filename).toBe('unknown');
            expect(result[0].contentType).toBe('application/octet-stream');
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

        it('should handle multiple attachments', () => {
            const message = createMockMessageForExtraction([
                { name: 'photo1.jpg', contentType: 'image/jpeg' },
                { name: null, contentType: 'image/png' },
                { name: 'doc.pdf', contentType: 'application/pdf' }
            ]);
            const result = extractAttachmentMetadata(message);
            expect(result).toHaveLength(3);
            expect(result[0].filename).toBe('photo1.jpg');
            expect(result[1].filename).toBe('unknown');
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

        it('should return empty array when condition is true, not continue', () => {
            // Kill mutant 2373: conditional → false
            // If always false, would not return [] for undefined/empty
            const messageUndefined = createMockMessageForExtraction(null);
            const messageEmpty = createMockMessageForExtraction([]);

            const resultUndefined = extractAttachmentMetadata(messageUndefined);
            const resultEmpty = extractAttachmentMetadata(messageEmpty);

            expect(resultUndefined).toEqual([]);
            expect(resultEmpty).toEqual([]);
        });
    });
});

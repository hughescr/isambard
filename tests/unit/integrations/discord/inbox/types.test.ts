import { describe, test, expect } from 'bun:test';
import repeat from 'lodash/repeat';
import {
    discordChannelCheckpointSchema,
    unreadMessageSchema,
    channelSummarySchema,
    messageMetadataSchema,
    channelSummaryResponseSchema,
    unreadOverviewSchema
} from '@/integrations/discord/inbox/types';
import { createChannelId, createGuildId } from '@/integrations/discord/types';

describe.concurrent('discordChannelCheckpointSchema', () => {
    const validCheckpoint = {
        service:           'discord' as const,
        channelId:         createChannelId('123456789'),
        guildId:           createGuildId('987654321'),
        lastSeenAt:        '2025-01-24T10:00:00.000Z',
        lastSeenMessageId: '111222333',
        updatedAt:         '2025-01-24T10:00:00.000Z',
    };

    test('should accept valid checkpoint with all fields', () => {
        const result = discordChannelCheckpointSchema.safeParse(validCheckpoint);
        expect(result.success).toBe(true);
    });

    test('should accept checkpoint without optional lastSeenMessageId', () => {
        const { lastSeenMessageId: _lastSeenMessageId, ...checkpointWithoutMessage } = validCheckpoint;
        const result = discordChannelCheckpointSchema.safeParse(checkpointWithoutMessage);
        expect(result.success).toBe(true);
    });

    test('should accept DM as guildId', () => {
        const dmCheckpoint = { ...validCheckpoint, guildId: 'DM' };
        const result = discordChannelCheckpointSchema.safeParse(dmCheckpoint);
        expect(result.success).toBe(true);
    });

    test('should reject invalid service literal', () => {
        const invalid = { ...validCheckpoint, service: 'slack' };
        const result = discordChannelCheckpointSchema.safeParse(invalid);
        expect(result.success).toBe(false);
    });

    test('should reject invalid datetime format for lastSeenAt', () => {
        const invalid = { ...validCheckpoint, lastSeenAt: 'not-a-datetime' };
        const result = discordChannelCheckpointSchema.safeParse(invalid);
        expect(result.success).toBe(false);
    });

    test('should reject invalid datetime format for updatedAt', () => {
        const invalid = { ...validCheckpoint, updatedAt: 'invalid-date' };
        const result = discordChannelCheckpointSchema.safeParse(invalid);
        expect(result.success).toBe(false);
    });

    test('should reject missing required field', () => {
        const { channelId: _channelId, ...missingChannelId } = validCheckpoint;
        const result = discordChannelCheckpointSchema.safeParse(missingChannelId);
        expect(result.success).toBe(false);
    });
});

describe.concurrent('unreadMessageSchema', () => {
    const validMessage = {
        id:          '123456789',
        channelId:   createChannelId('987654321'),
        channelName: 'general',
        guildId:     createGuildId('111222333'),
        author:      'TestUser',
        content:     'Hello, world!',
        timestamp:   '2025-01-24T10:00:00.000Z',
        isRead:      false,
    };

    test('should accept valid unread message', () => {
        const result = unreadMessageSchema.safeParse(validMessage);
        expect(result.success).toBe(true);
    });

    test('should accept DM as guildId', () => {
        const dmMessage = { ...validMessage, guildId: 'DM' };
        const result = unreadMessageSchema.safeParse(dmMessage);
        expect(result.success).toBe(true);
    });

    test('should accept empty content string', () => {
        const emptyContent = { ...validMessage, content: '' };
        const result = unreadMessageSchema.safeParse(emptyContent);
        expect(result.success).toBe(true);
    });

    test('should reject empty channelName', () => {
        const invalid = { ...validMessage, channelName: '' };
        const result = unreadMessageSchema.safeParse(invalid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Channel name cannot be empty');
        }
    });

    test('should reject empty author', () => {
        const invalid = { ...validMessage, author: '' };
        const result = unreadMessageSchema.safeParse(invalid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Author cannot be empty');
        }
    });

    test('should reject invalid timestamp format', () => {
        const invalid = { ...validMessage, timestamp: 'not-a-date' };
        const result = unreadMessageSchema.safeParse(invalid);
        expect(result.success).toBe(false);
    });

    test('should reject non-boolean isRead', () => {
        const invalid = { ...validMessage, isRead: 'true' };
        const result = unreadMessageSchema.safeParse(invalid);
        expect(result.success).toBe(false);
    });
});

describe.concurrent('channelSummarySchema', () => {
    const validSummary = {
        channelId:    createChannelId('123456789'),
        channelName:  'general',
        messageCount: 5,
        authors:      ['Alice', 'Bob'],
        timeRange:    {
            start: '2025-01-24T09:00:00.000Z',
            end:   '2025-01-24T10:00:00.000Z',
        },
        preview: 'First message preview...',
    };

    test('should accept valid channel summary', () => {
        const result = channelSummarySchema.safeParse(validSummary);
        expect(result.success).toBe(true);
    });

    test('should accept preview at exactly 100 characters', () => {
        const maxPreview = { ...validSummary, preview: repeat('a', 100) };
        const result = channelSummarySchema.safeParse(maxPreview);
        expect(result.success).toBe(true);
    });

    test('should reject preview over 100 characters', () => {
        const invalid = { ...validSummary, preview: repeat('a', 101) };
        const result = channelSummarySchema.safeParse(invalid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Preview must not exceed 100 characters');
        }
    });

    test('should reject zero message count', () => {
        const invalid = { ...validSummary, messageCount: 0 };
        const result = channelSummarySchema.safeParse(invalid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Message count must be positive');
        }
    });

    test('should reject negative message count', () => {
        const invalid = { ...validSummary, messageCount: -1 };
        const result = channelSummarySchema.safeParse(invalid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Message count must be positive');
        }
    });

    test('should reject empty author array item', () => {
        const invalid = { ...validSummary, authors: ['Alice', ''] };
        const result = channelSummarySchema.safeParse(invalid);
        expect(result.success).toBe(false);
    });

    test('should reject invalid timeRange start format', () => {
        const invalid = { ...validSummary, timeRange: { start: 'invalid', end: '2025-01-24T10:00:00.000Z' } };
        const result = channelSummarySchema.safeParse(invalid);
        expect(result.success).toBe(false);
    });

    test('should reject invalid timeRange end format', () => {
        const invalid = { ...validSummary, timeRange: { start: '2025-01-24T09:00:00.000Z', end: 'invalid' } };
        const result = channelSummarySchema.safeParse(invalid);
        expect(result.success).toBe(false);
    });
});

describe.concurrent('messageMetadataSchema', () => {
    const validMetadata = {
        id:        '123456789',
        author:    'TestUser',
        timestamp: '2025-01-24T10:00:00.000Z',
        sizeChars: 100,
    };

    test('should accept valid message metadata', () => {
        const result = messageMetadataSchema.safeParse(validMetadata);
        expect(result.success).toBe(true);
    });

    test('should accept zero size', () => {
        const zeroSize = { ...validMetadata, sizeChars: 0 };
        const result = messageMetadataSchema.safeParse(zeroSize);
        expect(result.success).toBe(true);
    });

    test('should reject negative size', () => {
        const invalid = { ...validMetadata, sizeChars: -1 };
        const result = messageMetadataSchema.safeParse(invalid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Size cannot be negative');
        }
    });

    test('should reject empty author', () => {
        const invalid = { ...validMetadata, author: '' };
        const result = messageMetadataSchema.safeParse(invalid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Author cannot be empty');
        }
    });

    test('should reject invalid timestamp', () => {
        const invalid = { ...validMetadata, timestamp: 'not-a-date' };
        const result = messageMetadataSchema.safeParse(invalid);
        expect(result.success).toBe(false);
    });
});

describe.concurrent('channelSummaryResponseSchema', () => {
    const validResponse = {
        channelId:    createChannelId('123456789'),
        channelName:  'general',
        messageCount: 5,
        summary:      'Discussion about project updates',
        authors:      ['Alice', 'Bob'],
        timeRange:    {
            start: '2025-01-24T09:00:00.000Z',
            end:   '2025-01-24T10:00:00.000Z',
        },
        messages: [
            {
                id:        '111',
                author:    'Alice',
                timestamp: '2025-01-24T09:00:00.000Z',
                sizeChars: 50,
            },
        ],
    };

    test('should accept valid channel summary response', () => {
        const result = channelSummaryResponseSchema.safeParse(validResponse);
        expect(result.success).toBe(true);
    });

    test('should accept zero message count', () => {
        const zeroCount = { ...validResponse, messageCount: 0, messages: [] };
        const result = channelSummaryResponseSchema.safeParse(zeroCount);
        expect(result.success).toBe(true);
    });

    test('should reject negative message count', () => {
        const invalid = { ...validResponse, messageCount: -1 };
        const result = channelSummaryResponseSchema.safeParse(invalid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Message count cannot be negative');
        }
    });

    test('should reject empty summary', () => {
        const invalid = { ...validResponse, summary: '' };
        const result = channelSummaryResponseSchema.safeParse(invalid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Summary cannot be empty');
        }
    });

    test('should accept empty messages array', () => {
        const emptyMessages = { ...validResponse, messages: [] };
        const result = channelSummaryResponseSchema.safeParse(emptyMessages);
        expect(result.success).toBe(true);
    });

    test('should reject invalid message metadata in array', () => {
        const invalid = {
            ...validResponse,
            messages: [{ id: '111', author: '', timestamp: '2025-01-24T09:00:00.000Z', sizeChars: 50 }],
        };
        const result = channelSummaryResponseSchema.safeParse(invalid);
        expect(result.success).toBe(false);
    });
});

describe.concurrent('unreadOverviewSchema', () => {
    const validOverview = {
        totalUnread: 10,
        channels:    [
            {
                channelId:    createChannelId('123456789'),
                channelName:  'general',
                messageCount: 5,
            },
            {
                channelId:    createChannelId('987654321'),
                channelName:  'random',
                messageCount: 5,
            },
        ],
    };

    test('should accept valid unread overview', () => {
        const result = unreadOverviewSchema.safeParse(validOverview);
        expect(result.success).toBe(true);
    });

    test('should accept zero total unread', () => {
        const zeroUnread = { totalUnread: 0, channels: [] };
        const result = unreadOverviewSchema.safeParse(zeroUnread);
        expect(result.success).toBe(true);
    });

    test('should reject negative total unread', () => {
        const invalid = { ...validOverview, totalUnread: -1 };
        const result = unreadOverviewSchema.safeParse(invalid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Total unread cannot be negative');
        }
    });

    test('should accept empty channels array', () => {
        const emptyChannels = { totalUnread: 0, channels: [] };
        const result = unreadOverviewSchema.safeParse(emptyChannels);
        expect(result.success).toBe(true);
    });

    test('should reject channel with empty name', () => {
        const invalid = {
            totalUnread: 5,
            channels:    [
                {
                    channelId:    createChannelId('123456789'),
                    channelName:  '',
                    messageCount: 5,
                },
            ],
        };
        const result = unreadOverviewSchema.safeParse(invalid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Channel name cannot be empty');
        }
    });

    test('should reject channel with negative message count', () => {
        const invalid = {
            totalUnread: 5,
            channels:    [
                {
                    channelId:    createChannelId('123456789'),
                    channelName:  'general',
                    messageCount: -1,
                },
            ],
        };
        const result = unreadOverviewSchema.safeParse(invalid);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toContain('Message count cannot be negative');
        }
    });
});

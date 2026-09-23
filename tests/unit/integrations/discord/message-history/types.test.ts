import { describe, test, expect } from 'bun:test';
import {
    discordAuthorSchema,
    discordAttachmentSchema,
    discordEmbedSchema,
    discordReactionSchema,
    discordSearchResultSchema,
    batchOverflowSummarySchema,
    searchResponseSchema,
    searchParamsSchema,
    type DiscordAuthor,
    type DiscordAttachment,
    type DiscordEmbed,
    type DiscordReaction
} from '@/integrations/discord/message-history/types';

describe('message-history schema metadata', () => {
    test.each([
        [discordAuthorSchema, 'Author information from a Discord message'],
        [discordAttachmentSchema, 'File attachment from a Discord message'],
        [discordEmbedSchema, 'Rich embed content from a Discord message'],
        [discordReactionSchema, 'Reaction emoji with count from a Discord message'],
        [discordSearchResultSchema, 'Full Discord message data from search results'],
        [batchOverflowSummarySchema, 'Batch summary grouping multiple overflow messages'],
        [searchResponseSchema, 'Complete search response with messages and metadata'],
        [searchParamsSchema, 'Parameters for searching Discord message history'],
    ])('preserves the public description %s', (schema, description) => { expect(schema.description).toBe(description); });
});

describe('message-history validation messages', () => {
    test.each([
        [discordAuthorSchema.shape.id, '', 'Author ID cannot be empty'], [discordAuthorSchema.shape.username, '', 'Username cannot be empty'], [discordAuthorSchema.shape.displayName, '', 'Display name cannot be empty'], [discordAttachmentSchema.shape.url, 'not a URL', 'URL must be a valid URL'], [discordAttachmentSchema.shape.filename, '', 'Filename cannot be empty'], [discordEmbedSchema.shape.url.unwrap(), 'not a URL', 'URL must be a valid URL'], [discordReactionSchema.shape.emoji, '', 'Emoji cannot be empty'], [discordReactionSchema.shape.count, 0, 'Count must be a positive integer'], [discordSearchResultSchema.shape.id, '', 'Message ID cannot be empty'], [batchOverflowSummarySchema.shape.synopsis, '', 'Synopsis cannot be empty'], [searchResponseSchema.shape.overflow.unwrap().shape.count, -1, 'Count cannot be negative'],
    ])('reports %s', (schema, input, message) => {
        const result = schema.safeParse(input);
        expect(result.success).toBe(false);
        if(!result.success) {
            expect(result.error.issues[0]?.message).toBe(message);
        }
    });
});

describe.concurrent('discordAuthorSchema', () => {
    const validAuthor: DiscordAuthor = {
        id:          '123456789012345678',
        username:    'testuser',
        displayName: 'Test User',
    };

    test('should accept valid author data', () => {
        const result = discordAuthorSchema.safeParse(validAuthor);
        expect(result.success).toBe(true);
    });

    test.each([
        ['id', { id: undefined }],
        ['username', { username: undefined }],
        ['displayName', { displayName: undefined }],
    ])('should require non-empty %s field', (_fieldName, override) => {
        const key = Object.keys(override)[0] as keyof typeof validAuthor;
        const { [key]: _removed, ...incomplete } = validAuthor;
        const result = discordAuthorSchema.safeParse(incomplete);
        expect(result.success).toBe(false);
    });

    test.each([
        ['id', { id: '' }],
        ['username', { username: '' }],
        ['displayName', { displayName: '' }],
    ])('should reject empty %s', (_fieldName, override) => {
        const result = discordAuthorSchema.safeParse({ ...validAuthor, ...override });
        expect(result.success).toBe(false);
    });

    test('should reject non-string values', () => {
        const result = discordAuthorSchema.safeParse({
            id:          12_345,
            username:    'test',
            displayName: 'Test',
        });
        expect(result.success).toBe(false);
    });
});

describe('discordAttachmentSchema', () => {
    const validAttachment: DiscordAttachment = {
        url:      'https://cdn.discordapp.com/attachments/123/456/file.png',
        filename: 'file.png',
    };

    test('should accept valid attachment with and without contentType', () => {
        expect(discordAttachmentSchema.safeParse(validAttachment).success).toBe(true);
        expect(discordAttachmentSchema.safeParse({ ...validAttachment, contentType: 'image/png' }).success).toBe(true);
    });

    test.each([
        ['url missing', { url: undefined }, false],
        ['url invalid', { url: 'not-a-url' }, false],
        ['filename missing', { filename: undefined }, false],
        ['filename empty', { filename: '' }, false],
    ])('should validate %s', (_label, override, _shouldPass) => {
        const key = Object.keys(override)[0] as keyof typeof validAttachment;
        const { [key]: _removed, ...base } = validAttachment;
        const overrideRecord = override as Record<string, unknown>;
        const testData = key === 'url' && 'url' in overrideRecord && overrideRecord.url !== undefined
            ? { ...validAttachment, ...override }
            : base;
        const result = discordAttachmentSchema.safeParse(testData);
        expect(result.success).toBe(false);
    });
});

describe('discordEmbedSchema', () => {
    test('should accept embed with all fields, individual fields, or empty', () => {
        const fullEmbed: DiscordEmbed = {
            title:       'Test Embed',
            description: 'This is a test embed',
            url:         'https://example.com',
        };
        expect(discordEmbedSchema.safeParse(fullEmbed).success).toBe(true);
        expect(discordEmbedSchema.safeParse({ title: 'Title Only' }).success).toBe(true);
        expect(discordEmbedSchema.safeParse({ description: 'Description only' }).success).toBe(true);
        expect(discordEmbedSchema.safeParse({ url: 'https://example.com' }).success).toBe(true);
        expect(discordEmbedSchema.safeParse({}).success).toBe(true);
    });

    test.each([
        ['invalid url', { url: 'not-a-url' }],
        ['non-string title', { title: 123 }],
        ['non-string description', { description: 123 }],
    ])('should reject %s', (_label, invalidData) => {
        const result = discordEmbedSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
    });
});

describe('discordReactionSchema', () => {
    const validReaction: DiscordReaction = {
        emoji: '👍',
        count: 5,
    };

    test('should accept valid reaction including custom emoji format', () => {
        expect(discordReactionSchema.safeParse(validReaction).success).toBe(true);
        expect(discordReactionSchema.safeParse({ emoji: '<:custom:123456789>', count: 1 }).success).toBe(true);
    });

    test.each([
        ['emoji missing', { emoji: undefined }],
        ['emoji empty', { emoji: '' }],
        ['count missing', { count: undefined }],
        ['count zero', { count: 0 }],
        ['count negative', { count: -1 }],
        ['count non-integer', { count: 1.5 }],
    ])('should reject %s', (_label, override) => {
        // For undefined values, omit the field; otherwise merge the override
        const overrideValue = Object.values(override)[0];
        let testData: Record<string, unknown>;
        if(overrideValue === undefined) {
            const key = Object.keys(override)[0];
            const { [key]: _removed, ...base } = validReaction as Record<string, unknown>;
            testData = base;
        } else {
            testData = { ...validReaction, ...override };
        }
        const result = discordReactionSchema.safeParse(testData);
        expect(result.success).toBe(false);
    });
});

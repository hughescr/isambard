import { describe, it, expect } from 'bun:test';
import {
    discordAuthorSchema,
    discordAttachmentSchema,
    discordEmbedSchema,
    discordReactionSchema,
    type DiscordAuthor,
    type DiscordAttachment,
    type DiscordEmbed,
    type DiscordReaction
} from '@/integrations/discord/message-history/types';

describe('discordAuthorSchema', () => {
    const validAuthor: DiscordAuthor = {
        id:          '123456789012345678',
        username:    'testuser',
        displayName: 'Test User',
    };

    it('should accept valid author data', () => {
        const result = discordAuthorSchema.safeParse(validAuthor);
        expect(result.success).toBe(true);
    });

    it('should require id field', () => {
        const { id: _id, ...noId } = validAuthor;
        const result = discordAuthorSchema.safeParse(noId);
        expect(result.success).toBe(false);
    });

    it('should reject empty id', () => {
        const result = discordAuthorSchema.safeParse({ ...validAuthor, id: '' });
        expect(result.success).toBe(false);
    });

    it('should require username field', () => {
        const { username: _username, ...noUsername } = validAuthor;
        const result = discordAuthorSchema.safeParse(noUsername);
        expect(result.success).toBe(false);
    });

    it('should reject empty username', () => {
        const result = discordAuthorSchema.safeParse({ ...validAuthor, username: '' });
        expect(result.success).toBe(false);
    });

    it('should require displayName field', () => {
        const { displayName: _displayName, ...noDisplayName } = validAuthor;
        const result = discordAuthorSchema.safeParse(noDisplayName);
        expect(result.success).toBe(false);
    });

    it('should reject empty displayName', () => {
        const result = discordAuthorSchema.safeParse({ ...validAuthor, displayName: '' });
        expect(result.success).toBe(false);
    });

    it('should reject non-string values', () => {
        const result = discordAuthorSchema.safeParse({
            id:          12345,
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

    it('should accept valid attachment without contentType', () => {
        const result = discordAttachmentSchema.safeParse(validAttachment);
        expect(result.success).toBe(true);
    });

    it('should accept valid attachment with contentType', () => {
        const result = discordAttachmentSchema.safeParse({
            ...validAttachment,
            contentType: 'image/png',
        });
        expect(result.success).toBe(true);
    });

    it('should require url field', () => {
        const { url: _url, ...noUrl } = validAttachment;
        const result = discordAttachmentSchema.safeParse(noUrl);
        expect(result.success).toBe(false);
    });

    it('should require url to be valid URL', () => {
        const result = discordAttachmentSchema.safeParse({
            ...validAttachment,
            url: 'not-a-url',
        });
        expect(result.success).toBe(false);
    });

    it('should require filename field', () => {
        const { filename: _filename, ...noFilename } = validAttachment;
        const result = discordAttachmentSchema.safeParse(noFilename);
        expect(result.success).toBe(false);
    });

    it('should reject empty filename', () => {
        const result = discordAttachmentSchema.safeParse({
            ...validAttachment,
            filename: '',
        });
        expect(result.success).toBe(false);
    });

    it('should allow contentType to be undefined', () => {
        const result = discordAttachmentSchema.safeParse(validAttachment);
        expect(result.success).toBe(true);
        if(result.success) {
            expect(result.data.contentType).toBeUndefined();
        }
    });
});

describe('discordEmbedSchema', () => {
    it('should accept embed with all fields', () => {
        const fullEmbed: DiscordEmbed = {
            title:       'Test Embed',
            description: 'This is a test embed',
            url:         'https://example.com',
        };
        const result = discordEmbedSchema.safeParse(fullEmbed);
        expect(result.success).toBe(true);
    });

    it('should accept embed with only title', () => {
        const result = discordEmbedSchema.safeParse({ title: 'Title Only' });
        expect(result.success).toBe(true);
    });

    it('should accept embed with only description', () => {
        const result = discordEmbedSchema.safeParse({ description: 'Description only' });
        expect(result.success).toBe(true);
    });

    it('should accept embed with only url', () => {
        const result = discordEmbedSchema.safeParse({ url: 'https://example.com' });
        expect(result.success).toBe(true);
    });

    it('should accept empty embed object', () => {
        const result = discordEmbedSchema.safeParse({});
        expect(result.success).toBe(true);
    });

    it('should require url to be valid URL when present', () => {
        const result = discordEmbedSchema.safeParse({ url: 'not-a-url' });
        expect(result.success).toBe(false);
    });

    it('should reject non-string title', () => {
        const result = discordEmbedSchema.safeParse({ title: 123 });
        expect(result.success).toBe(false);
    });

    it('should reject non-string description', () => {
        const result = discordEmbedSchema.safeParse({ description: 123 });
        expect(result.success).toBe(false);
    });
});

describe('discordReactionSchema', () => {
    const validReaction: DiscordReaction = {
        emoji: '👍',
        count: 5,
    };

    it('should accept valid reaction', () => {
        const result = discordReactionSchema.safeParse(validReaction);
        expect(result.success).toBe(true);
    });

    it('should require emoji field', () => {
        const { emoji: _emoji, ...noEmoji } = validReaction;
        const result = discordReactionSchema.safeParse(noEmoji);
        expect(result.success).toBe(false);
    });

    it('should reject empty emoji', () => {
        const result = discordReactionSchema.safeParse({ ...validReaction, emoji: '' });
        expect(result.success).toBe(false);
    });

    it('should require count field', () => {
        const { count: _count, ...noCount } = validReaction;
        const result = discordReactionSchema.safeParse(noCount);
        expect(result.success).toBe(false);
    });

    it('should require count to be positive integer', () => {
        const result = discordReactionSchema.safeParse({ ...validReaction, count: 0 });
        expect(result.success).toBe(false);
    });

    it('should reject negative count', () => {
        const result = discordReactionSchema.safeParse({ ...validReaction, count: -1 });
        expect(result.success).toBe(false);
    });

    it('should reject non-integer count', () => {
        const result = discordReactionSchema.safeParse({ ...validReaction, count: 1.5 });
        expect(result.success).toBe(false);
    });

    it('should accept custom emoji format', () => {
        const result = discordReactionSchema.safeParse({
            emoji: '<:custom:123456789>',
            count: 1,
        });
        expect(result.success).toBe(true);
    });
});

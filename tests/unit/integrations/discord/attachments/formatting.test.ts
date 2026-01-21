import { describe, test, expect } from 'bun:test';
import { formatBytes, addAttachmentInfoToContexts } from '@/integrations/discord/attachments/formatting';
import type { DiscordMessageContext } from '@/integrations/discord/types';
import { createGuildId, createChannelId, createUserId } from '@/integrations/discord/types';

describe('formatBytes', () => {
    test('returns "0B" for zero bytes', () => {
        expect(formatBytes(0)).toBe('0B');
    });

    test('returns bytes without suffix for values < 1024', () => {
        expect(formatBytes(1)).toBe('1B');
        expect(formatBytes(512)).toBe('512B');
        expect(formatBytes(1023)).toBe('1023B');
    });

    test('returns KB for values >= 1024 and < 1MB', () => {
        expect(formatBytes(1024)).toBe('1KB');
        expect(formatBytes(1536)).toBe('2KB'); // 1.5KB rounds to 2
        expect(formatBytes(10240)).toBe('10KB');
    });

    test('returns MB for values >= 1MB and < 1GB', () => {
        expect(formatBytes(1048576)).toBe('1MB'); // 1024^2
        expect(formatBytes(1572864)).toBe('2MB'); // 1.5MB rounds to 2
        expect(formatBytes(10485760)).toBe('10MB');
    });

    test('returns GB for values >= 1GB', () => {
        expect(formatBytes(1073741824)).toBe('1GB'); // 1024^3
        expect(formatBytes(2147483648)).toBe('2GB');
    });

    // Kill arithmetic operator mutants
    test('uses correct base (1024 not other values)', () => {
        // 2048 bytes = 2KB (if base is 1024)
        // Would be different if base changed
        expect(formatBytes(2048)).toBe('2KB');
        expect(formatBytes(1048576)).toBe('1MB'); // Exactly 1024^2
    });

    // Kill string literal mutants
    test('uses correct size suffixes', () => {
        const result0 = formatBytes(0);
        const result1 = formatBytes(500);
        const result2 = formatBytes(2048);
        const result3 = formatBytes(2097152);
        const result4 = formatBytes(2147483648);

        expect(result0).toContain('B');
        expect(result1).toContain('B');
        expect(result1).not.toContain('K');
        expect(result2).toContain('KB');
        expect(result3).toContain('MB');
        expect(result4).toContain('GB');
    });

    // Kill conditional/equality mutants
    test('boundary at exactly zero', () => {
        expect(formatBytes(0)).toBe('0B');
        expect(formatBytes(1)).not.toBe('0B');
    });
});

describe('addAttachmentInfoToContexts', () => {
    const createContext = (content: string, messageId = 'msg1'): DiscordMessageContext => ({
        guildId:   createGuildId('guild1'),
        channelId: createChannelId('channel1'),
        userId:    createUserId('user1'),
        messageId,
        content,
        timestamp: new Date().toISOString(),
        botUserId: createUserId('bot1'),
    });

    test('returns original contexts when no content additions', () => {
        const contexts = [createContext('Hello')];
        const result = addAttachmentInfoToContexts(contexts, []);

        expect(result).toBe(contexts); // Same reference
        expect(result[0].content).toBe('Hello');
    });

    test('adds content additions only to first context', () => {
        const contexts = [
            createContext('First message', 'msg1'),
            createContext('Second message', 'msg2'),
        ];
        const additions = ['[File: doc.pdf]'];

        const result = addAttachmentInfoToContexts(contexts, additions);

        expect(result[0].content).toBe('First message\n\n[File: doc.pdf]');
        expect(result[1].content).toBe('Second message');
    });

    test('joins multiple additions with newlines', () => {
        const contexts = [createContext('Content')];
        const additions = ['[File: a.pdf]', '[File: b.txt]'];

        const result = addAttachmentInfoToContexts(contexts, additions);

        expect(result[0].content).toBe('Content\n\n[File: a.pdf]\n[File: b.txt]');
    });

    test('preserves all other context properties', () => {
        const original = createContext('Test');
        original.attachments = [{ url: 'http://test', filename: 'test.jpg', contentType: 'image/jpeg', size: 100 }];

        const result = addAttachmentInfoToContexts([original], ['[File: x.pdf]']);

        expect(result[0].guildId).toBe(original.guildId);
        expect(result[0].channelId).toBe(original.channelId);
        expect(result[0].userId).toBe(original.userId);
        expect(result[0].attachments).toBe(original.attachments);
    });

    test('handles single context with additions', () => {
        const contexts = [createContext('Only one')];
        const additions = ['[Attached]'];

        const result = addAttachmentInfoToContexts(contexts, additions);

        expect(result).toHaveLength(1);
        expect(result[0].content).toContain('Only one');
        expect(result[0].content).toContain('[Attached]');
    });

    test('returns new array (not mutating original)', () => {
        const contexts = [createContext('A'), createContext('B')];
        const additions = ['[File]'];

        const result = addAttachmentInfoToContexts(contexts, additions);

        expect(result).not.toBe(contexts);
        expect(contexts[0].content).toBe('A'); // Original unchanged
    });

    // Kill equality/conditional mutants
    test('empty additions array returns exact same reference', () => {
        const contexts = [createContext('Test')];
        const result = addAttachmentInfoToContexts(contexts, []);
        expect(result).toBe(contexts);
    });

    test('idx === 0 check is precise', () => {
        const contexts = [
            createContext('First'),
            createContext('Second'),
            createContext('Third'),
        ];
        const additions = ['[Added]'];

        const result = addAttachmentInfoToContexts(contexts, additions);

        // Only first is modified
        expect(result[0].content).toContain('[Added]');
        expect(result[1].content).not.toContain('[Added]');
        expect(result[2].content).not.toContain('[Added]');
    });
});

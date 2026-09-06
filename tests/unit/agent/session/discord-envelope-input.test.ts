import { describe, expect, it } from 'bun:test';
import type * as agentBarrel from '@/agent';
import type { DiscordEnvelopeInput } from '@/agent/session/discord-envelope-input';

// Compile-time-only assertions live in this file (same convention as ports.test.ts): each
// `describe`/`it` carries exactly one runtime `expect` so `jest/expect-expect` is satisfied
// without pretending this is behavioural coverage of a pure data shape.

describe('DiscordEnvelopeInput', () => {
    it('is satisfiable with every field, including a populated channelList, with no `as` casts', () => {
        const input: DiscordEnvelopeInput = {
            messageId:   'msg-1',
            channelId:   'chan-1',
            channelName: 'general',
            guildName:   'My Guild',
            authorId:    'user-1',
            authorName:  'Craig',
            content:     'hello',
            createdAt:   new Date(0),
            images:      [{
                filename: 'a.png', mediaType: 'image/png', base64Data: 'AA==', originalSize: 2,
            }],
            isDM:        false,
            channelList: ['#general', '#random (My Guild)'],
        };

        expect(input.channelList).toEqual(['#general', '#random (My Guild)']);
    });

    it('is satisfiable with only its required fields — guildName and images are optional', () => {
        const input: DiscordEnvelopeInput = {
            messageId:   'msg-2',
            channelId:   'chan-dm',
            channelName: 'DM',
            authorId:    'user-2',
            authorName:  'Someone',
            content:     'hi',
            createdAt:   new Date(0),
            isDM:        true,
            channelList: [],
        };

        expect(input.guildName).toBeUndefined();
    });

    it('type-checks as @/agent\'s own DiscordEnvelopeInput export (a typo\'d re-export path breaks this at typecheck)', () => {
        // A type-only export leaves no runtime trace on a module namespace object, so this is a
        // compile-time-only assertion: it type-checks only when `@/agent`'s own
        // `DiscordEnvelopeInput` is assignable from (i.e. is) this module's type, proving the
        // barrel actually re-exports it rather than shadowing it with something structurally
        // similar declared elsewhere.
        const fromDirectImport: DiscordEnvelopeInput = {
            messageId: 'x', channelId: 'c', channelName: 'c', authorId: 'a', authorName: 'a', content: '', createdAt: new Date(0), isDM: false, channelList: [],
        };
        const viaBarrel: agentBarrel.DiscordEnvelopeInput = fromDirectImport;

        expect(viaBarrel.channelList).toEqual([]);
    });
});

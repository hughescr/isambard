import { describe, test, expect, spyOn, afterEach, jest } from 'bun:test';
import * as mm from '../../../../src/agent/multimodal-message-builder';
import {
    buildDiscordEnvelope,
    buildPerchEnvelope,
    buildNotificationEnvelope,
    buildCatchupEnvelope,
    buildWrapUpEnvelope,
    buildResumeEnvelope,
    buildBootEnvelope,
    buildCompactEnvelope,
    toSdkUserMessage
} from '../../../../src/agent/session/envelope';
import type { Envelope } from '../../../../src/agent/session/types';
import type { MessageContext, PlatformImage } from '../../../../src/agent/types';

const now = new Date('2026-09-04T22:07:00Z');
const timezone = 'America/Los_Angeles';
const timeHeader = '## Current Time\n- Izzy: 2026-09-04T14:07:00 America/Los_Angeles (Friday afternoon)';

function makeMessage(overrides: Partial<MessageContext> = {}): MessageContext {
    return {
        channelId: 'chan-1',
        userId:    'user-1',
        messageId: 'msg-1',
        content:   'hello there',
        timestamp: '2026-09-04T22:06:00Z',
        botUserId: 'bot-1',
        ...overrides,
    };
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('buildDiscordEnvelope', () => {
    test('renders the channel header exactly, with timeHeader first in the body', () => {
        const envelope = buildDiscordEnvelope({
            messages:    [makeMessage()],
            authorId:    'author-1',
            authorName:  'craig',
            channelId:   'chan-1',
            channelName: 'general',
            isDM:        false,
            now,
            timezone,
            timeHeader,
        });

        const header = '[DISCORD #general · 2026-09-04 14:07 PT · @craig]';
        expect(envelope.text.startsWith(`${header}\n\n${timeHeader}`)).toBe(true);
    });

    test('renders the DM header form', () => {
        const envelope = buildDiscordEnvelope({
            messages:    [makeMessage()],
            authorId:    'author-1',
            authorName:  'craig',
            channelId:   'dm-1',
            channelName: 'ignored-for-dm',
            isDM:        true,
            now,
            timezone,
            timeHeader,
        });

        expect(envelope.text.startsWith('[DISCORD DM · 2026-09-04 14:07 PT · @craig]')).toBe(true);
    });

    test('includes the guild name in the channel header when provided', () => {
        const envelope = buildDiscordEnvelope({
            messages: [makeMessage()], authorId: 'a', authorName: 'craig', channelId: 'c', channelName: 'general', guildName: 'Home Server', isDM: false, now, timezone, timeHeader,
        });

        expect(envelope.text.startsWith('[DISCORD #general (Home Server) · 2026-09-04 14:07 PT · @craig]')).toBe(true);
    });

    test('omits [Service health], [About this user], [Recent events] and [Channels] when their inputs are absent', () => {
        const envelope = buildDiscordEnvelope({
            messages: [makeMessage()], authorId: 'a', authorName: 'craig', channelId: 'c', channelName: 'general', isDM: false, now, timezone, timeHeader,
        });

        expect(envelope.text).not.toContain('[Service health]');
        expect(envelope.text).not.toContain('[About this user]');
        expect(envelope.text).not.toContain('[Recent events]');
        expect(envelope.text).not.toContain('[Channels]');
    });

    test('includes [Service health]/[About this user]/[Recent events]/[Channels] only when provided, each with its content', () => {
        const envelope = buildDiscordEnvelope({
            messages:        [makeMessage()],
            authorId:        'a',
            authorName:      'craig',
            channelId:       'c',
            channelName:     'general',
            isDM:            false,
            now,
            timezone,
            timeHeader,
            healthNote:      'MCP degraded',
            userMemoryBlock: 'Craig likes TypeScript.',
            newEvents:       ['- event one', '- event two'],
            channelList:     '#general, #random',
        });

        const header = '[DISCORD #general · 2026-09-04 14:07 PT · @craig]';
        expect(envelope.text.startsWith(`${header}\n\n${timeHeader}\n\n[Service health]\nMCP degraded`)).toBe(true);
        expect(envelope.text).toContain('[Service health]\nMCP degraded');
        expect(envelope.text).toContain('[About this user]\nCraig likes TypeScript.');
        expect(envelope.text).toContain('[Recent events]\n- event one\n- event two');
        expect(envelope.text).toContain('[Channels]\n#general, #random');
    });

    test('does not render [Recent events] for an empty array', () => {
        const envelope = buildDiscordEnvelope({
            messages: [makeMessage()], authorId: 'a', authorName: 'craig', channelId: 'c', channelName: 'general', isDM: false, now, timezone, timeHeader, newEvents: [],
        });

        expect(envelope.text).not.toContain('[Recent events]');
    });

    test('renders message texts in order', () => {
        const envelope = buildDiscordEnvelope({
            messages: [
                makeMessage({ content: 'first message' }),
                makeMessage({ content: 'second message' }),
            ],
            authorId: 'a', authorName: 'craig', channelId: 'c', channelName: 'general', isDM: false, now, timezone, timeHeader,
        });

        const firstIndex = envelope.text.indexOf('first message');
        const secondIndex = envelope.text.indexOf('second message');
        expect(firstIndex).toBeGreaterThan(-1);
        expect(secondIndex).toBeGreaterThan(firstIndex);
    });

    test('sets origin, channelId, authorId, hostPriority human, shouldQuery true, kind discord, createdAt now', () => {
        const envelope = buildDiscordEnvelope({
            messages: [makeMessage()], authorId: 'author-9', authorName: 'craig', channelId: 'chan-9', channelName: 'general', isDM: false, now, timezone, timeHeader,
        });

        expect(envelope.kind).toBe('discord');
        expect(envelope.origin).toEqual({ kind: 'human' });
        expect(envelope.channelId).toBe('chan-9');
        expect(envelope.authorId).toBe('author-9');
        expect(envelope.hostPriority).toBe('human');
        expect(envelope.shouldQuery).toBe(true);
        expect(envelope.createdAt).toBe(now);
    });

    test('carries images through to the envelope', () => {
        const images: PlatformImage[] = [{ filename: 'a.png', mediaType: 'image/png', base64Data: 'AAAA', originalSize: 4 }];
        const envelope = buildDiscordEnvelope({
            messages: [makeMessage()], authorId: 'a', authorName: 'craig', channelId: 'c', channelName: 'general', isDM: false, now, timezone, timeHeader, images,
        });

        expect(envelope.images).toBe(images);
    });
});

describe('buildPerchEnvelope', () => {
    test('renders the perch header with slot name and ends-at time, timeHeader first in body', () => {
        const envelope = buildPerchEnvelope({
            slotName:        'evening',
            now,
            timezone,
            endsAt:          new Date('2026-09-05T02:45:00Z'),
            suggestionLevel: 2,
            slotHint:        'Consider tidying up the backlog.',
            perchContext:    'Nothing urgent is pending.',
            timeHeader,
        });

        const header = '[PERCH · evening slot · 2026-09-04 14:07 PT · ends 18:45]';
        expect(envelope.text.startsWith(`${header}\n\n${timeHeader}`)).toBe(true);
        expect(envelope.kind).toBe('perch');
        expect(envelope.hostPriority).toBe('wake');
        expect(envelope.shouldQuery).toBe(true);
    });

    test('renders the suggestion level with background summary when given', () => {
        const envelope = buildPerchEnvelope({
            slotName: 'evening', now, timezone, endsAt: new Date('2026-09-05T02:45:00Z'), suggestionLevel: 3, backgroundSummary: 'quiet evening', slotHint: 'hint', perchContext: 'context', timeHeader,
        });

        expect(envelope.text).toContain('Suggestion level: 3 of 3. Background: quiet evening');
    });

    test('omits the background clause when no summary is given', () => {
        const envelope = buildPerchEnvelope({
            slotName: 'evening', now, timezone, endsAt: new Date('2026-09-05T02:45:00Z'), suggestionLevel: 1, slotHint: 'hint', perchContext: 'context', timeHeader,
        });

        expect(envelope.text).toContain('Suggestion level: 1 of 3.');
        expect(envelope.text).not.toContain('Background:');
    });
});

describe('buildNotificationEnvelope', () => {
    test('renders the notification header and body', () => {
        const envelope = buildNotificationEnvelope({
            source: 'email', text: 'You have a new email from Alice.', now, timezone, timeHeader, wake: true,
        });

        const header = '[NOTIFICATION · email · 2026-09-04 14:07 PT]';
        expect(envelope.text.startsWith(`${header}\n\n${timeHeader}`)).toBe(true);
        expect(envelope.text).toContain('You have a new email from Alice.');
        expect(envelope.kind).toBe('notification');
    });

    test('shouldQuery follows wake; hostPriority is wake when waking, accumulate otherwise', () => {
        const waking = buildNotificationEnvelope({ source: 'email', text: 't', now, timezone, timeHeader, wake: true });
        const quiet = buildNotificationEnvelope({ source: 'email', text: 't', now, timezone, timeHeader, wake: false });

        expect(waking.shouldQuery).toBe(true);
        expect(waking.hostPriority).toBe('wake');
        expect(quiet.shouldQuery).toBe(false);
        expect(quiet.hostPriority).toBe('accumulate');
    });
});

describe('buildCatchupEnvelope', () => {
    test('renders the catch-up header, timeHeader, and catch-up text', () => {
        const envelope = buildCatchupEnvelope({ unreadCount: 3, channelCount: 2, now, timezone, timeHeader });

        const header = '[CATCH-UP · 2026-09-04 14:07 PT]';
        expect(envelope.text.startsWith(`${header}\n\n${timeHeader}`)).toBe(true);
        expect(envelope.text).toContain('3 unread messages across 2 channels');
        expect(envelope.text).toContain('getUnreadOverview');
        expect(envelope.kind).toBe('catchup');
        expect(envelope.hostPriority).toBe('wake');
        expect(envelope.shouldQuery).toBe(true);
    });
});

describe('buildWrapUpEnvelope', () => {
    test('renders the wrap-up header with minutes left', () => {
        const envelope = buildWrapUpEnvelope({ minutesLeft: 5, now });

        expect(envelope.text.startsWith('[WRAP-UP · perch slot ends in 5 min]')).toBe(true);
        expect(envelope.kind).toBe('wrapup');
        expect(envelope.hostPriority).toBe('wake');
        expect(envelope.shouldQuery).toBe(true);
    });
});

describe('buildResumeEnvelope', () => {
    test('carries the note as text, kind resume, hostPriority wake', () => {
        const envelope = buildResumeEnvelope('[RESUME NOTE]\nsomething', now);

        expect(envelope.text).toBe('[RESUME NOTE]\nsomething');
        expect(envelope.kind).toBe('resume');
        expect(envelope.hostPriority).toBe('wake');
    });
});

describe('buildBootEnvelope', () => {
    test('carries the text verbatim, shouldQuery false, hostPriority accumulate', () => {
        const envelope = buildBootEnvelope('[BOOT BUNDLE · conversation]\n...', now);

        expect(envelope.text).toBe('[BOOT BUNDLE · conversation]\n...');
        expect(envelope.kind).toBe('boot');
        expect(envelope.shouldQuery).toBe(false);
        expect(envelope.hostPriority).toBe('accumulate');
    });
});

describe('buildCompactEnvelope', () => {
    test('text is exactly /compact, shouldQuery true, kind compact', () => {
        const envelope = buildCompactEnvelope(now);

        expect(envelope.text).toBe('/compact');
        expect(envelope.kind).toBe('compact');
        expect(envelope.shouldQuery).toBe(true);
    });
});

describe('distinct ids', () => {
    test('two builds yield distinct ids, and crypto.randomUUID is used', () => {
        const spy = spyOn(crypto, 'randomUUID');

        const a = buildBootEnvelope('a', now);
        const b = buildBootEnvelope('b', now);

        expect(spy).toHaveBeenCalledTimes(2);
        expect(a.id).not.toBe(b.id);
    });
});

describe('toSdkUserMessage', () => {
    test('content equals buildMultimodalContent(text, images), shouldQuery copied, origin absent for non-discord, no SDK priority key', () => {
        const spy = spyOn(mm, 'buildMultimodalContent');
        const envelope = buildBootEnvelope('boot text', now);

        const sdkMessage = toSdkUserMessage(envelope);

        expect(spy).toHaveBeenCalledWith('boot text', undefined);
        expect(sdkMessage.message.content).toEqual(mm.buildMultimodalContent('boot text', undefined));
        expect(sdkMessage.shouldQuery).toBe(false);
        expect('origin' in sdkMessage).toBe(false);
        expect('priority' in sdkMessage).toBe(false);
        expect(sdkMessage.type).toBe('user');
        expect(sdkMessage.parent_tool_use_id).toBeNull();
    });

    test('origin is present for a discord envelope', () => {
        const envelope: Envelope = buildDiscordEnvelope({
            messages: [makeMessage()], authorId: 'a', authorName: 'craig', channelId: 'c', channelName: 'general', isDM: false, now, timezone, timeHeader,
        });

        const sdkMessage = toSdkUserMessage(envelope);

        expect(sdkMessage.origin).toEqual({ kind: 'human' });
        expect('priority' in sdkMessage).toBe(false);
    });
});

import { describe, test, expect, spyOn, afterEach, jest } from 'bun:test';
import * as mm from '../../../../src/agent/multimodal-message-builder';
import {
    buildDiscordEnvelope,
    buildPerchEnvelope,
    buildNotificationEnvelope,
    buildPeerEnvelope,
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

    test('joins only the sections that are actually present, with no blank-line gaps for absent optional sections', () => {
        const envelope = buildDiscordEnvelope({
            messages: [makeMessage()], authorId: 'a', authorName: 'craig', channelId: 'c', channelName: 'general', isDM: false, now, timezone, timeHeader,
        });

        const header = '[DISCORD #general · 2026-09-04 14:07 PT · @craig]';
        expect(envelope.text).toBe(`${header}\n\n${timeHeader}\n\nhello there`);
    });

    test('omits [Service health], [About this user], [Recent events], [State changed], [Calendar] and [Channels] when their inputs are absent', () => {
        const envelope = buildDiscordEnvelope({
            messages: [makeMessage()], authorId: 'a', authorName: 'craig', channelId: 'c', channelName: 'general', isDM: false, now, timezone, timeHeader,
        });

        expect(envelope.text).not.toContain('[Service health]');
        expect(envelope.text).not.toContain('[About this user]');
        expect(envelope.text).not.toContain('[Recent events]');
        expect(envelope.text).not.toContain('[State changed]');
        expect(envelope.text).not.toContain('[Calendar]');
        expect(envelope.text).not.toContain('[Channels]');
    });

    test('omits [Calendar] when calendarChanged is explicitly undefined', () => {
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
            calendarChanged: undefined,
        });

        expect(envelope.text).not.toContain('[Calendar]');
    });

    test('renders [Calendar] with only the full agenda text on isFirst, ignoring any populated added/removed/changed lists', () => {
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
            // isFirst diffs are always empty in practice (see diffAgenda), but the builder is
            // pinned to ignore the lists on isFirst regardless, so this catches a mutant that
            // drops the isFirst branch entirely.
            calendarChanged: { agenda: '09:00–10:00 Standup', added: ['14:00–15:00 Review'], removed: [], changed: [], isFirst: true },
        });

        expect(envelope.text).toContain('[Calendar]\n09:00–10:00 Standup');
        expect(envelope.text).not.toContain('+14:00–15:00 Review');
    });

    test('renders [Calendar] with a +/-/~ change list followed by the full agenda text when not isFirst', () => {
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
            calendarChanged: {
                agenda:  '09:00–10:00 Standup\n14:00–15:00 Review',
                added:   ['14:00–15:00 Review'],
                removed: ['11:00–12:00 Old meeting'],
                changed: ['09:00–10:00 Standup'],
                isFirst: false,
            },
        });

        expect(envelope.text).toContain(
            '[Calendar]\n+14:00–15:00 Review\n-11:00–12:00 Old meeting\n~09:00–10:00 Standup\n09:00–10:00 Standup\n14:00–15:00 Review'
        );
    });

    test('does not leave a dangling trailing newline when a change list is present but the agenda text is empty', () => {
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
            calendarChanged: { agenda: '', added: [], removed: ['09:00–10:00 Standup'], changed: [], isFirst: false },
        });

        const header = '[DISCORD #general · 2026-09-04 14:07 PT · @craig]';
        expect(envelope.text).toBe(`${header}\n\n${timeHeader}\n\n[Calendar]\n-09:00–10:00 Standup\n\nhello there`);
    });

    test('renders [Calendar] with just the full agenda text when not isFirst but nothing changed', () => {
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
            calendarChanged: { agenda: '09:00–10:00 Standup', added: [], removed: [], changed: [], isFirst: false },
        });

        expect(envelope.text).toContain('[Calendar]\n09:00–10:00 Standup');
    });

    test('omits [State changed] when stateChanged is explicitly undefined', () => {
        const envelope = buildDiscordEnvelope({
            messages:     [makeMessage()],
            authorId:     'a',
            authorName:   'craig',
            channelId:    'c',
            channelName:  'general',
            isDM:         false,
            now,
            timezone,
            timeHeader,
            stateChanged: undefined,
        });

        expect(envelope.text).not.toContain('[State changed]');
    });

    test('omits [State changed] when stateChanged has all three lists empty', () => {
        const envelope = buildDiscordEnvelope({
            messages:     [makeMessage()],
            authorId:     'a',
            authorName:   'craig',
            channelId:    'c',
            channelName:  'general',
            isDM:         false,
            now,
            timezone,
            timeHeader,
            stateChanged: { added: [], removed: [], changed: [] },
        });

        expect(envelope.text).not.toContain('[State changed]');
    });

    test('renders [State changed] with only +added lines when only added is non-empty', () => {
        const envelope = buildDiscordEnvelope({
            messages:     [makeMessage()],
            authorId:     'a',
            authorName:   'craig',
            channelId:    'c',
            channelName:  'general',
            isDM:         false,
            now,
            timezone,
            timeHeader,
            stateChanged: { added: ['state/one', 'state/two'], removed: [], changed: [] },
        });

        expect(envelope.text).toContain('[State changed]\n+state/one\n+state/two');
    });

    test('renders [State changed] with only -removed lines when only removed is non-empty', () => {
        const envelope = buildDiscordEnvelope({
            messages:     [makeMessage()],
            authorId:     'a',
            authorName:   'craig',
            channelId:    'c',
            channelName:  'general',
            isDM:         false,
            now,
            timezone,
            timeHeader,
            stateChanged: { added: [], removed: ['state/three'], changed: [] },
        });

        expect(envelope.text).toContain('[State changed]\n-state/three');
    });

    test('renders [State changed] with only ~changed lines when only changed is non-empty', () => {
        const envelope = buildDiscordEnvelope({
            messages:     [makeMessage()],
            authorId:     'a',
            authorName:   'craig',
            channelId:    'c',
            channelName:  'general',
            isDM:         false,
            now,
            timezone,
            timeHeader,
            stateChanged: { added: [], removed: [], changed: ['state/four'] },
        });

        expect(envelope.text).toContain('[State changed]\n~state/four');
    });

    test('renders [State changed] with +/-/~ lines for added, removed and changed, and places it after [Recent events] and before [Channels]', () => {
        const envelope = buildDiscordEnvelope({
            messages:     [makeMessage()],
            authorId:     'a',
            authorName:   'craig',
            channelId:    'c',
            channelName:  'general',
            isDM:         false,
            now,
            timezone,
            timeHeader,
            newEvents:    ['- event one'],
            channelList:  '#general, #random',
            stateChanged: { added: ['state/one'], removed: ['state/two'], changed: ['state/three'] },
        });

        expect(envelope.text).toContain('[State changed]\n+state/one\n-state/two\n~state/three');
        const recentEventsIndex = envelope.text.indexOf('[Recent events]');
        const stateChangedIndex = envelope.text.indexOf('[State changed]');
        const channelsIndex = envelope.text.indexOf('[Channels]');
        expect(recentEventsIndex).toBeLessThan(stateChangedIndex);
        expect(stateChangedIndex).toBeLessThan(channelsIndex);
    });

    test('places [Calendar] after [State changed] and before [Channels]', () => {
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
            channelList:     '#general, #random',
            stateChanged:    { added: ['state/one'], removed: [], changed: [] },
            calendarChanged: { agenda: '09:00–10:00 Standup', added: [], removed: [], changed: [], isFirst: true },
        });

        const stateChangedIndex = envelope.text.indexOf('[State changed]');
        const calendarIndex = envelope.text.indexOf('[Calendar]');
        const channelsIndex = envelope.text.indexOf('[Channels]');
        expect(stateChangedIndex).toBeLessThan(calendarIndex);
        expect(calendarIndex).toBeLessThan(channelsIndex);
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

    test('renders a resumeNote verbatim, between [Channels] and the message texts', () => {
        const envelope = buildDiscordEnvelope({
            messages:    [makeMessage({ content: 'second message' })],
            authorId:    'a',
            authorName:  'craig',
            channelId:   'c',
            channelName: 'general',
            isDM:        false,
            now,
            timezone,
            timeHeader,
            channelList: '#general, #random',
            resumeNote:  '[RESUME NOTE]\n\n[You were composing this response:]\npartial reply',
        });

        expect(envelope.text).toContain('[Channels]\n#general, #random\n\n[RESUME NOTE]');
        expect(envelope.text.indexOf('[RESUME NOTE]')).toBeLessThan(envelope.text.indexOf('second message'));
    });

    test('omits any resume-note section when resumeNote is not given', () => {
        const envelope = buildDiscordEnvelope({
            messages: [makeMessage()], authorId: 'a', authorName: 'craig', channelId: 'c', channelName: 'general', isDM: false, now, timezone, timeHeader,
        });

        expect(envelope.text).not.toContain('[RESUME NOTE]');
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

describe('buildPeerEnvelope', () => {
    test('renders the peer header, timeHeader, the peer text and a reply instruction naming the peer', () => {
        const envelope = buildPeerEnvelope({
            from: 'uds:/tmp/cc-socks/94548.sock', fromName: 'Izzy-main', text: 'MIDTURN-PING-CHARLIE-3', now, timezone, timeHeader,
        });

        const header = '[PEER · Izzy-main · 2026-09-04 14:07 PT]';
        expect(envelope.text).toBe(`${header}\n\n${timeHeader}\n\nMIDTURN-PING-CHARLIE-3\n\nReply with SendMessage to Izzy-main.`);
        expect(envelope.kind).toBe('peer');
        expect(envelope.peer).toEqual({ from: 'uds:/tmp/cc-socks/94548.sock', fromName: 'Izzy-main' });
        expect(envelope.hostPriority).toBe('wake');
        expect(envelope.shouldQuery).toBe(true);
        expect(envelope.createdAt).toBe(now);
        expect(envelope.id).not.toBe(buildPeerEnvelope({
            from: 'uds:/tmp/cc-socks/94548.sock', fromName: 'Izzy-main', text: 'MIDTURN-PING-CHARLIE-3', now, timezone, timeHeader,
        }).id);
    });

    test('falls back to the raw uds: reply address in both the header and the reply instruction when the tag named no peer, and omits `fromName` from `peer` entirely', () => {
        const envelope = buildPeerEnvelope({
            from: 'uds:/tmp/cc-socks/94548.sock', text: 'anonymous ping', now, timezone, timeHeader,
        });

        expect(envelope.text).toContain('[PEER · uds:/tmp/cc-socks/94548.sock · 2026-09-04 14:07 PT]');
        expect(envelope.text).toContain('Reply with SendMessage to uds:/tmp/cc-socks/94548.sock.');
        expect(envelope.peer).toEqual({ from: 'uds:/tmp/cc-socks/94548.sock' });
        expect(envelope.peer).not.toHaveProperty('fromName');
    });

    test('an empty fromName is treated as absent — the raw address is used rather than an empty name', () => {
        const envelope = buildPeerEnvelope({
            from: 'uds:/tmp/cc-socks/94548.sock', fromName: '', text: 'ping', now, timezone, timeHeader,
        });

        expect(envelope.text).toContain('[PEER · uds:/tmp/cc-socks/94548.sock · 2026-09-04 14:07 PT]');
        expect(envelope.peer).toEqual({ from: 'uds:/tmp/cc-socks/94548.sock' });
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

    test('omits the unread summary entirely when unreadCount is 0', () => {
        const envelope = buildCatchupEnvelope({ unreadCount: 0, channelCount: 0, now, timezone, timeHeader });

        expect(envelope.text).not.toContain('unread');
        expect(envelope.text).not.toContain('getUnreadOverview');
    });

    test('omits the unread summary when unreadCount is undefined; shouldQuery/hostPriority follow the accumulate rule', () => {
        const envelope = buildCatchupEnvelope({ channelCount: 0, now, timezone, timeHeader });

        expect(envelope.text).not.toContain('unread');
        expect(envelope.shouldQuery).toBe(false);
        expect(envelope.hostPriority).toBe('accumulate');
    });

    test('renders "## Events while you were away" only when eventsDelta is non-empty, in order after the unread summary', () => {
        const withEvents = buildCatchupEnvelope({
            unreadCount: 1, channelCount: 1, now, timezone, timeHeader, eventsDelta: ['- /events/1 (1h ago): did a thing'],
        });
        expect(withEvents.text).toContain('## Events while you were away\n- /events/1 (1h ago): did a thing');
        expect(withEvents.text.indexOf('unread')).toBeLessThan(withEvents.text.indexOf('## Events while you were away'));

        const without = buildCatchupEnvelope({ unreadCount: 1, channelCount: 1, now, timezone, timeHeader, eventsDelta: [] });
        expect(without.text).not.toContain('## Events while you were away');
    });

    test('renders "## Background tasks lost at restart" only when lostTasks is non-empty', () => {
        const withLost = buildCatchupEnvelope({ unreadCount: 0, channelCount: 0, now, timezone, timeHeader, lostTasks: ['lost-task-1'] });
        expect(withLost.text).toContain('## Background tasks lost at restart\nlost-task-1');

        const without = buildCatchupEnvelope({ unreadCount: 0, channelCount: 0, now, timezone, timeHeader, lostTasks: [] });
        expect(without.text).not.toContain('## Background tasks lost at restart');
    });

    test('renders "## Replies redelivered for you" only when redelivered is non-empty, ordered last', () => {
        const envelope = buildCatchupEnvelope({
            unreadCount: 0, channelCount: 0, now, timezone, timeHeader, lostTasks: ['lost-1'], redelivered: ['reply-to-@user: hello'],
        });

        expect(envelope.text).toContain('## Replies redelivered for you\nreply-to-@user: hello');
        expect(envelope.text.indexOf('## Background tasks lost at restart')).toBeLessThan(envelope.text.indexOf('## Replies redelivered for you'));
    });

    test('joins multiple items within one catch-up list section with a newline', () => {
        const envelope = buildCatchupEnvelope({
            unreadCount: 0, channelCount: 0, now, timezone, timeHeader, lostTasks: ['lost-1', 'lost-2'],
        });

        expect(envelope.text).toContain('## Background tasks lost at restart\nlost-1\nlost-2');
    });

    test('shouldQuery is true when unreadCount > 0, even with nothing else', () => {
        const envelope = buildCatchupEnvelope({ unreadCount: 1, channelCount: 1, now, timezone, timeHeader });

        expect(envelope.shouldQuery).toBe(true);
        expect(envelope.hostPriority).toBe('wake');
    });

    test('shouldQuery is true when lostTasks is non-empty, even with unreadCount 0', () => {
        const envelope = buildCatchupEnvelope({ unreadCount: 0, channelCount: 0, now, timezone, timeHeader, lostTasks: ['lost-1'] });

        expect(envelope.shouldQuery).toBe(true);
        expect(envelope.hostPriority).toBe('wake');
    });

    test('shouldQuery is false (accumulate, appendWithoutTurn) when only events/redelivered are present', () => {
        const envelope = buildCatchupEnvelope({
            unreadCount: 0, channelCount: 0, now, timezone, timeHeader, eventsDelta: ['- /events/1: a thing'], redelivered: ['reply: hi'],
        });

        expect(envelope.shouldQuery).toBe(false);
        expect(envelope.hostPriority).toBe('accumulate');
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

describe('synopsisSeed', () => {
    test('buildDiscordEnvelope seeds from the raw message contents, never the header', () => {
        const envelope = buildDiscordEnvelope({
            messages:    [makeMessage({ content: 'first line' }), makeMessage({ content: 'second line' })],
            authorId:    'author-1',
            authorName:  'craig',
            channelId:   'chan-1',
            channelName: 'general',
            isDM:        false,
            now,
            timezone,
            timeHeader,
        });

        expect(envelope.synopsisSeed).toBe('first line\nsecond line');
        expect(envelope.synopsisSeed?.startsWith('[DISCORD')).toBe(false);
    });

    test('buildPerchEnvelope seeds from the slot hint', () => {
        const envelope = buildPerchEnvelope({
            slotName:        'morning',
            now,
            timezone,
            endsAt:          new Date('2026-09-04T23:07:00Z'),
            suggestionLevel: 2,
            slotHint:        'Review the overnight inbox',
            perchContext:    'context body',
            timeHeader,
        });

        expect(envelope.synopsisSeed).toBe('Review the overnight inbox');
    });

    test('buildNotificationEnvelope seeds from the raw notification text', () => {
        const envelope = buildNotificationEnvelope({
            source: 'email', text: 'A new invoice arrived', now, timezone, timeHeader, wake: true,
        });

        expect(envelope.synopsisSeed).toBe('A new invoice arrived');
        expect(envelope.synopsisSeed?.startsWith('[NOTIFICATION')).toBe(false);
    });

    test('buildPeerEnvelope seeds from `fromName: text` when a name is present', () => {
        const envelope = buildPeerEnvelope({
            from: 'uds:/tmp/cc-socks/1.sock', fromName: 'Izzy-perch', text: 'can you take this?', now, timezone, timeHeader,
        });

        expect(envelope.synopsisSeed).toBe('Izzy-perch: can you take this?');
    });

    test('buildPeerEnvelope falls back to `from` when fromName is empty or absent', () => {
        const empty = buildPeerEnvelope({
            from: 'uds:/sock', fromName: '', text: 'hi', now, timezone, timeHeader,
        });
        const absent = buildPeerEnvelope({
            from: 'uds:/sock', text: 'hi', now, timezone, timeHeader,
        });

        expect(empty.synopsisSeed).toBe('uds:/sock: hi');
        expect(absent.synopsisSeed).toBe('uds:/sock: hi');
    });

    test('buildCatchupEnvelope seeds from the body sections with header and timeHeader stripped', () => {
        const envelope = buildCatchupEnvelope({
            channelCount: 2, now, timezone, timeHeader, eventsDelta: ['an event'], lostTasks: ['a task'], redelivered: ['a reply'],
        });

        expect(envelope.synopsisSeed).toBe('## Events while you were away\nan event\n\n## Background tasks lost at restart\na task\n\n## Replies redelivered for you\na reply');
        expect(envelope.text).toBe(`[CATCH-UP · 2026-09-04 14:07 PT]\n\n${timeHeader}\n\n${envelope.synopsisSeed!}`);
    });

    test('buildCatchupEnvelope with no sections at all seeds undefined', () => {
        const envelope = buildCatchupEnvelope({ channelCount: 2, now, timezone, timeHeader });

        expect(envelope.synopsisSeed).toBeUndefined();
    });

    test('buildWrapUpEnvelope seeds from the instruction line', () => {
        const envelope = buildWrapUpEnvelope({ minutesLeft: 5, now });

        expect(envelope.synopsisSeed).toBe('Wrap up your current work now; the perch slot is ending.');
    });

    test('buildResumeEnvelope seeds from the note', () => {
        const envelope = buildResumeEnvelope('resume note body', now);

        expect(envelope.synopsisSeed).toBe('resume note body');
    });

    test('buildBootEnvelope and buildCompactEnvelope carry no seed', () => {
        expect(buildBootEnvelope('boot bundle', now).synopsisSeed).toBeUndefined();
        expect(buildCompactEnvelope(now).synopsisSeed).toBeUndefined();
    });

    test('a source longer than the cap is sliced to exactly 200 characters', () => {
        const long = 'x'.repeat(250);

        const envelope = buildResumeEnvelope(long, now);

        expect(envelope.synopsisSeed).toBe('x'.repeat(200));
        expect(envelope.synopsisSeed).toHaveLength(200);
    });

    test('a source of exactly the cap length is kept whole', () => {
        const exact = 'y'.repeat(200);

        expect(buildResumeEnvelope(exact, now).synopsisSeed).toBe(exact);
    });

    test('an empty source yields undefined rather than an empty string', () => {
        expect(buildResumeEnvelope('', now).synopsisSeed).toBeUndefined();
    });
});

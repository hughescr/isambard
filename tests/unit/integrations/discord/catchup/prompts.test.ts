import { describe, expect, it } from 'bun:test';
import { buildCatchUpPrompt, buildCatchUpResumedPrompt, type CatchUpResumedOptions  } from '@/integrations/discord/catchup/prompts';

describe('buildCatchUpPrompt', () => {
    it('should include time context', () => {
        const prompt = buildCatchUpPrompt(15, 3);
        expect(prompt).toContain('## Current Time');
        expect(prompt).toContain('UTC:');
    });

    it('should include unread count and channel count', () => {
        const prompt = buildCatchUpPrompt(15, 3);
        expect(prompt).toContain('15 unread messages');
        expect(prompt).toContain('3 channels');
    });

    it('should include inbox tool names', () => {
        const prompt = buildCatchUpPrompt(5, 2);
        expect(prompt).toContain('getUnreadOverview');
        expect(prompt).toContain('getChannelSummary');
        expect(prompt).toContain('fetchMessages');
        expect(prompt).toContain('markAsRead');
        expect(prompt).toContain('markChannelRead');
    });

    it('should include workflow guidance', () => {
        const prompt = buildCatchUpPrompt(10, 2);
        expect(prompt).toContain('Recommended Workflow');
        expect(prompt).toContain('Mark as read LAST');
        expect(prompt).toContain('Task Tracking');
    });

    it('should handle singular counts', () => {
        const prompt = buildCatchUpPrompt(1, 1);
        expect(prompt).toContain('1 unread message');  // singular
        expect(prompt).toContain('1 channel');  // singular
        expect(prompt).not.toContain('1 unread messages');  // verify singular
        expect(prompt).not.toContain('1 channels');  // verify singular
    });

    it('should handle plural counts', () => {
        const prompt = buildCatchUpPrompt(2, 2);
        expect(prompt).toContain('2 unread messages');  // plural
        expect(prompt).toContain('2 channels');  // plural
        expect(prompt).not.toContain('2 unread message across');  // verify plural (message vs messages)
    });
});

describe('buildCatchUpResumedPrompt', () => {
    it('should include time context', () => {
        const options: CatchUpResumedOptions = {
            viewedChannels:    ['general'],
            remainingUnread:   5,
            remainingChannels: 2,
            newMessage:        {
                author:      'Alice',
                channelName: 'general',
                content:     'Hello!',
            },
        };
        const prompt = buildCatchUpResumedPrompt(options);
        expect(prompt).toContain('## Current Time');
        expect(prompt).toContain('UTC:');
    });

    it('should include viewed channels', () => {
        const options: CatchUpResumedOptions = {
            viewedChannels:    ['general', 'random'],
            remainingUnread:   5,
            remainingChannels: 2,
            newMessage:        {
                author:      'Alice',
                channelName: 'general',
                content:     'Hello!',
            },
        };
        const prompt = buildCatchUpResumedPrompt(options);
        expect(prompt).toContain('general, random');  // verify comma-space separator
    });

    it('should show "None yet" when no channels viewed', () => {
        const options: CatchUpResumedOptions = {
            viewedChannels:    [],
            remainingUnread:   10,
            remainingChannels: 3,
            newMessage:        {
                author:      'Bob',
                channelName: 'help',
                content:     'Need assistance',
            },
        };
        const prompt = buildCatchUpResumedPrompt(options);
        expect(prompt).toContain('None yet');
    });

    it('should include new message details', () => {
        const options: CatchUpResumedOptions = {
            viewedChannels:    [],
            remainingUnread:   5,
            remainingChannels: 1,
            newMessage:        {
                author:      'Charlie',
                channelName: 'dev',
                content:     'Check this PR',
            },
        };
        const prompt = buildCatchUpResumedPrompt(options);
        expect(prompt).toContain('Charlie');
        expect(prompt).toContain('#dev');
        expect(prompt).toContain('Check this PR');
    });

    it('should include remaining unread state', () => {
        const options: CatchUpResumedOptions = {
            viewedChannels:    ['general'],
            remainingUnread:   8,
            remainingChannels: 2,
            newMessage:        {
                author:      'Dan',
                channelName: 'general',
                content:     'Hi',
            },
        };
        const prompt = buildCatchUpResumedPrompt(options);
        expect(prompt).toContain('8 unread messages remain');
        expect(prompt).toContain('2 channels');
    });

    it('should handle singular remaining counts', () => {
        const options: CatchUpResumedOptions = {
            viewedChannels:    ['general'],
            remainingUnread:   1,
            remainingChannels: 1,
            newMessage:        {
                author:      'Eve',
                channelName: 'random',
                content:     'Test',
            },
        };
        const prompt = buildCatchUpResumedPrompt(options);
        expect(prompt).toContain('1 unread message remains');
        expect(prompt).toContain('1 channel');
        expect(prompt).not.toContain('1 unread messages remain');  // verify singular
        expect(prompt).not.toContain('1 channels');  // verify singular
    });

    it('should handle plural remaining counts', () => {
        const options: CatchUpResumedOptions = {
            viewedChannels:    ['general'],
            remainingUnread:   5,
            remainingChannels: 3,
            newMessage:        {
                author:      'Frank',
                channelName: 'dev',
                content:     'Test',
            },
        };
        const prompt = buildCatchUpResumedPrompt(options);
        expect(prompt).toContain('5 unread messages remain');
        expect(prompt).toContain('3 channels');
        expect(prompt).not.toContain('5 unread message remains across');  // verify plural (message vs messages)
    });

    it('should present new message for prioritization', () => {
        const options: CatchUpResumedOptions = {
            viewedChannels:    ['general'],
            remainingUnread:   5,
            remainingChannels: 2,
            newMessage:        {
                author:      'Alice',
                channelName: 'general',
                content:     'Hello!',
            },
        };
        const prompt = buildCatchUpResumedPrompt(options);
        expect(prompt).toContain('CATCH-UP SESSION RESUMED');
        expect(prompt).toContain('MESSAGE HANDLED');
        expect(prompt).toContain('What To Do');
        expect(prompt).toContain('already been handled by your normal conversation flow');
    });

    it('should tell agent to continue catching up after handling', () => {
        const options: CatchUpResumedOptions = {
            viewedChannels:    ['general'],
            remainingUnread:   3,
            remainingChannels: 1,
            newMessage:        {
                author:      'Bob',
                channelName: 'help',
                content:     'Need help',
            },
        };
        const prompt = buildCatchUpResumedPrompt(options);
        expect(prompt).toContain('Continue catching up on remaining channels');
        expect(prompt).toContain('inbox tools are still available');
    });
});

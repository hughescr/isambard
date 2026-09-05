import { describe, test, expect } from 'bun:test';
import { buildCatchupText, type CatchupSummary } from '../../../../src/agent/session/catchup-text';

describe('buildCatchupText', () => {
    test('uses singular forms for 1 unread message in 1 channel', () => {
        const text = buildCatchupText({ unreadCount: 1, channelCount: 1 });

        expect(text).toContain('1 unread message');
        expect(text).toContain('1 channel');
        expect(text).not.toContain('1 unread messages');
        expect(text).not.toContain('1 channels');
    });

    test('uses plural forms for multiple unread messages across multiple channels', () => {
        const summary: CatchupSummary = { unreadCount: 3, channelCount: 2 };
        const text = buildCatchupText(summary);

        expect(text).toContain('3 unread messages');
        expect(text).toContain('2 channels');
    });

    test('lists the four inbox tool names', () => {
        const text = buildCatchupText({ unreadCount: 2, channelCount: 1 });

        expect(text).toContain('getUnreadOverview');
        expect(text).toContain('getChannelSummary');
        expect(text).toContain('fetchMessages');
        expect(text).toContain('markAsRead');
        expect(text).toContain('markChannelRead');
    });

    test('recommends the overview -> summaries -> fetch -> record -> reply -> mark-read-last workflow', () => {
        const text = buildCatchupText({ unreadCount: 2, channelCount: 1 });

        const overviewIndex = text.indexOf('getUnreadOverview');
        const summaryIndex = text.indexOf('getChannelSummary');
        const fetchIndex = text.indexOf('fetchMessages');
        const recordIndex = text.indexOf('memory');
        const markReadIndex = text.indexOf('LAST');

        expect(overviewIndex).toBeGreaterThan(-1);
        expect(summaryIndex).toBeGreaterThan(overviewIndex);
        expect(fetchIndex).toBeGreaterThan(summaryIndex);
        expect(recordIndex).toBeGreaterThan(fetchIndex);
        expect(markReadIndex).toBeGreaterThan(recordIndex);
        expect(text).toContain('LAST');
    });

    test('says not all messages need responses', () => {
        const text = buildCatchupText({ unreadCount: 2, channelCount: 1 });

        expect(text).toContain('Not all messages need responses');
    });

    test('contains no time header, ephemeral-session language, or unavailable-tools language', () => {
        const text = buildCatchupText({ unreadCount: 2, channelCount: 1 });

        expect(text).not.toContain('Current Time');
        expect(text).not.toContain('ephemeral');
        expect(text).not.toContain('will not be available');
    });
});

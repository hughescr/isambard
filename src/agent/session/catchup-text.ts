/**
 * Pure catch-up envelope body text.
 *
 * The platform-neutral catch-up body builder for the long-lived session core: it carries no
 * time header (the envelope's caller-supplied `timeHeader` covers that) and no "Sessions are
 * ephemeral" / "inbox tools will not be available" language, since the long-lived session's
 * inbox tools stay attached for every turn. `src/integrations/discord/setup/catchup-setup.ts`
 * (`runConductorInboxInit`, agent -> discord imports being forbidden by eslint-plugin-boundaries
 * means the dependency runs the other way) is the consumer that builds `envelope.ts`'s merged
 * boot/catch-up envelope around this module's text.
 *
 * @module agent/session/catchup-text
 */

/** Plain counts describing what is waiting in the inbox; no discord-specific types. */
export interface CatchupSummary {
    unreadCount:  number
    channelCount: number
}

/**
 * Builds the catch-up envelope's body text: the unread/channel summary sentence, the inbox
 * tool list, the recommended workflow, and a closing reminder that not every message needs a
 * reply.
 * @param summary Unread message and channel counts
 * @returns Catch-up body text
 */
export function buildCatchupText({ unreadCount, channelCount }: CatchupSummary): string {
    const messageWord = unreadCount === 1 ? 'message' : 'messages';
    const channelWord = channelCount === 1 ? 'channel' : 'channels';

    const summary = `You have ${unreadCount} unread ${messageWord} across ${channelCount} ${channelWord}.`;

    const tools = [
        'Your inbox tools:',
        '- getUnreadOverview: see which channels have unread messages',
        '- getChannelSummary: get a quick summary of one channel',
        '- fetchMessages: fetch the full text of messages in a channel',
        '- markAsRead / markChannelRead: mark messages as read',
    ].join('\n');

    const workflow = [
        'Recommended workflow:',
        '1. Call getUnreadOverview to see what is waiting.',
        '2. Call getChannelSummary for each channel with unread messages.',
        '3. Call fetchMessages only when you need the full text.',
        '4. Record anything worth remembering to memory before replying.',
        '5. Reply where a reply is warranted.',
        '6. Mark as read LAST, after you have replied.',
    ].join('\n');

    return [
        summary,
        tools,
        workflow,
        'Not all messages need responses — use your judgment about what warrants a reply.',
    ].join('\n\n');
}

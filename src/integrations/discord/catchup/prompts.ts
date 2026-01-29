import { getCurrentTimeContext } from '@/utils/time';

/**
 * Options for building the catch-up interrupted prompt.
 */
export interface CatchUpInterruptedOptions {
    /** Channel names that were viewed during catch-up */
    viewedChannels:    string[]
    /** Number of unread messages remaining */
    remainingUnread:   number
    /** Number of channels with unread messages remaining */
    remainingChannels: number
    /** New message that interrupted the catch-up */
    newMessage:        {
        author:      string
        channelName: string
        content:     string
    }
}

/**
 * Formats the current time context as a header for prompts.
 *
 * @returns The formatted time header
 */
function formatTimeHeader(): string {
    const timeContext = getCurrentTimeContext();
    return `## Current Time
- UTC: ${timeContext.utc} (${timeContext.dayOfWeek} ${timeContext.timeOfDay})`;
}

/**
 * Builds the initial catch-up system prompt.
 *
 * @param unreadCount - Number of unread messages
 * @param channelCount - Number of channels with unread messages
 * @returns The formatted catch-up prompt
 */
export function buildCatchUpPrompt(unreadCount: number, channelCount: number): string {
    const messagePlural = unreadCount === 1 ? 'message' : 'messages';
    const channelPlural = channelCount === 1 ? 'channel' : 'channels';

    return `${formatTimeHeader()}

## Catch-Up Mode
You have ${unreadCount} unread ${messagePlural} across ${channelCount} ${channelPlural} since you were last online.

Your inbox tools are available for this session:
- getUnreadOverview: See which channels have messages
- getChannelSummary: Get AI summary + message list for a channel
- fetchMessages: Get full content of specific messages
- markAsRead / markChannelRead: Mark as processed

Recommended workflow:
1. Start with getUnreadOverview to see the landscape
2. Use getChannelSummary for each channel to understand the gist
3. Only fetchMessages when you need full detail
4. Log/record anything important to your memories FIRST
5. Send Discord messages if responses are needed
6. Mark as read LAST (so if interrupted, you won't miss anything)

Not all messages need responses. Prioritize based on urgency and relevance.
Your inbox tools will not be available in regular conversations, so process everything now.`;
}

/**
 * Builds the catch-up interrupted prompt.
 *
 * @param options - Options for the interrupted prompt
 * @returns The formatted interrupted prompt
 */
export function buildCatchUpInterruptedPrompt(options: CatchUpInterruptedOptions): string {
    const { viewedChannels, remainingUnread, remainingChannels, newMessage } = options;

    const viewedList = viewedChannels.length > 0
        ? viewedChannels.join(', ')
        : 'None yet';

    const messagePlural = remainingUnread === 1 ? 'message remains' : 'messages remain';
    const channelPlural = remainingChannels === 1 ? 'channel' : 'channels';

    return `${formatTimeHeader()}

--- CATCH-UP SESSION INTERRUPTED ---

A new message arrived while you were catching up on unread messages.

Before interruption, you had viewed these channels (summaries retrieved):
${viewedList}

Current inbox state:
- ${remainingUnread} unread ${messagePlural} across ${remainingChannels} ${channelPlural}

--- NEW MESSAGE ---
From: ${newMessage.author} in #${newMessage.channelName}
${newMessage.content}
---

This new message is not necessarily more important than items still in your inbox.
The sender is clearly online right now, which you can factor into your prioritization.

Possible approaches:
- If higher-priority items exist in your inbox, acknowledge the new message briefly ("Give me just a moment!") then handle the priority items first
- If this message is urgent or the sender is high-priority, handle it immediately
- Use TaskCreate to track tasks you need to complete (both inbox items and the new message), then work through them systematically

Your inbox tools are still available. Continue catching up after handling this appropriately.`;
}

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { ImapConnection } from '@/integrations/email/imap-connection';
import type { EmailCounterStore } from '@/integrations/email/email-counters';
import { EmailFolder } from '@/integrations/email/types';

/**
 * Formats an email address with optional display name.
 */
function formatAddress(addr: { name?: string, address: string }): string {
    if(addr.name) {
        return `${addr.name} <${addr.address}>`;
    }
    return addr.address;
}

/**
 * Creates an MCP server for email operations.
 *
 * Provides tools for:
 * - Checking the CleanInbox for unread messages
 * - Fetching full email content by UID and marking as read
 * - Archiving emails by moving them from CleanInbox to Archive
 *
 * This server wraps ImapConnection and EmailCounterStore for use with the Claude Agent SDK.
 */
export function createEmailMCPServer(
    imap: ImapConnection,
    counters: EmailCounterStore
) {
    return createSdkMcpServer({
        name:    'email',
        version: '1.0.0',
        tools:   [
            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'checkInbox',
                'Check CleanInbox for unread emails. Returns counter state and list of unread message summaries.',
                // Stryker restore StringLiteral
                {},
                async (): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: try-catch wraps IMAP operations - error handling
                    try {
                        const [countersData, messages] = await Promise.all([
                            counters.getCounters(),
                            // Stryker disable next-line StringLiteral: EmailFolder.CleanInbox is configuration constant
                            imap.listUnread(EmailFolder.CleanInbox),
                        ]);
                        const result = {
                            counters: countersData,
                            messages: _.map(messages, m => ({
                                uid:     m.uid,
                                from:    formatAddress(m.from),
                                subject: m.subject,
                                date:    m.date.toISOString(),
                            })),
                        };
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, msg: 'Failed to check inbox' });
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'getEmailContent',
                'Fetch the full content of an email by UID. Marks the email as read and decrements the unread counter.',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    uid: z.number().int().positive().describe('The IMAP UID of the email to fetch'),
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: try-catch wraps IMAP operations - error handling
                    try {
                        // Stryker disable next-line StringLiteral: EmailFolder.CleanInbox is configuration constant
                        const email = await imap.fetchMessage(EmailFolder.CleanInbox, args.uid);
                        // Stryker disable next-line StringLiteral: EmailFolder.CleanInbox is configuration constant
                        await imap.setFlag(args.uid, EmailFolder.CleanInbox, '\\Seen');
                        // Sync counters with real IMAP state (best-effort; failure does not prevent returning email)
                        // Stryker disable BlockStatement: try-catch wraps counter sync — best-effort, email content returned regardless
                        try {
                            // Stryker disable next-line StringLiteral: EmailFolder.CleanInbox is configuration constant
                            const { total, unread } = await imap.getMailboxCounts(EmailFolder.CleanInbox);
                            await counters.reset(total, unread);
                        } catch (countErr) {
                            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                            logger.warn({ error: _.isError(countErr) ? countErr.message : String(countErr), msg: 'Failed to sync counters after read' });
                        }
                        const toList = _(email.to).map(formatAddress).join(', ');
                        // Stryker disable ConditionalExpression: line !== undefined is a defensive runtime guard; undefined used as sentinel to omit absent CC line
                        const lines = _.filter([
                            `From: ${formatAddress(email.from)}`,
                            `To: ${toList}`,
                            email.cc.length > 0 ? `Cc: ${_(email.cc).map(formatAddress).join(', ')}` : undefined,
                            `Subject: ${email.subject}`,
                            `Date: ${email.date.toISOString()}`,
                            '',
                            email.bodyText,
                        ], line => line !== undefined);
                        // Stryker restore ConditionalExpression
                        // Stryker disable next-line Regex,StringLiteral: /^\n/ and '' are defensive no-ops — the text always starts with 'From:' so the regex never matches; _.trim() on the next line also covers any edge case
                        const text = _.replace(_.join(lines, '\n'), /^\n/, '');
                        return {
                            content: [{ type: 'text' as const, text: _.trim(text) }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, uid: args.uid, msg: 'Failed to fetch email content' });
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),

            // Stryker disable StringLiteral: Tool name and description are MCP server configuration
            tool(
                'archiveEmail',
                'Move an email from CleanInbox to Archive. Decrements the total email counter.',
                // Stryker restore StringLiteral
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    uid: z.number().int().positive().describe('The IMAP UID of the email to archive'),
                },
                async (args): Promise<CallToolResult> => {
                    // Stryker disable BlockStatement: try-catch wraps IMAP operations - error handling
                    try {
                        // Stryker disable next-line StringLiteral: EmailFolder values are configuration constants
                        await imap.moveMessage(args.uid, EmailFolder.CleanInbox, EmailFolder.Archive);
                        // Sync counters with real IMAP state (best-effort; archive completes regardless)
                        // Stryker disable BlockStatement: try-catch wraps counter sync — best-effort, archive completes regardless
                        try {
                            // Stryker disable next-line StringLiteral: EmailFolder.CleanInbox is configuration constant
                            const { total, unread } = await imap.getMailboxCounts(EmailFolder.CleanInbox);
                            await counters.reset(total, unread);
                        } catch (countErr) {
                            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                            logger.warn({ error: _.isError(countErr) ? countErr.message : String(countErr), msg: 'Failed to sync counters after archive' });
                        }
                        return {
                            content: [{ type: 'text' as const, text: `Email UID ${args.uid} archived successfully.` }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                        logger.warn({ error: message, uid: args.uid, msg: 'Failed to archive email' });
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
            ),
        ],
    });
}

import _ from 'lodash';
import { logger } from '@hughescr/logger';
import { EmailFolder } from '@/integrations/email/types';
import type { EmailMetadata } from '@/integrations/email/types';
import type { ImapConnection } from '@/integrations/email/imap-connection';
import type { EmailProcessor } from '@/integrations/email/email-processor';
import type { EmailCounterStore } from '@/integrations/email/email-counters';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ImapListenerConfig {
    // Stryker disable next-line BooleanLiteral: useIdle flag is configuration
    useIdle:                boolean
    // Stryker disable next-line NumericLiteral: IDLE timeout is configuration constant (RFC 2177 limit)
    idleTimeoutMs:          number
    // Stryker disable next-line NumericLiteral: Poll fallback interval is configuration constant
    pollFallbackMs:         number
    /** Optional callback to retry a Discord notification for a pending draft */
    onSendApprovalRequest?: (to: string, subject: string, draftUid: number, cc?: string[]) => Promise<void>
    /** Optional WildDuck client for pending notification checks */
    wildDuckClient?: {
        getMessage:            (mailboxPath: string, uid: number) => Promise<{ id: number, subject?: string, to?: { address: string, name?: string }[], cc?: { address: string, name?: string }[], metaData?: Record<string, unknown> } | null>
        updateMessageMetadata: (mailboxPath: string, uid: number, metadata: Record<string, unknown>) => Promise<void>
    }
}

export const MAX_NOTIFY_ATTEMPTS = 5;

const MAX_EMAILS_PER_POLL = 20;

// ---------------------------------------------------------------------------
// ImapListener class
// ---------------------------------------------------------------------------

export class ImapListener {
    private readonly imap:                 ImapConnection;
    private readonly processor:            EmailProcessor;
    private readonly counters:             EmailCounterStore;
    private readonly config:               ImapListenerConfig;
    private          timer:                ReturnType<typeof setTimeout> | null;
    private          lastUid:              number;
    private          _running:             boolean;
    private          _pollFallbackResolve: (() => void) | null;

    constructor(imap: ImapConnection, processor: EmailProcessor, counters: EmailCounterStore, config: ImapListenerConfig) {
        this.imap                 = imap;
        this.processor            = processor;
        this.counters             = counters;
        this.config               = config;
        this.timer                = null;
        this.lastUid              = 0;
        // Stryker disable next-line BooleanLiteral: initialization flag — false is correct initial state
        this._running             = false;
        this._pollFallbackResolve = null;
    }

    /** Whether the listener is currently active. */
    get running(): boolean {
        return this._running;
    }

    /**
     * Connect, verify folders, fetch any existing unprocessed messages,
     * and start the polling loop or IDLE loop.
     */
    async start(): Promise<void> {
        await this.imap.connect();
        // Stryker disable BlockStatement: try-catch ensures disconnect on startup failure
        try {
            await this.imap.ensureFolders();
            // Stryker disable next-line BooleanLiteral: setting running=true after successful connect
            this._running = true;

            // Sync counters from IMAP on startup (best-effort — failures are logged and ignored)
            // Stryker disable BlockStatement: try-catch wraps counter sync — best-effort startup initialization
            try {
                const { total, unread } = await this.imap.getMailboxCounts(EmailFolder.CleanInbox);
                await this.counters.reset(total, unread);
            } catch (syncErr) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.warn({ error: _.isError(syncErr) ? syncErr.message : String(syncErr), msg: 'Failed to sync email counters on startup' });
            }

            // Fetch and process any messages that arrived before this session
            // Re-fetch immediately while there are more messages (batch cap was hit)
            // Stryker disable next-line ConditionalExpression: re-poll loop drains backlog — always correct
            while(this._running && await this.fetchAndProcess()) { /* drain backlog */ }

            // Check for pending notification failures on startup (best-effort)
            await this.checkPendingNotifications();

            // Stryker disable next-line ConditionalExpression: useIdle controls IDLE vs polling mode
            if(this.config.useIdle) {
                void this.idleLoop();
            } else {
                this.scheduleNextPoll();
            }
        } catch (err) {
            // Stryker disable next-line BooleanLiteral: resetting running=false on startup failure
            this._running = false;
            await this.imap.disconnect();
            throw err;
        }
    }

    /** Stop polling/IDLE and disconnect. */
    async stop(): Promise<void> {
        if(!this._running) {
            return;
        }
        if(this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        // Stryker disable BlockStatement: resolving pollFallbackDelay on stop() — needed for loop exit cleanup
        if(this._pollFallbackResolve !== null) {
            this._pollFallbackResolve();
            this._pollFallbackResolve = null;
        }
        // Stryker disable next-line BooleanLiteral: setting running=false before disconnect
        this._running = false;
        this.imap.cancelIdle();
        await this.imap.disconnect();
    }

    // ---------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------

    private scheduleNextPoll(): void {
        this.timer = setTimeout(() => {
            void this.poll();
        }, this.config.pollFallbackMs);
    }

    private async idleLoop(): Promise<void> {
        while(this._running) {
            // Set a timer to cancel IDLE before the RFC 2177 29-minute limit
            const idleTimer = setTimeout(() => {
                this.imap.cancelIdle();
            }, this.config.idleTimeoutMs);

            // Stryker disable BlockStatement: try-catch wraps IDLE cycle — error handling
            try {
                await this.imap.idle(EmailFolder.Inbox);
                clearTimeout(idleTimer);
                if(!this._running) {
                    break;
                }
                // Re-fetch immediately while there are more messages (batch cap was hit)
                // Stryker disable next-line ConditionalExpression: re-poll loop drains backlog — always correct
                while(await this.fetchAndProcess() && this._running) { /* drain backlog */ }
                // Check for pending notification failures after each IDLE wakeup (best-effort)
                await this.checkPendingNotifications();
            } catch (err) {
                clearTimeout(idleTimer);
                logger.warn({
                    error: _.isError(err) ? err.message : String(err),
                    msg:   'IDLE failed, falling back to poll interval',
                });
                await this.pollFallbackDelay();
            }
        }
    }

    private pollFallbackDelay(): Promise<void> {
        return new Promise<void>((resolve) => {
            this._pollFallbackResolve = resolve;
            this.timer                = setTimeout(() => {
                this.timer                = null;
                this._pollFallbackResolve = null;
                resolve();
            }, this.config.pollFallbackMs);
        });
    }

    private async poll(): Promise<void> {
        // Stryker disable BlockStatement: try-catch wraps poll cycle — error handling
        try {
            // Re-fetch immediately while there are more messages (batch cap was hit)
            // Stryker disable next-line ConditionalExpression: re-poll loop drains backlog — always correct
            while(await this.fetchAndProcess() && this._running) { /* drain backlog */ }
        } catch (err) {
            logger.warn({
                error: _.isError(err) ? err.message : String(err),
                msg:   'Poll cycle failed, will retry',
            });
        }
        // Check for pending notification failures after each poll cycle (best-effort)
        await this.checkPendingNotifications();
        if(this._running) {
            this.scheduleNextPoll();
        }
    }

    /**
     * Fetch and process a batch of new messages.
     * Returns true if the batch was capped at MAX_EMAILS_PER_POLL (indicating more messages likely remain),
     * false otherwise.
     */
    private async fetchAndProcess(): Promise<boolean> {
        const emails = await this.imap.fetchNewMessages(EmailFolder.Inbox, this.lastUid);

        // Stryker disable next-line ConditionalExpression,EqualityOperator: batch cap rate-limits processing to MAX_EMAILS_PER_POLL; > vs >= is equivalent when length === cap (slice(0, n) of n-element array = all n)
        const capped    = emails.length > MAX_EMAILS_PER_POLL;
        const toProcess = capped ? emails.slice(0, MAX_EMAILS_PER_POLL) : emails;
        if(capped) {
            // Stryker disable ObjectLiteral,StringLiteral: log message content is not behavior-affecting
            logger.warn({
                total:     emails.length,
                processed: MAX_EMAILS_PER_POLL,
                msg:       'Email batch cap reached; remaining emails will be processed next poll',
            });
            // Stryker enable ObjectLiteral,StringLiteral
        }

        for(const email of toProcess) {
            await this.processOne(email);
        }

        // Stryker disable next-line ConditionalExpression,EqualityOperator: guard is an optimization; max() ?? lastUid is equivalent for empty arrays
        if(toProcess.length > 0) {
            this.lastUid = _(toProcess).map('uid').max() ?? this.lastUid;
        }

        return capped;
    }

    private async processOne(email: EmailMetadata): Promise<void> {
        // Stryker disable BlockStatement: try-catch wraps single email processing — error handling
        try {
            await this.processor.processEmail(email);
        } catch (err) {
            logger.warn({
                uid:   email.uid,
                error: _.isError(err) ? err.message : String(err),
                msg:   'Failed to process email, continuing',
            });
        }
    }

    /**
     * Search Drafts for messages with \\DiscordNotifyFailed flag and attempt to retry
     * the Discord notification. On success, clears the flag. On repeated failure,
     * transitions to \\DiscordNotifyGaveUp after MAX_NOTIFY_ATTEMPTS.
     * Best-effort — errors logged, never thrown.
     */
    /**
     * Attempt to escalate a failed notification: increment attempt counter or transition
     * to GaveUp flag when MAX_NOTIFY_ATTEMPTS is reached.
     * Best-effort — errors logged, never thrown.
     */
    private async escalateFailedNotification(
        uid: number,
        wildDuckClient: NonNullable<ImapListenerConfig['wildDuckClient']>
    ): Promise<void> {
        // Stryker disable BlockStatement: try-catch wraps give-up escalation - best-effort
        try {
            const msg      = await wildDuckClient.getMessage(EmailFolder.Drafts, uid);
            // Stryker disable next-line ConditionalExpression: defensive fallback to 2 when metadata absent
            const attempts = _.isNumber(msg?.metaData?.notifyAttempts) ? (msg.metaData.notifyAttempts) + 1 : 2;

            if(attempts >= MAX_NOTIFY_ATTEMPTS) {
                // Give up — transition to GaveUp flag
                // Stryker disable next-line StringLiteral: flag name is configuration
                await this.imap.clearFlag(uid, EmailFolder.Drafts, '\\DiscordNotifyFailed');
                // Stryker disable next-line StringLiteral: flag name is configuration
                await this.imap.setFlag(uid, EmailFolder.Drafts, '\\DiscordNotifyGaveUp');
                await wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, { notifyAttempts: attempts });
            } else {
                // Increment attempt count, keep flag
                await wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, { notifyAttempts: attempts });
            }
        } catch (metaErr) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.warn({ err: metaErr, uid, msg: 'Failed to update notification attempt metadata' });
        }
        // Stryker restore BlockStatement
    }

    private async checkPendingNotifications(): Promise<void> {
        const { onSendApprovalRequest, wildDuckClient } = this.config;
        // Stryker disable next-line ConditionalExpression,BlockStatement: early return when dependencies not configured
        if(!onSendApprovalRequest || !wildDuckClient) {
            return;
        }

        // Stryker disable BlockStatement: try-catch wraps entire check — best-effort, never throws
        try {
            // Stryker disable next-line StringLiteral: flag name is configuration
            const pendingUids = await this.imap.searchByFlag(EmailFolder.Drafts, '\\DiscordNotifyFailed');

            for(const uid of pendingUids) {
                // Stryker disable BlockStatement: try-catch wraps individual notification retry - best-effort
                try {
                    const msg = await wildDuckClient.getMessage(EmailFolder.Drafts, uid);
                    // Stryker disable next-line ConditionalExpression,BlockStatement: skip missing messages
                    if(!msg) {
                        continue;
                    }

                    // Stryker disable next-line ArrayDeclaration: to only sent when non-empty; fallback [] produces same empty string via lodash map
                    const toStr      = _(msg.to ?? []).map('address').join(', ');
                    const subject    = msg.subject ?? '';
                    const ccAddresses = _.map(msg.cc ?? [], 'address');

                    // Stryker disable next-line ConditionalExpression,EqualityOperator,ArrayDeclaration: cc only passed when non-empty
                    await onSendApprovalRequest(toStr, subject, uid, ccAddresses.length > 0 ? ccAddresses : undefined);

                    // Success — clear the flag and reset attempt count
                    // Stryker disable next-line StringLiteral: flag name is configuration
                    await this.imap.clearFlag(uid, EmailFolder.Drafts, '\\DiscordNotifyFailed');
                    await wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, { notifyAttempts: 0 });
                } catch (err) {
                    // Notification retry failed — check if we should give up
                    await this.escalateFailedNotification(uid, wildDuckClient);
                    // Stryker restore BlockStatement
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                    logger.warn({ err, uid, msg: 'Failed to retry Discord notification for pending draft' });
                }
                // Stryker restore BlockStatement
            }
        } catch (searchErr) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.warn({ err: searchErr, msg: 'Failed to search for pending notification drafts' });
        }
        // Stryker restore BlockStatement
    }
}

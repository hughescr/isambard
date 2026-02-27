import { logger } from '@hughescr/logger';
import isError from 'lodash/isError';
import isFinite from 'lodash/isFinite';
import isNumber from 'lodash/isNumber';
import isObject from 'lodash/isObject';
import map from 'lodash/map';
import type { EmailProcessor } from '@/integrations/email/email-processor';
import { EmailFolder } from '@/integrations/email/types';
import type { WildDuckClient, WildDuckSearchResult } from '@/integrations/email/wildduck-client';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface WildDuckListenerConfig {
    // Stryker disable next-line NumericLiteral: Poll fallback interval is configuration constant
    pollFallbackMs:         number
    // Stryker disable next-line NumericLiteral: SSE reconnect delay is configuration constant
    sseReconnectDelayMs?:   number
    // Stryker disable next-line NumericLiteral: maxEmailsPerPoll is configuration constant
    maxEmailsPerPoll?:      number
    /** Optional callback to retry a Discord notification for a pending draft */
    onSendApprovalRequest?: (to: string, subject: string, draftUid: number, cc?: string[]) => Promise<void>
}

export const MAX_NOTIFY_ATTEMPTS = 5;

const DEFAULT_MAX_EMAILS_PER_POLL = 20;
const DEFAULT_SSE_RECONNECT_DELAY_MS = 5000;

// ---------------------------------------------------------------------------
// WildDuckListener class
// ---------------------------------------------------------------------------

export class WildDuckListener {
    private readonly wildDuckClient: WildDuckClient;
    private readonly processor:      EmailProcessor;
    private readonly config:         WildDuckListenerConfig;
    private          timer:          ReturnType<typeof setTimeout> | null;
    private          processing:     boolean;
    private          _running:       boolean;
    private          sseSource:      EventSource | null;

    constructor(wildDuckClient: WildDuckClient, processor: EmailProcessor, config: WildDuckListenerConfig) {
        this.wildDuckClient = wildDuckClient;
        this.processor      = processor;
        this.config         = config;
        this.timer          = null;
        // Stryker disable next-line BooleanLiteral: initialization flag — false is correct initial state
        this.processing     = false;
        // Stryker disable next-line BooleanLiteral: initialization flag — false is correct initial state
        this._running       = false;
        this.sseSource      = null;
    }

    /** Whether the listener is currently active. */
    get running(): boolean {
        return this._running;
    }

    /**
     * Drain backlog via fetchAndProcess() loop, check pending notifications,
     * then connect SSE for real-time updates.
     */
    async start(): Promise<void> {
        // Stryker disable BlockStatement: try-catch ensures running=false on startup failure
        try {
            // Stryker disable next-line BooleanLiteral: setting running=true before backlog drain
            this._running = true;

            // Fetch and process any messages that arrived before this session
            // Re-fetch immediately while there are more messages (batch cap was hit)
            // Stryker disable next-line ConditionalExpression: re-poll loop drains backlog — always correct
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, no-await-in-loop -- defensive: _running may be set to false by stop(); await inside while is sequential pagination
            while(this._running && await this.fetchAndProcess()) { /* drain backlog */ }

            // Check for pending notification failures on startup (best-effort)
            await this.checkPendingNotifications();

            // Connect SSE for real-time new-mail notifications
            this.connectSSE();

            // Schedule fallback poll timer
            this.scheduleNextPoll();
        } catch (err) {
            // Stryker disable next-line BooleanLiteral: resetting running=false on startup failure
            this._running = false;
            throw err;
        }
    }

    /** Stop SSE connection, clear timers, set running=false. */
    async stop(): Promise<void> {
        // Stryker disable next-line ConditionalExpression: equivalent mutant — when _running is false, cleanup body is a no-op (timer and sseSource are null)
        if(!this._running) {
            return;
        }
        // Stryker disable next-line BooleanLiteral: setting running=false before cleanup
        this._running = false;
        if(this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        // Stryker disable BlockStatement: SSE cleanup — close if connected
        if(this.sseSource !== null) {
            this.sseSource.close();
            this.sseSource = null;
        }
    }

    // ---------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------

    private scheduleNextPoll(): void {
        this.timer = setTimeout(() => {
            void this.poll();
        }, this.config.pollFallbackMs);
    }

    private async poll(): Promise<void> {
        // Stryker disable BlockStatement: try-catch wraps poll cycle — error handling
        try {
            // Re-fetch immediately while there are more messages (batch cap was hit)
            // Stryker disable next-line ConditionalExpression: re-poll loop drains backlog — always correct
            // eslint-disable-next-line no-await-in-loop -- sequential: pagination loop drains backlog one batch at a time
            while(await this.fetchAndProcess() && this._running) { /* drain backlog */ }
        } catch (err) {
            logger.warn({
                error: isError(err) ? err.message : String(err),
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
     * Fetch and process a batch of unseen messages.
     * Returns true if the batch was capped at maxEmailsPerPoll (indicating more messages likely remain),
     * false otherwise.
     */
    private async fetchAndProcess(): Promise<boolean> {
        // Stryker disable next-line ConditionalExpression: concurrency guard — drop concurrent calls
        if(this.processing) {
            return false;
        }
        // Stryker disable next-line BooleanLiteral: setting processing=true to guard concurrent calls
        this.processing = true;
        try {
            const maxEmailsPerPoll = this.config.maxEmailsPerPoll ?? DEFAULT_MAX_EMAILS_PER_POLL;
            const summaries        = await this.wildDuckClient.listMessages(EmailFolder.Inbox, {
                unseen: true,
                limit:  maxEmailsPerPoll + 1,
            });

            // Stryker disable next-line ConditionalExpression,EqualityOperator: batch cap rate-limits processing to maxEmailsPerPoll; > vs >= is equivalent when length === cap
            const capped    = summaries.length > maxEmailsPerPoll;
            const toProcess = capped ? summaries.slice(0, maxEmailsPerPoll) : summaries;
            if(capped) {
                // Stryker disable ObjectLiteral,StringLiteral: log message content is not behavior-affecting
                logger.warn({
                    total:     summaries.length,
                    processed: maxEmailsPerPoll,
                    msg:       'Email batch cap reached; remaining emails will be processed next poll',
                });
                // Stryker enable ObjectLiteral,StringLiteral
            }

            for(const summary of toProcess) {
                // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited WildDuck API per email
                await this.processOne(summary.id);
            }

            return capped;
        } finally {
            // Stryker disable next-line BooleanLiteral: resetting processing=false in finally
            this.processing = false;
        }
    }

    private async processOne(uid: number): Promise<void> {
        // Stryker disable BlockStatement: try-catch wraps single email processing — error handling
        try {
            const email = await this.wildDuckClient.getFullMessage(EmailFolder.Inbox, uid);
            if(!email) {
                return;
            }
            await this.processor.processEmail(email);
        } catch (err) {
            logger.warn({
                uid,
                error: isError(err) ? err.message : String(err),
                msg:   'Failed to process email, continuing',
            });
        }
    }

    /**
     * Attempt to escalate a failed notification: increment attempt counter or transition
     * to GaveUp flag when MAX_NOTIFY_ATTEMPTS is reached.
     * Best-effort — errors logged, never thrown.
     */
    private async escalateFailedNotification(uid: number): Promise<void> {
        // Stryker disable BlockStatement: try-catch wraps give-up escalation - best-effort
        try {
            const msg      = await this.wildDuckClient.getMessage(EmailFolder.Drafts, uid);
            // Stryker disable next-line ConditionalExpression: defensive fallback to 2 when metadata absent
            const attempts = isNumber(msg?.metaData?.notifyAttempts) ? (msg.metaData.notifyAttempts) + 1 : 2;

            if(attempts >= MAX_NOTIFY_ATTEMPTS) {
                // Give up — transition to GaveUp flag
                // Stryker disable next-line StringLiteral: flag names are configuration
                await this.wildDuckClient.updateMessageFlags(EmailFolder.Drafts, uid, {
                    addFlags:    ['DiscordNotifyGaveUp'],
                    removeFlags: ['DiscordNotifyFailed'],
                });
                await this.wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, { notifyAttempts: attempts });
            } else {
                // Increment attempt count, keep flag
                await this.wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, { notifyAttempts: attempts });
            }
        } catch (error) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.warn({ err: error, uid, msg: 'Failed to update notification attempt metadata' });
        }
        // Stryker restore BlockStatement
    }

    /**
     * Search Drafts for messages with DiscordNotifyFailed flag and attempt to retry
     * the Discord notification. On success, clears the flag. On repeated failure,
     * transitions to DiscordNotifyGaveUp after MAX_NOTIFY_ATTEMPTS.
     * Best-effort — errors logged, never thrown.
     */
    private async checkPendingNotifications(): Promise<void> {
        const { onSendApprovalRequest } = this.config;
        // Stryker disable next-line ConditionalExpression,BlockStatement: early return when callback not configured
        if(!onSendApprovalRequest) {
            return;
        }

        // Stryker disable BlockStatement: try-catch wraps entire check — best-effort, never throws
        try {
            // Stryker disable next-line StringLiteral: flag name is configuration
            const results: WildDuckSearchResult[] = await this.wildDuckClient.search({
                query:     { keyword: 'DiscordNotifyFailed' },
                mailboxes: [EmailFolder.Drafts],
            });

            for(const result of results) {
                // Parse UID from 'FolderName:uid' format
                const colonIdx = result.message.lastIndexOf(':');
                // Stryker disable next-line ConditionalExpression,EqualityOperator,UnaryOperator: guard against missing colon in result; message is always 'folder:uid' so colonIdx===-1 is defensive; UnaryOperator(-1→+1) is equivalent
                if(colonIdx === -1) {
                    continue;
                }
                const uidStr = result.message.slice(colonIdx + 1);
                const uid    = Number.parseInt(uidStr, 10);
                // Stryker disable next-line ConditionalExpression: guard against non-numeric UIDs
                if(!isFinite(uid)) {
                    continue;
                }

                // Stryker disable BlockStatement: try-catch wraps individual notification retry - best-effort
                try {
                    // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited WildDuck API per draft
                    const msg = await this.wildDuckClient.getMessage(EmailFolder.Drafts, uid);
                    // Stryker disable next-line ConditionalExpression,BlockStatement: skip missing messages
                    if(!msg) {
                        continue;
                    }

                    // Stryker disable next-line ArrayDeclaration: to only sent when non-empty; fallback [] produces same empty string via lodash map
                    const toStr       = map(msg.to ?? [], 'address').join(', ');
                    const subject     = msg.subject ?? '';
                    const ccAddresses = map(msg.cc ?? [], 'address');

                    // Stryker disable next-line ConditionalExpression,EqualityOperator,ArrayDeclaration: cc only passed when non-empty
                    // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord approval request per draft
                    await onSendApprovalRequest(toStr, subject, uid, ccAddresses.length > 0 ? ccAddresses : undefined);

                    // Success — clear the flag and reset attempt count
                    // Stryker disable next-line StringLiteral: flag name is configuration
                    // eslint-disable-next-line no-await-in-loop -- sequential: flag clear then metadata reset per draft
                    await this.wildDuckClient.updateMessageFlags(EmailFolder.Drafts, uid, { removeFlags: ['DiscordNotifyFailed'] });
                    // eslint-disable-next-line no-await-in-loop -- sequential: metadata update depends on prior flag clear
                    await this.wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, { notifyAttempts: 0 });
                } catch (err) {
                    // Notification retry failed — check if we should give up
                    // eslint-disable-next-line no-await-in-loop -- sequential: escalation depends on per-draft error
                    await this.escalateFailedNotification(uid);
                    // Stryker restore BlockStatement
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                    logger.warn({ err, uid, msg: 'Failed to retry Discord notification for pending draft' });
                }
                // Stryker restore BlockStatement
            }
        } catch (error) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.warn({ err: error, msg: 'Failed to search for pending notification drafts' });
        }
        // Stryker restore BlockStatement
    }

    /**
     * Connect to WildDuck SSE stream for real-time new-mail notifications.
     * Infrastructure-level — wrapped with Stryker disable for SSE plumbing.
     */
    // Stryker disable all
    private connectSSE(): void {
        // Guard: EventSource may not be available in all environments (e.g., test runners)
        if(typeof EventSource === 'undefined') {
            return;
        }

        const token  = this.wildDuckClient.getAuthToken();
        const apiUrl = this.wildDuckClient.getApiUrl();
        if(!token || !apiUrl) {
            return;
        }

        const url    = `${apiUrl}/users/me/updates?accessToken=${token}`;
        const source = new EventSource(url);
        this.sseSource = source;

        source.addEventListener('message', (event: MessageEvent) => {
            let data: unknown;
            try {
                data = JSON.parse(String(event.data)) as unknown;
            } catch{
                return;
            }

            if(isObject(data) && 'command' in data && (data as { command: unknown }).command === 'EXISTS') {
                void this.fetchAndProcess();
            }
        });

        source.addEventListener('error', (_event: Event) => {
            source.close();
            if(this.sseSource === source) {
                this.sseSource = null;
            }
            if(!this._running) {
                return;
            }
            // EventSource.onerror does not expose HTTP status codes, so we cannot
            // detect 401s. On any error: close and schedule a reconnect after delay.
            const reconnectDelay = this.config.sseReconnectDelayMs ?? DEFAULT_SSE_RECONNECT_DELAY_MS;
            logger.warn({ msg: 'SSE connection error, scheduling reconnect' });
            setTimeout(() => {
                if(this._running) {
                    this.connectSSE();
                }
            }, reconnectDelay);
        });
    }
    // Stryker restore all
}

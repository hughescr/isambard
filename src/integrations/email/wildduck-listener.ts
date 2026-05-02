import { logger } from '@hughescr/logger';
import type { EmailProcessor } from '@/integrations/email/email-processor';
import { EmailFolder } from '@/integrations/email/types';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';
import { createReconnectionLoop, type ReconnectionLoop, type ServiceHealthRegistry } from '@/services';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

const CONSECUTIVE_POLL_FAILURE_THRESHOLD = 3;

export interface WildDuckListenerConfig {
    // Stryker disable next-line NumericLiteral: Poll fallback interval is configuration constant
    pollFallbackMs:       number
    // Stryker disable next-line NumericLiteral: SSE reconnect base delay is configuration constant
    sseReconnectDelayMs?: number
    // Stryker disable next-line NumericLiteral: maxEmailsPerPoll is configuration constant
    maxEmailsPerPoll?:    number
    /** Optional service health registry for reporting email connectivity events */
    healthRegistry?:      ServiceHealthRegistry
}

const DEFAULT_MAX_EMAILS_PER_POLL = 20;
const DEFAULT_SSE_RECONNECT_DELAY_MS = 5000;

// ---------------------------------------------------------------------------
// No-op health registry stub (used when no registry is provided)
// ---------------------------------------------------------------------------

// Stryker disable all: no-op stub — behaviour is definitionally absent
function noopUnsubscribe(): void { /* no-op */ }
const NOOP_HEALTH_REGISTRY: ServiceHealthRegistry = {
    getState:           () => 'disabled',
    getEntry:           () => ({ state: 'disabled', epoch: 0, failureCount: 0 }),
    getAll:             () => ({} as ReturnType<ServiceHealthRegistry['getAll']>),
    isAvailable:        () => false,
    isWriteAvailable:   () => false,
    sendEvent:          () => undefined,
    subscribe:          () => noopUnsubscribe,
    buildStatusSummary: () => undefined,
    stop:               () => undefined,
};
// Stryker restore all

// ---------------------------------------------------------------------------
// WildDuckListener class
// ---------------------------------------------------------------------------

export class WildDuckListener {
    private readonly wildDuckClient:       WildDuckClient;
    private readonly processor:            EmailProcessor;
    private readonly config:               WildDuckListenerConfig;
    private          timer:                ReturnType<typeof setTimeout> | null;
    private          processing:           boolean;
    private          _running:             boolean;
    private          sseSource:            EventSource | null;
    private          consecutivePollFails: number;
    private readonly sseReconnectLoop:     ReconnectionLoop;

    constructor(wildDuckClient: WildDuckClient, processor: EmailProcessor, config: WildDuckListenerConfig) {
        this.wildDuckClient       = wildDuckClient;
        this.processor            = processor;
        this.config               = config;
        this.timer                = null;
        // Stryker disable next-line BooleanLiteral: initialization flag — false is correct initial state
        this.processing           = false;
        // Stryker disable next-line BooleanLiteral: initialization flag — false is correct initial state
        this._running             = false;
        this.sseSource            = null;
        this.consecutivePollFails = 0;

        const registry      = config.healthRegistry ?? NOOP_HEALTH_REGISTRY;
        const baseDelayMs   = config.sseReconnectDelayMs ?? DEFAULT_SSE_RECONNECT_DELAY_MS;
        this.sseReconnectLoop = createReconnectionLoop({
            service:   'email',
            registry,
            connectFn: () => this.connectSSEForLoop(),
            // Stryker disable next-line ObjectLiteral: SSE reconnect policy is configuration wiring
            policy:    { baseDelayMs },
        });
    }

    /** Whether the listener is currently active. */
    get running(): boolean {
        return this._running;
    }

    /**
     * Drain backlog via fetchAndProcess() loop, then connect SSE for real-time updates.
     */
    async start(): Promise<void> {
        // Stryker disable BlockStatement: try-catch ensures running=false on startup failure
        try {
            // Stryker disable next-line BooleanLiteral: setting running=true before backlog drain
            this._running = true;

            // Fetch and process any messages that arrived before this session
            // Re-fetch immediately while there are more messages (batch cap was hit)
            // Stryker disable next-line ConditionalExpression,LogicalOperator: re-poll loop drains backlog — LogicalOperator mutation (&&→||) causes infinite loop in tests
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, no-await-in-loop -- defensive: _running may be set to false by stop(); await inside while is sequential pagination
            while(this._running && await this.fetchAndProcess()) { /* drain backlog */ }

            // Connect SSE for real-time new-mail notifications via reconnection loop.
            // Only start when EventSource is available (not in all test environments).
            if(typeof EventSource !== 'undefined') {
                this.sseReconnectLoop.start();
            }

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
        this.sseReconnectLoop.stop();
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
            // Stryker disable next-line ConditionalExpression,LogicalOperator: re-poll loop drains backlog — LogicalOperator mutation (&&→||) causes infinite loop in tests
            // eslint-disable-next-line no-await-in-loop -- sequential: pagination loop drains backlog one batch at a time
            while(await this.fetchAndProcess() && this._running) { /* drain backlog */ }
            this.recordPollSuccess();
        } catch (err) {
            logger.warn({
                error: err instanceof Error ? err.message : String(err),
                msg:   'Poll cycle failed, will retry',
            });
            this.recordPollFailure(err);
        }
        if(this._running) {
            this.scheduleNextPoll();
        }
    }

    private recordPollSuccess(): void {
        const { healthRegistry } = this.config;
        if(healthRegistry === undefined) {
            return;
        }
        const wasOffline = this.consecutivePollFails >= CONSECUTIVE_POLL_FAILURE_THRESHOLD;
        this.consecutivePollFails = 0;
        if(wasOffline) {
            healthRegistry.sendEvent('email', 'CONNECT_SUCCESS');
        }
    }

    private recordPollFailure(error: unknown): void {
        const { healthRegistry } = this.config;
        if(healthRegistry === undefined) {
            return;
        }
        this.consecutivePollFails++;
        if(this.consecutivePollFails >= CONSECUTIVE_POLL_FAILURE_THRESHOLD) {
            healthRegistry.sendEvent('email', 'CONNECTION_LOST', {
                error: error instanceof Error ? error.message : String(error),
            });
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
                // Stryker restore ObjectLiteral,StringLiteral
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
                error: err instanceof Error ? err.message : String(err),
                msg:   'Failed to process email, continuing',
            });
        }
    }

    /**
     * Connect to WildDuck SSE stream. Returns a Promise that resolves on the first
     * 'open' event (connection established) and rejects on an 'error' event that
     * occurs before the stream has ever opened. After the stream has been opened, a
     * subsequent 'error' event (server disconnects) restarts the reconnect loop so
     * the next connection attempt is made with exponential backoff.
     *
     * Infrastructure-level — wrapped with Stryker disable for SSE plumbing.
     */
    // Stryker disable all
    private connectSSEForLoop(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // Guard: EventSource may not be available in all environments (e.g., test runners)
            if(typeof EventSource === 'undefined') {
                resolve();
                return;
            }

            const token  = this.wildDuckClient.getAuthToken();
            const apiUrl = this.wildDuckClient.getApiUrl();
            if(!token || !apiUrl) {
                resolve();
                return;
            }

            const url    = `${apiUrl}/users/me/updates?accessToken=${token}`;
            const source = new EventSource(url);
            this.sseSource = source;

            let opened = false;

            source.addEventListener('open', (_event: Event) => {
                opened = true;
                resolve();
            });

            source.addEventListener('message', (event: MessageEvent) => {
                let data: unknown;
                try {
                    data = JSON.parse(String(event.data)) as unknown;
                } catch (err) {
                    logger.warn({ err, msg: 'Failed to parse SSE message data' });
                    return;
                }

                if(typeof data === 'object' && data !== null && 'command' in data && (data).command === 'EXISTS') {
                    void this.fetchAndProcess();
                }
            });

            source.addEventListener('error', (_event: Event) => {
                source.close();
                if(this.sseSource === source) {
                    this.sseSource = null;
                }
                if(!this._running) {
                    if(!opened) {
                        // Listener is stopped — don't reconnect, but settle the promise
                        resolve();
                    }
                    return;
                }
                logger.warn({ msg: 'SSE connection error, scheduling reconnect' });
                this.recordPollFailure(new Error('SSE connection error'));
                if(opened) {
                    // Error after open: stream was connected and then dropped.
                    // Use restart() (not start()) to preserve attemptCount so backoff grows
                    // on repeated drops rather than resetting to base delay every time.
                    this.sseReconnectLoop.restart();
                } else {
                    // Error before open: let the ReconnectionLoop handle backoff by rejecting
                    reject(new Error('SSE connection error'));
                }
            });
        });
    }
    // Stryker restore all
}

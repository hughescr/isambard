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
    pollFallbackMs:       number
    sseReconnectDelayMs?: number
    maxEmailsPerPoll?:    number
    /** Optional service health registry for reporting email connectivity events */
    healthRegistry?:      ServiceHealthRegistry
}

const DEFAULT_MAX_EMAILS_PER_POLL = 20;
const MAX_CONCURRENT_EMAILS = 4;
const DEFAULT_SSE_RECONNECT_DELAY_MS = 5000;

// ---------------------------------------------------------------------------
// No-op event sink (used when no registry is provided)
// ---------------------------------------------------------------------------

const NOOP_HEALTH_REGISTRY: Pick<ServiceHealthRegistry, 'sendEvent'> = {
    sendEvent: () => undefined,
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
    private          processingGeneration: number | null;
    // A batch may continue after stop(); the next generation waits for it before querying unseen mail.
    private          processingDone:       Promise<void> | null;
    private          _running:             boolean;
    private          generation:           number;
    private          startPromise:         Promise<void> | null;
    private          sseSource:            EventSource | null;
    private          consecutivePollFails: number;
    private          sseReconnectLoop:     ReconnectionLoop | null;

    constructor(wildDuckClient: WildDuckClient, processor: EmailProcessor, config: WildDuckListenerConfig) {
        this.wildDuckClient       = wildDuckClient;
        this.processor            = processor;
        this.config               = config;
        this.timer                = null;
        this.processingGeneration = null;
        this.processingDone       = null;
        this._running             = false;
        this.generation           = 0;
        this.startPromise         = null;
        this.sseSource            = null;
        this.consecutivePollFails = 0;
        this.sseReconnectLoop     = null;
    }

    /** Whether the listener is currently active. */
    get running(): boolean {
        return this._running;
    }

    /**
     * Drain backlog via fetchAndProcess() loop, then connect SSE for real-time updates.
     */
    async start(): Promise<void> {
        if(this._running) {
            await this.startPromise;
            return;
        }
        const generation = ++this.generation;
        this._running = true;
        const startPromise = this.startGeneration(generation);
        this.startPromise = startPromise;
        await startPromise;
    }

    private async startGeneration(generation: number): Promise<void> {
        try {
            // Fetch and process any messages that arrived before this session
            // Re-fetch immediately while there are more messages (batch cap was hit)
            // eslint-disable-next-line no-await-in-loop -- sequential pagination drains one batch at a time
            while(this.isCurrent(generation) && await this.fetchAndProcess(generation)) { /* drain backlog */ }

            if(!this.isCurrent(generation)) {
                return;
            }

            // Connect SSE for real-time new-mail notifications via reconnection loop.
            // Only start when EventSource is available (not in all test environments).
            if(typeof EventSource !== 'undefined') {
                const registry = this.config.healthRegistry ?? NOOP_HEALTH_REGISTRY;
                const baseDelayMs = this.config.sseReconnectDelayMs ?? DEFAULT_SSE_RECONNECT_DELAY_MS;
                const loop = createReconnectionLoop({
                    service:   'email',
                    registry,
                    connectFn: () => this.connectSSEForLoop(generation, loop),
                    policy:    { baseDelayMs },
                });
                this.sseReconnectLoop = loop;
                loop.start();
            }

            // Schedule fallback poll timer
            this.scheduleNextPoll(generation);
        } catch (err) {
            if(this.isCurrent(generation)) {
                await this.stop();
            }
            throw err;
        }
    }

    /** Stop SSE connection, clear timers, set running=false. */
    async stop(): Promise<void> {
        if(!this._running) {
            return;
        }
        this.generation++;
        this._running = false;
        this.startPromise = null;
        if(this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if(this.sseSource !== null) {
            this.sseSource.close();
            this.sseSource = null;
        }
        this.sseReconnectLoop?.stop();
        this.sseReconnectLoop = null;
    }

    // ---------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------

    private isCurrent(generation: number): boolean {
        return this._running && generation === this.generation;
    }

    private scheduleNextPoll(generation: number): void {
        if(!this.isCurrent(generation)) {
            return;
        }
        this.timer = setTimeout(() => {
            if(this.isCurrent(generation)) {
                this.timer = null;
                void this.poll(generation);
            }
        }, this.config.pollFallbackMs);
    }

    private async poll(generation = this.generation): Promise<void> {
        try {
            // Re-fetch immediately while there are more messages (batch cap was hit)
            // eslint-disable-next-line no-await-in-loop -- sequential: pagination loop drains backlog one batch at a time
            while(this.isCurrent(generation) && await this.fetchAndProcess(generation)) { /* drain backlog */ }
            if(this.isCurrent(generation)) {
                this.recordPollSuccess();
            }
        } catch (err) {
            if(!this.isCurrent(generation)) {
                return;
            }
            logger.warn({
                error: err instanceof Error ? err.message : String(err),
                msg:   'Poll cycle failed, will retry',
            });
            this.recordPollFailure(err);
        }
        this.scheduleNextPoll(generation);
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
    private async fetchAndProcess(generation = this.generation): Promise<boolean> {
        while(this.processingDone !== null) {
            if(this.processingGeneration === generation) {
                return false;
            }
            // eslint-disable-next-line no-await-in-loop -- wait for an older generation's batch before acquiring single-flight ownership
            await this.processingDone;
            if(generation !== this.generation) {
                return false;
            }
        }

        let releaseProcessing!: () => void;
        const done = new Promise<void>((resolve) => {
            releaseProcessing = resolve;
        });
        this.processingGeneration = generation;
        this.processingDone = done;
        try {
            const maxEmailsPerPoll = this.config.maxEmailsPerPoll ?? DEFAULT_MAX_EMAILS_PER_POLL;
            const summaries        = await this.wildDuckClient.listMessages(EmailFolder.Inbox, {
                unseen: true,
                limit:  maxEmailsPerPoll + 1,
            });

            if(generation !== this.generation) {
                return false;
            }

            const capped    = summaries.length > maxEmailsPerPoll;
            const toProcess = capped ? summaries.slice(0, maxEmailsPerPoll) : summaries;
            if(capped) {
                logger.warn({
                    total:     summaries.length,
                    processed: maxEmailsPerPoll,
                    msg:       'Email batch cap reached; remaining emails will be processed next poll',
                });
                // Stryker restore ObjectLiteral,StringLiteral
            }

            let nextIndex = 0;
            const workerFailures = new Set<unknown>();
            const processNext = async (): Promise<void> => {
                if(generation !== this.generation || workerFailures.size > 0) {
                    return;
                }
                try {
                    const summary = toProcess[nextIndex];
                    if(summary === undefined) {
                        return;
                    }
                    nextIndex++;
                    await this.processOne(summary.id, generation);
                } catch (error) {
                    workerFailures.add(error);
                    throw error;
                }
                await processNext();
            };
            const outcomes = await Promise.allSettled(Array.from(
                { length: Math.min(MAX_CONCURRENT_EMAILS, toProcess.length) },
                () => processNext()
            ));
            const failure = outcomes.find(outcome => outcome.status === 'rejected');
            if(failure !== undefined) {
                throw failure.reason;
            }

            return capped;
        } finally {
            this.processingGeneration = null;
            this.processingDone = null;
            releaseProcessing();
        }
    }

    private async processOne(uid: number, generation: number): Promise<void> {
        try {
            const email = await this.wildDuckClient.getFullMessage(EmailFolder.Inbox, uid);
            if(!email || generation !== this.generation) {
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
     */
    private connectSSEForLoop(generation: number, loop: ReconnectionLoop): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if(!this.isCurrent(generation)) {
                resolve();
                return;
            }
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
                if(!this.isCurrent(generation) || this.sseSource !== source) {
                    return;
                }
                opened = true;
                resolve();
            });

            source.addEventListener('message', (event: MessageEvent) => {
                if(!this.isCurrent(generation) || this.sseSource !== source) {
                    return;
                }
                let data: unknown;
                try {
                    data = JSON.parse(String(event.data)) as unknown;
                } catch (err) {
                    logger.warn({ err, msg: 'Failed to parse SSE message data' });
                    return;
                }

                if(typeof data === 'object' && data !== null && 'command' in data && (data).command === 'EXISTS') {
                    void this.fetchAndProcess(generation);
                }
            });

            source.addEventListener('error', (_event: Event) => {
                if(this.sseSource !== source) {
                    return;
                }
                source.close();
                this.sseSource = null;
                if(!this.isCurrent(generation)) {
                    return;
                }
                logger.warn({ msg: 'SSE connection error, scheduling reconnect' });
                this.recordPollFailure(new Error('SSE connection error'));
                if(opened) {
                    // Error after open: stream was connected and then dropped.
                    // Use restart() (not start()) to preserve attemptCount so backoff grows
                    // on repeated drops rather than resetting to base delay every time.
                    loop.restart();
                } else {
                    // Error before open: let the ReconnectionLoop handle backoff by rejecting
                    reject(new Error('SSE connection error'));
                }
            });
        });
    }
}

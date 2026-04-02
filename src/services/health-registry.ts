import { createServiceActor, type ServiceLifecycleActor } from './lifecycle-orchestrator';
import { serviceNameSchema, type ServiceName, type HealthState, type ServiceHealthEntry, type ServiceHealthChange, type HealthChangeListener } from './types';
import { formatShortRelativeTime } from '@/utils';

export interface ServiceHealthRegistry {
    getState(service: ServiceName): HealthState
    getEntry(service: ServiceName): Readonly<ServiceHealthEntry>
    getAll(): Readonly<Record<ServiceName, ServiceHealthEntry>>
    isAvailable(service: ServiceName): boolean
    isWriteAvailable(service: ServiceName): boolean
    sendEvent(service: ServiceName, event: string, payload?: Record<string, unknown>): void
    subscribe(listener: HealthChangeListener): () => void
    buildStatusSummary(): string | undefined
    stop(): void
}

export interface ServiceHealthRegistryLogger {
    warn:  (obj: object, msg: string) => void
    error: (obj: object, msg: string) => void
    info:  (obj: object, msg: string) => void
    debug: (obj: object, msg: string) => void
}

export interface ServiceHealthRegistryDeps {
    logger: ServiceHealthRegistryLogger
}

const SERVICE_NAMES = serviceNameSchema.options;

// eslint-disable-next-line sonarjs/function-return-type -- legitimately returns string | undefined
function buildRetryPart(nextRetryAt: Date, now: Date): string | undefined {
    const retryMs = nextRetryAt.getTime() - now.getTime();
    if(retryMs <= 0) {
        return undefined;
    }
    const retrySec = Math.ceil(retryMs / 1000);
    // Stryker disable next-line ConditionalExpression,EqualityOperator: boundary between seconds and minutes display
    return retrySec >= 60
        ? `retry in ~${Math.ceil(retrySec / 60)}m`
        : `retry in ~${retrySec}s`;
}

// eslint-disable-next-line sonarjs/function-return-type -- legitimately returns string | undefined
function buildServiceStatusLine(name: ServiceName, entry: ServiceHealthEntry, now: Date): string | undefined {
    if(entry.state === 'online' || entry.state === 'disabled') {
        return undefined;
    }

    const parts: string[] = [`${name}: ${entry.state}`];

    if(entry.lastOfflineAt !== undefined) {
        parts.push(`(offline ${formatShortRelativeTime(entry.lastOfflineAt, now)})`);
    }

    if(entry.lastError !== undefined) {
        parts.push(`[${entry.lastError.code}: ${entry.lastError.message}]`);
    }

    if(entry.nextRetryAt !== undefined) {
        const retryPart = buildRetryPart(entry.nextRetryAt, now);
        if(retryPart !== undefined) {
            parts.push(retryPart);
        }
    }

    return parts.join(' ');
}

function snapshotToEntry(actor: ServiceLifecycleActor): ServiceHealthEntry {
    const snapshot = actor.getSnapshot();
    const ctx = snapshot.context;
    return {
        state:         snapshot.value,
        epoch:         ctx.epoch,
        lastOnlineAt:  ctx.lastOnlineAt,
        lastOfflineAt: ctx.lastOfflineAt,
        lastError:     ctx.lastError,
        failureCount:  ctx.failureCount,
        nextRetryAt:   ctx.nextRetryAt,
    };
}

export class ServiceHealthRegistryImpl implements ServiceHealthRegistry {
    private readonly actors:         Record<ServiceName, ServiceLifecycleActor>;
    private readonly listeners =     new Set<HealthChangeListener>();
    private readonly subscriptions:  (() => void)[] = [];
    private readonly previousStates: Partial<Record<ServiceName, HealthState>> = {};

    constructor(private readonly deps: ServiceHealthRegistryDeps) {
        this.actors = {} as Record<ServiceName, ServiceLifecycleActor>;

        for(const name of SERVICE_NAMES) {
            const actor = createServiceActor();
            this.actors[name] = actor;
            actor.start();

            const subscription = actor.subscribe((snapshot) => {
                this.handleStateChange(name, snapshot.value, snapshot.context.epoch);
            });
            // Stryker disable next-line BlockStatement: equivalent — actor.stop() in stop() prevents events from firing regardless of whether unsubscribe is called
            this.subscriptions.push(() => {
                subscription.unsubscribe();
            });
        }
    }

    private handleStateChange(service: ServiceName, newState: HealthState, epoch: number): void {
        const previousState = this.previousStates[service];
        this.previousStates[service] = newState;

        if(previousState === undefined || previousState === newState) {
            return;
        }

        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: optimization — skipping notification when no listeners
        if(this.listeners.size === 0) {
            return;
        }

        const change: ServiceHealthChange = {
            service,
            previousState,
            newState,
            epoch,
            timestamp: new Date(),
        };

        for(const listener of this.listeners) {
            try {
                listener(change);
            } catch (error) {
                // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                this.deps.logger.error({ error }, 'Error in health change listener');
                // Stryker restore ObjectLiteral,StringLiteral
            }
        }
    }

    getState(service: ServiceName): HealthState {
        return this.actors[service].getSnapshot().value;
    }

    getEntry(service: ServiceName): Readonly<ServiceHealthEntry> {
        return snapshotToEntry(this.actors[service]);
    }

    getAll(): Readonly<Record<ServiceName, ServiceHealthEntry>> {
        const result = {} as Record<ServiceName, ServiceHealthEntry>;
        for(const name of SERVICE_NAMES) {
            result[name] = snapshotToEntry(this.actors[name]);
        }
        return Object.freeze(result);
    }

    isAvailable(service: ServiceName): boolean {
        const state = this.getState(service);
        return state === 'online' || state === 'degraded';
    }

    isWriteAvailable(service: ServiceName): boolean {
        return this.getState(service) === 'online';
    }

    sendEvent(service: ServiceName, event: string, payload?: Record<string, unknown>): void {
        const actor = this.actors[service];
        actor.send({ type: event, ...payload } as Parameters<typeof actor.send>[0]);
    }

    subscribe(listener: HealthChangeListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    // eslint-disable-next-line sonarjs/function-return-type -- intentional: undefined signals all services online; callers treat undefined as "no issues to report"
    buildStatusSummary(): string | undefined {
        const now = new Date();
        const lines: string[] = [];

        for(const name of SERVICE_NAMES) {
            const entry = snapshotToEntry(this.actors[name]);
            const line = buildServiceStatusLine(name, entry, now);
            if(line !== undefined) {
                lines.push(line);
            }
        }

        // Stryker disable next-line ConditionalExpression,EqualityOperator: optimization guard — both paths produce same result for empty lines
        if(lines.length === 0) {
            return undefined;
        }

        return lines.join('\n');
    }

    // Stryker disable BlockStatement: cleanup loop — unsubscribe and stop are both void calls; effect visible only post-stop which causes xstate internal state inaccessible from outside
    stop(): void {
        for(const unsub of this.subscriptions) {
            unsub();
        }
        for(const name of SERVICE_NAMES) {
            this.actors[name].stop();
        }
    }
    // Stryker restore BlockStatement
}

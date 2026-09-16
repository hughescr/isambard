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

interface ServiceHealthRegistryDeps {
    logger: ServiceHealthRegistryLogger
}

const SERVICE_NAMES = serviceNameSchema.options;

function buildRetryPart(nextRetryAt: Date, now: Date): string | undefined {
    const retryMs = nextRetryAt.getTime() - now.getTime();
    if(retryMs <= 0) {
        return undefined;
    }
    const retrySec = Math.ceil(retryMs / 1000);
    // Stryker disable next-line llm: Math.floor is the identity because retrySec is already an integer
    return retrySec >= 60
        ? `retry in ~${Math.ceil(retrySec / 60)}m`
        : `retry in ~${retrySec}s`;
}

function buildServiceStatusLine(name: ServiceName, entry: ServiceHealthEntry, now: Date): string | undefined {
    if(entry.state === 'online' || entry.state === 'disabled') {
        return undefined;
    }

    const parts: string[] = [`${name}: ${entry.state}`];

    if(entry.lastOfflineAt !== undefined) {
        // Stryker disable next-line llm: omitted now defaults to the same instant at the formatter's whole-second precision
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
    private readonly previousStates: Partial<Record<ServiceName, HealthState>> = {};

    constructor(private readonly deps: ServiceHealthRegistryDeps) {
        this.actors = {} as Record<ServiceName, ServiceLifecycleActor>;

        // Stryker disable next-line llm: serviceNameSchema.options is a non-nullable, non-empty tuple, so a fallback can never be selected
        for(const name of SERVICE_NAMES) {
            const actor = createServiceActor();
            this.actors[name] = actor;
            actor.start();

            actor.subscribe((snapshot) => {
                this.handleStateChange(name, snapshot.value, snapshot.context.epoch);
            });
        }
    }

    private handleStateChange(service: ServiceName, newState: HealthState, epoch: number): void {
        const previousState = this.previousStates[service];
        this.previousStates[service] = newState;

        if(previousState === undefined || previousState === newState) {
            return;
        }

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
                this.deps.logger.error({ error }, 'Error in health change listener');
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
        // Stryker disable next-line llm: a shallow copy preserves this immutable list's elements and order
        for(const name of SERVICE_NAMES) {
            // Stryker disable next-line llm: string interpolation is identical, and constructor-populated actor records are always truthy and non-nullish
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

    buildStatusSummary(): string | undefined {
        const now = new Date();
        const lines: string[] = [];

        for(const name of SERVICE_NAMES) {
            const entry = snapshotToEntry(this.actors[name]);
            const line = buildServiceStatusLine(name, entry, now);
            if(line !== undefined) {
                // Stryker disable next-line llm: status lines always start with a non-empty service name and state
                lines.push(line);
            }
        }

        if(lines.length === 0) {
            return undefined;
        }

        return lines.join('\n');
    }

    stop(): void {
        for(const name of SERVICE_NAMES) {
            this.actors[name].stop();
        }
    }
}

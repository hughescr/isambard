import { z } from 'zod';
import type { ServiceLifecycleState } from './lifecycle-orchestrator';

export const serviceNameSchema = z.enum(['discord', 'discord-channel-registry', 'email', 'bsky', 'caldav', 'dynamodb']);
export type ServiceName = z.infer<typeof serviceNameSchema>;

export type HealthState = ServiceLifecycleState;

export type ServiceErrorCategory = 'offline_retryable_later' | 'permanent_not_configured';

export interface ServiceHealthEntry {
    state:          HealthState
    epoch:          number
    lastOnlineAt?:  Date
    lastOfflineAt?: Date
    lastError?:     { code: string, message: string }
    failureCount:   number
    nextRetryAt?:   Date
}

export interface ServiceHealthChange {
    service:       ServiceName
    previousState: HealthState
    newState:      HealthState
    epoch:         number
    timestamp:     Date
}

export type HealthChangeListener = (change: ServiceHealthChange) => void;

/**
 * Minimal logger interface used by polling executors and drainers in the services layer.
 * Matches the shape of the project-wide logger so real loggers satisfy it automatically.
 */
export interface ServiceLogger {
    debug: (obj: object, msg: string) => void
    warn:  (obj: object, msg: string) => void
    error: (obj: object, msg: string) => void
    info:  (obj: object, msg: string) => void
}

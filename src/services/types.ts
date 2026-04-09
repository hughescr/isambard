import { z } from 'zod';

// Stryker disable all: Enum/schema values are static definitions

export const serviceNameSchema = z.enum(['discord', 'email', 'bluesky', 'caldav']);
export type ServiceName = z.infer<typeof serviceNameSchema>;
// Stryker restore all

export type HealthState = 'disabled' | 'starting' | 'recovering' | 'online' | 'degraded' | 'offline';

export type ServiceErrorCategory = 'offline_retryable_later' | 'degraded_read_only' | 'permanent_not_configured';

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

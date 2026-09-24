import { describe, expect, test, mock } from 'bun:test';
import type { OutboxDrainer } from '@/services/outbox/drainer';
import { createOutboxDrainListener } from '@/services/outbox/health-listener';
import type { ServiceHealthChange, ServiceName } from '@/services/types';

describe('createOutboxDrainListener', () => {
    test('drains only when Discord comes online', () => {
        const drain = mock(async () => ({ delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 }));
        const listener = createOutboxDrainListener({ drain } as unknown as OutboxDrainer);
        const change = (service: ServiceName, newState: ServiceHealthChange['newState']): ServiceHealthChange => ({
            service, newState, previousState: 'offline', epoch: 1, timestamp: new Date(0),
        });
        listener(change('email', 'online'));
        listener(change('bsky', 'online'));
        listener(change('discord', 'offline'));
        expect(drain).not.toHaveBeenCalled();
        listener(change('discord', 'online'));
        expect(drain).toHaveBeenCalledTimes(1);
        expect(drain).toHaveBeenCalledWith('discord');
    });
});

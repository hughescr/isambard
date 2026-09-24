import type { HealthChangeListener } from '../types';
import type { OutboxDrainer } from './drainer';

export function createOutboxDrainListener(drainer: OutboxDrainer): HealthChangeListener {
    return (change) => {
        if(change.service === 'discord' && change.newState === 'online') {
            void drainer.drain('discord');
        }
    };
}

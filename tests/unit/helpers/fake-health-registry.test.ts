import { describe, test, expect } from 'bun:test';
import { makeHealthEntry, makeHealthRegistry } from '../../helpers/fake-health-registry';

describe('makeHealthEntry', () => {
    test('defaults to an offline entry with zero epoch and no lastError', () => {
        const entry = makeHealthEntry();
        expect(entry.state).toBe('offline');
        expect(entry.epoch).toBe(0);
        expect(entry.failureCount).toBe(0);
        expect(entry.lastError).toBeUndefined();
    });

    test('overrides win over defaults', () => {
        const entry = makeHealthEntry({ state: 'online', epoch: 3, lastError: { code: 'AUTH', message: 'bad creds' } });
        expect(entry.state).toBe('online');
        expect(entry.epoch).toBe(3);
        expect(entry.lastError).toEqual({ code: 'AUTH', message: 'bad creds' });
    });
});

describe('makeHealthRegistry', () => {
    test('getAll reflects the entries passed in, per service', () => {
        const discordEntry = makeHealthEntry({ state: 'online', epoch: 1 });
        const emailEntry   = makeHealthEntry({ state: 'offline', epoch: 2, lastError: { code: 'TIMEOUT', message: 'no reply' } });
        const registry     = makeHealthRegistry({ entries: { discord: discordEntry, email: emailEntry } });

        const all = registry.getAll();

        expect(all.discord).toEqual(discordEntry);
        expect(all.email).toEqual(emailEntry);
    });

    test('getAll fills in an offline default entry for a service not named in entries', () => {
        const registry = makeHealthRegistry({ entries: { discord: makeHealthEntry({ state: 'online' }) } });

        const all = registry.getAll();

        expect(all.bluesky).toEqual(makeHealthEntry());
    });

    test('getEntry and getState read the same per-service data as getAll', () => {
        const entry    = makeHealthEntry({ state: 'degraded', epoch: 5 });
        const registry = makeHealthRegistry({ entries: { caldav: entry } });

        expect(registry.getEntry('caldav')).toEqual(entry);
        expect(registry.getState('caldav')).toBe('degraded');
    });

    test('isAvailable/isWriteAvailable default to false and honor overrides', () => {
        const registry = makeHealthRegistry({ available: { discord: true }, writeAvailable: { email: true } });

        expect(registry.isAvailable('discord')).toBe(true);
        expect(registry.isAvailable('email')).toBe(false);
        expect(registry.isWriteAvailable('email')).toBe(true);
        expect(registry.isWriteAvailable('discord')).toBe(false);
    });

    test('buildStatusSummary returns the configured text, or undefined when omitted', () => {
        expect(makeHealthRegistry({ summary: 'discord offline for 2m' }).buildStatusSummary()).toBe('discord offline for 2m');
        expect(makeHealthRegistry().buildStatusSummary()).toBeUndefined();
    });

    test('subscribe/sendEvent/stop are directly assertable mocks, with no cast needed', () => {
        const registry = makeHealthRegistry();

        registry.subscribe(() => undefined);
        registry.sendEvent('discord', 'reconnected');
        registry.stop();

        expect(registry.subscribe.mock.calls).toHaveLength(1);
        expect(registry.sendEvent.mock.calls[0]).toEqual(['discord', 'reconnected']);
        expect(registry.stop.mock.calls).toHaveLength(1);
    });
});

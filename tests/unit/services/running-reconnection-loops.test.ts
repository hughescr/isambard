import { describe, expect, it, afterEach } from 'bun:test';
import { listRunningReconnectionLoops, markLoopRunning, markLoopStopped } from '@/services/running-reconnection-loops';

describe('running reconnection loop registry', () => {
    const a = {};
    const b = {};
    const noStop = (): void => undefined;

    afterEach(() => {
        markLoopStopped(a);
        markLoopStopped(b);
    });

    it('lists a loop, with its service, from the moment it is marked running', () => {
        expect(listRunningReconnectionLoops()).toEqual([]);

        markLoopRunning(a, 'discord', noStop);
        markLoopRunning(b, 'bsky', noStop);

        const listed = listRunningReconnectionLoops();
        expect(listed).toHaveLength(2);
        expect(listed[0]?.id).toBe(a);
        expect(listed[0]?.service).toBe('discord');
        expect(listed[1]?.id).toBe(b);
        expect(listed[1]?.service).toBe('bsky');
    });

    it('hands back the stop function the loop registered', () => {
        let stops = 0;
        markLoopRunning(a, 'discord', () => {
            stops += 1;
        });

        listRunningReconnectionLoops()[0]?.stop();

        expect(stops).toBe(1);
    });

    it('stops listing a loop once it is marked stopped, leaving the others', () => {
        markLoopRunning(a, 'discord', noStop);
        markLoopRunning(b, 'bsky', noStop);

        markLoopStopped(a);

        expect(listRunningReconnectionLoops().map(entry => entry.id)).toEqual([b]);
    });

    it('lists a loop once however many times it is marked running', () => {
        markLoopRunning(a, 'discord', noStop);
        markLoopRunning(a, 'discord', noStop);

        expect(listRunningReconnectionLoops()).toHaveLength(1);
    });

    it('tolerates stopping a loop that was never running', () => {
        markLoopStopped(a);

        expect(listRunningReconnectionLoops()).toEqual([]);
    });
});

import { describe, expect, test } from 'bun:test';

/**
 * Production never calls `setRunningLoopTracking(true)`; only the test preload does. That default
 * cannot be observed inside `bun test` (the preload has already switched tracking on), so this runs
 * the module in a plain `bun -e` process, which has no test preload, and checks it registers and
 * holds nothing. It spawns a subprocess, so it carries an explicit timeout.
 */
const SCRIPT = `
import { listRunningReconnectionLoops, markLoopRunning } from './src/services/running-reconnection-loops';
markLoopRunning({}, 'discord', () => undefined);
console.log(JSON.stringify(listRunningReconnectionLoops()));
`;

describe('running-loop registry default (no test preload)', () => {
    test('registers nothing and holds no loop', async () => {
        const child = Bun.spawn([process.execPath, '-e', SCRIPT], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

        expect(err).toBe('');
        expect(code).toBe(0);
        expect(out.trim()).toBe('[]');
    }, 30_000);
});

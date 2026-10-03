import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

describe('patched TypeScript checker grouping', () => {
    test('preserves grouping semantics while caching ancestor traversals per invocation', async () => {
        const fixture = fileURLToPath(new URL('../helpers/typescript-checker-grouping-fixture.mjs', import.meta.url));
        // Bun's own spawn timeout reaps a wedged fixture; it is a native timer, so no test-side timer is left behind
        const child = Bun.spawn(['node', fixture], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 4000, killSignal: 'SIGKILL' });
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        if(exitCode !== 0) {
            throw new Error(`TypeScript checker grouping fixture failed or timed out and was reaped (exit ${exitCode}, signal ${child.signalCode ?? 'none'})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        }
        const metrics = JSON.parse(stdout) as {
            cachedAncestorCalls:         number
            referenceAncestorCalls:      number
            cachedDeepTraversalCalls:    number
            referenceDeepTraversalCalls: number
        };
        expect(metrics.cachedAncestorCalls).toBe(1);
        expect(metrics.referenceAncestorCalls).toBe(2000);
        expect(metrics.cachedDeepTraversalCalls).toBe(64);
        expect(metrics.referenceDeepTraversalCalls).toBe(32_000);
    }, { timeout: 10_000 });
});

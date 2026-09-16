import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

describe('patched TypeScript checker grouping', () => {
    test('preserves grouping semantics while caching ancestor traversals per invocation', async () => {
        const fixture = fileURLToPath(new URL('../helpers/typescript-checker-grouping-fixture.mjs', import.meta.url));
        const child = Bun.spawn(['node', fixture], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
        const result = await Promise.race([
            child.exited.then(exitCode => ({ kind: 'exit' as const, exitCode })),
            new Promise<{ kind: 'timeout' }>((resolve) => {
                AbortSignal.timeout(4000).addEventListener('abort', () => resolve({ kind: 'timeout' }), { once: true });
            }),
        ]);
        if(result.kind === 'timeout') {
            child.kill();
            const exitCode = await child.exited;
            const [stdout, stderr] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            throw new Error(`TypeScript checker grouping fixture timed out and was reaped (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        }
        const [exitCode, stdout, stderr] = await Promise.all([
            result.exitCode,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        if(exitCode !== 0) {
            throw new Error(`TypeScript checker grouping fixture failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
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

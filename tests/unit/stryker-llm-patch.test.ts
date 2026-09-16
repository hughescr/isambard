import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

describe('LLM mutator heuristics', () => {
    test('runs inherited-key and Stryker instrumentation assertions under Bun', async () => {
        const fixture = fileURLToPath(new URL('../helpers/stryker-llm-mutator-own-key-fixture.mjs', import.meta.url));
        const child = Bun.spawn([process.execPath, fixture], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);

        if(exitCode !== 0) {
            throw new Error(`LLM mutator fixture failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        }
        expect(exitCode).toBe(0);
    });
});

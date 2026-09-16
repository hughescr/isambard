import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

interface ScenarioResult {
    groupCalls:     string[][]
    resultIds:      string[]
    earlyResultIds: string[]
}

describe('patched Stryker checker batching', () => {
    test('caps grouping calls without dropping, duplicating, or reordering input mutants', async () => {
        const fixture = fileURLToPath(new URL('../helpers/stryker-checker-batch-fixture.mjs', import.meta.url));
        const child = Bun.spawn(['node', fixture], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        if(exitCode !== 0) {
            throw new Error(`Stryker checker batch fixture failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        }
        const result = JSON.parse(stdout) as { withPartial: ScenarioResult, exactMultiple: ScenarioResult };
        const expectedPartialIds = Array.from({ length: 8195 }, (_, id) => String(id));
        const expectedExactIds = expectedPartialIds.slice(0, 8192);

        expect(result.withPartial.groupCalls.map(group => group.length)).toEqual([4096, 4096, 3]);
        expect(result.withPartial.groupCalls.flat()).toEqual(expectedPartialIds);
        expect(result.withPartial.resultIds).toEqual(expectedPartialIds);
        expect(result.withPartial.earlyResultIds).toEqual(['4096']);

        expect(result.exactMultiple.groupCalls.map(group => group.length)).toEqual([4096, 4096]);
        expect(result.exactMultiple.groupCalls.every(group => group.length > 0)).toBe(true);
        expect(result.exactMultiple.groupCalls.flat()).toEqual(expectedExactIds);
        expect(result.exactMultiple.resultIds).toEqual(expectedExactIds);
    });
});

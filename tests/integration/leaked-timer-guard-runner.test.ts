import { describe, expect, test } from 'bun:test';

/**
 * Runs the scenarios in tests/fixtures/leaked-timer-guard/scenarios.fixture.ts under a REAL
 * `bun test` (real preload, real runtime timers) and checks that the leaked-timer guard failed each
 * leaking scenario and only those. The unit tests in tests/unit/helpers/leaked-timer-guard.test.ts
 * cover the guard against fake hosts; this is the end-to-end proof that enforcement cannot be
 * bypassed through any creator path, overlapping tests, module scope, or a loop left running.
 *
 * It spawns a subprocess, so it is much slower than a unit test and is given an explicit timeout.
 * It covers no `src/` line itself (the child is not instrumented), so mutation runs never replay it.
 */
const FIXTURE = './tests/fixtures/leaked-timer-guard/scenarios.fixture.ts';

async function runFixture(): Promise<string> {
    const child = Bun.spawn([process.execPath, 'test', '--timeout', '5000', FIXTURE], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return `${out}\n${err}`;
}

describe('leaked-timer guard under the real runner', () => {
    test('fails every leaking scenario, names the leak, and fails nothing else', async () => {
        const output = await runFixture();
        const failed = output.split('\n').filter(line => line.startsWith('(fail) ')).map(line => line.replace(/ \[[\d.]+ms\]$/, ''));

        const byName = (a: string, b: string): number => a.localeCompare(b);
        expect(failed.toSorted(byName)).toEqual([
            '(fail) (unnamed)',
            '(fail) scenarios > SCENARIO AbortSignal.timeout leak',
            '(fail) scenarios > SCENARIO Bun.sleep leak',
            '(fail) scenarios > SCENARIO global setTimeout leak',
            '(fail) scenarios > SCENARIO node:timers setTimeout leak',
            '(fail) scenarios > SCENARIO node:timers/promises setTimeout leak',
            '(fail) scenarios > SCENARIO reconnection loop left running with an attempt in flight',
            '(fail) scenarios > concurrent overlap > SCENARIO concurrent A leaks a timer until afterAll',
        ].toSorted(byName));
        expect(output).toContain('- AbortSignal.timeout 60005ms');
        expect(output).toContain('- timers/promises.setTimeout 60004ms');
        expect(output).toContain('- Bun.sleep 30ms');
        expect(output).toContain('- running-owner "discord" is still running');
        // the module-scope timer is attributed to the file, at file teardown
        expect(output).toMatch(/after this test file finished[\s\S]*- setTimeout 60001ms/u);
    }, 60_000);
});

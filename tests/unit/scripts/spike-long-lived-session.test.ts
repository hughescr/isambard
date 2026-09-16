import { expect, test } from 'bun:test';
import path from 'node:path';
import { runSpikeTasks } from '../../../scripts/spike-long-lived-session';

const ROOT = path.resolve(import.meta.dir, '../../..');
const SPIKE = path.join(ROOT, 'scripts/spike-long-lived-session.ts');

async function runSpike(args: string[]): Promise<{ status: number, output: string }> {
    const child = Bun.spawn({
        cmd:    [process.execPath, SPIKE, 'none', ...args],
        cwd:    ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return {
        status,
        output: stdout + stderr,
    };
}

test('the spike exits successfully when no SDK questions are selected', async () => {
    const result = await runSpike([]);
    expect(result.status).toBe(0);
    expect(result.output).toContain('spike done');
    expect(result.output).not.toContain('spike FAILED');
});

test('a caught question failure returns an unsuccessful status after saving partial recordings', async () => {
    const failure = new Error('synthetic question failure');
    const reported: unknown[] = [];
    let saved = false;
    const unusedQuestion = async (): Promise<void> => undefined;
    const status = await runSpikeTasks(new Set(['q1']), {
        q1q2:          async () => { throw failure; },
        q3:            unusedQuestion,
        q4q5:          unusedQuestion,
        q6:            unusedQuestion,
        writeFixtures: () => { saved = true; },
    }, (error) => { reported.push(error); });

    expect(status).toBe(1);
    expect(saved).toBe(true);
    expect(reported).toEqual([failure]);
});

test('the spike exits unsuccessfully when recording fails without running the SDK', async () => {
    const result = await runSpike(['--record=/dev/null']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('spike FAILED');
});

/** How long a timed-out command gets to exit after SIGTERM before it is sent SIGKILL. */
export const KILL_GRACE_MS = 1000;

export interface CommandResult {
    stdout:   string
    stderr:   string
    exitCode: number
}

/** Runs one command, settling within `timeout` ms whatever the command or its output pipes do. */
export type BoundedRunner = (cmd: string[], options: { timeout: number }) => Promise<CommandResult>;

async function runBounded(cmd: string[], { timeout }: { timeout: number }): Promise<CommandResult> {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
    const finished = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
            proc.kill('SIGTERM');
            const escalation = setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS);
            const cancelEscalation = (): void => clearTimeout(escalation);
            void proc.exited.then(cancelEscalation).catch(cancelEscalation);
            reject(new Error(`timed out after ${timeout} ms and was killed`));
        }, timeout);
    });
    try {
        const [stdout, stderr, exitCode] = await Promise.race([finished, expired]);
        return { stdout, stderr, exitCode };
    } finally {
        clearTimeout(deadline);
    }
}

/**
 * A command runner with a hard deadline, for the Tailscale CLI. `timeout` covers both the exit and
 * draining stdout and stderr: when it passes, the command is sent SIGTERM (then SIGKILL after
 * `KILL_GRACE_MS` unless it has exited) and the promise rejects at once, even if a pipe never
 * closes. The video `createSpawnRunner` waits for its pipes after its kill, so it is not used here.
 */
export function createBoundedRunner(): BoundedRunner {
    return runBounded;
}

/**
 * Pure argv parsing for scripts/spike-long-lived-session.ts, split into its own side-effect-free
 * module so it can be unit tested without importing (and thereby executing) the spike itself,
 * which runs against the real Agent SDK and spends real tokens.
 *
 * Accepts `[q1,q2,...] [--record[=dir]]` in either argument order. `--record=<dir>` (rather than
 * a bare positional after `--record`) is deliberate: a positional-after-flag design cannot tell
 * `--record q1,q2,q3` (flag first) from `--record mydir` (a directory) without guessing, and
 * previously misread the question list as the directory whenever the flag had no explicit value.
 *
 * @module scripts/spike-argv
 */

/** Parsed spike script arguments. */
export interface SpikeArgs {
    /** Whether `--record` (or `--record=<dir>`) was passed. */
    recording:   boolean
    /** Directory fixtures are written under; meaningful only when {@link recording}. */
    recordDir:   string
    /** Comma-separated question list, e.g. `'q1,q2'`; defaults to every question. */
    questionArg: string
}

const DEFAULT_RECORD_DIR = 'tests/fixtures/sdk-frames/';
const DEFAULT_QUESTION_ARG = 'q1,q2,q3,q4,q5,q6';
const RECORD_DIR_PREFIX = '--record=';

/** True for `--record` or `--record=<dir>`; anything else (including the question list) is not a flag. */
function isRecordFlag(arg: string): boolean {
    return arg === '--record' || arg.startsWith(RECORD_DIR_PREFIX);
}

/** Parses `process.argv.slice(2)`-shaped input into {@link SpikeArgs}. */
export function parseSpikeArgs(rawArgs: readonly string[]): SpikeArgs {
    const recordArg = rawArgs.find(arg => isRecordFlag(arg));
    const recording = recordArg !== undefined;
    const recordDir = recordArg?.startsWith(RECORD_DIR_PREFIX)
        ? recordArg.slice(RECORD_DIR_PREFIX.length)
        : DEFAULT_RECORD_DIR;
    const questionArg = rawArgs.find(arg => !isRecordFlag(arg)) ?? DEFAULT_QUESTION_ARG;

    return { recording, recordDir, questionArg };
}

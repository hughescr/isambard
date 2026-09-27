/**
 * One-off repair of the memory tag index (#152). ONE-OFF: delete this tool (and its -core,
 * -capacity and -aws modules and tests) after Craig has run it. Run it only after the M1 code
 * (tag rows carry their memory's TTL; META_COUNT counts only rows without a TTL) is live in
 * running/, or Izzy will keep writing the drift it repairs.
 *
 * Usage:
 *   sst shell -- bun tools/repair-tag-index.ts [--execute] [--boost 50] [--settle-seconds 600] [--out report.json]
 *   sst shell -- bun tools/repair-tag-index.ts --restore-capacity
 *
 * A dry run is the default: it scans, prints bucket counts with up to 25 examples each, the
 * planned writes and the estimated units and runtime per resource, and writes a JSON report
 * (--out, default $TMPDIR). --execute then, safely while Izzy runs:
 * - deletes tag rows whose memory is gone or TTL-expired, and rows for tags a memory no longer has;
 * - stamps the memory's TTL on rows of live expiring memories, and rewrites stale `tags` copies,
 *   `layer: 'unknown'`, previews and updatedAt from the memory's current state;
 * - writes missing rows;
 * - recounts META_COUNT as the rows without a TTL for every tag it touched or found wrong, always
 *   setting GSI2PK/GSI2SK.
 * Every row write is conditioned on the full row it observed (or on no row), after a fresh strong
 * read of the memory and its rows, and the memory is re-read afterwards; a changed memory or a
 * failed condition redoes that memory (3 attempts). Each recount reads a tag twice at least
 * --settle-seconds apart (default 600, minimum 360, above the live writer's ~5.3 min worst-case
 * row-to-count gap: SDK 3 attempts x (5 s connect + 30 s request) x 3 local retries) and writes only
 * a count that stayed stable, conditioned on the count it read. Residual: a writer stalled for
 * longer than the settle interval after the final verify cycle can still leave a count off by one;
 * a follow-up dry run shows it. Tags carried only by expiring memories have no META_COUNT, so they
 * do not appear in listTags. Orphan rows under a tag with neither META nor a live memory carrying
 * it cannot be found without a Scan.
 *
 * Pacing: every request is charged with the units DynamoDB reports, per resource. Flags
 * --base-rcu 1, --base-wcu 0.5, --gsi1-rcu 1, --gsi2-rcu 0.5, --gsi2-wcu 0.5 (units/s) are the
 * free-tier-safe defaults, capped at half of provisioned. Throttling backs off 1 s..30 s and never
 * fails the run. At the defaults: the scan is ~3.8k base RCU + ~1.7k GSI1 RCU (~1.5 h); repair and
 * recount reads ~10-18k RCU (~3-5 h); writes ~10-15k WCU (~6-8 h); ~8-10 h in total. The dry run
 * prints exact estimates.
 *
 * Capacity boost (--boost N, only with --execute, N from 6 to 50): DescribeTable and refuse unless
 * the table and GSIs are ACTIVE, billing is provisioned, capacity is exactly base 5/2, GSI1 2/2,
 * GSI2 1/1 (sst/dynamo.ts), no restore file exists and no boosted resource has used 4 decreases
 * today. Then save the originals to --restore-file (default reports/tag-index-repair-capacity.json)
 * BEFORE any change, raise base RCU/WCU, GSI1 RCU and GSI2 WCU to N one UpdateTable at a time
 * (waiting for ACTIVE), and run at N minus the original capacity, leaving the original as headroom
 * for Izzy. At --boost 50 the run takes ~45-75 min including the UpdateTable waits and at least 4
 * settle intervals. Capacity is ALWAYS restored in `finally` and on SIGINT/SIGTERM/SIGHUP (the first
 * signal stops the repair; later ones print "restoring capacity, please wait"): wait for ACTIVE,
 * restore each resource that differs, retry LimitExceededException/ResourceInUseException with a
 * 30 s..5 min backoff for up to 75 min, verify with DescribeTable, and only then delete the restore
 * file. If that fails, the file is kept, the equivalent `aws dynamodb update-table` commands are
 * printed and the exit is non-zero; `--restore-capacity` restores from the file after a crash.
 * DynamoDB allows up to 4 capacity decreases per table or GSI at any time in a UTC day, then 1 per
 * hour after an hour with none; one boosted run uses 1 decrease per boosted resource.
 *
 * IAM: dynamodb:Query, GetItem, BatchGetItem, PutItem, DeleteItem and UpdateItem; with --boost or
 * --restore-capacity also dynamodb:DescribeTable and dynamodb:UpdateTable.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Resource } from 'sst';
import { createCapacityAdmin, createRepairStore, type AdapterDeps } from './repair-tag-index-aws';
import {
    DEFAULT_RATES,
    UNBOOSTED_CAPS,
    applyBoost,
    boostedRates,
    parseBoost,
    restoreCapacity,
    saveOriginal,
    validateBoost,
    type CapacityAdmin,
    type CapacityDeps,
    type CapacityState,
    type RestoreFile
} from './repair-tag-index-capacity';
import {
    BUCKET_NAMES,
    RATE_KEYS,
    createPacing,
    estimateExecute,
    executeRepair,
    isAbortError,
    planRepair,
    scan,
    toEpochSeconds,
    type RateKey,
    type Rates,
    type RepairContext,
    type RepairResult,
    type RepairStore
} from './repair-tag-index-core';
import { loadDynamoDBConfig } from '@/config';
import { createDynamoDBClient } from '@/storage';
import { sleepRespectingSignal } from '@/storage/utils/rcu-pacing';

export const HELP = `Usage:
  sst shell -- bun tools/repair-tag-index.ts [--execute] [--boost N] [--settle-seconds 600] [--out report.json]
  sst shell -- bun tools/repair-tag-index.ts --restore-capacity [--restore-file path]

A dry run is the default; --execute writes.
  --boost N            with --execute: temporarily raise capacity to N (6..50), always restored
  --settle-seconds S   recount settle interval (default 600, minimum 360)
  --base-rcu R --base-wcu R --gsi1-rcu R --gsi2-rcu R --gsi2-wcu R
                       units/s (defaults 1, 0.5, 1, 0.5, 0.5; capped at half of provisioned,
                       or at N minus the original capacity with --boost)
  --out path           JSON report (default $TMPDIR/tag-index-repair-<time>.json; never the restore file)
  --restore-file path  capacity restore file (default reports/tag-index-repair-capacity.json)
  --restore-capacity   restore capacity from the restore file after a crash
  --help
`;

export const DEFAULT_RESTORE_FILE = 'reports/tag-index-repair-capacity.json';
export const DEFAULT_SETTLE_SECONDS = 600;
export const MIN_SETTLE_SECONDS = 360;
export const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const RATE_FLAGS: Record<RateKey, string> = { baseRcu: '--base-rcu', baseWcu: '--base-wcu', gsi1Rcu: '--gsi1-rcu', gsi2Rcu: '--gsi2-rcu', gsi2Wcu: '--gsi2-wcu' };
const FLAGS = new Set(['--execute', '--restore-capacity', '--help']);
const VALUED = new Set(['--boost', '--out', '--restore-file', '--settle-seconds', ...Object.values(RATE_FLAGS)]);

export interface RepairOptions {
    help:            boolean
    execute:         boolean
    restoreCapacity: boolean
    boost:           number | undefined
    out:             string | undefined
    restoreFile:     string
    settleSeconds:   number
    rates:           Rates
}

function parseRate(flag: string, raw: string | undefined, fallback: number, cap: number): number {
    if(raw === undefined) {
        return fallback;
    }
    const rate = Number(raw);
    if(!Number.isFinite(rate) || rate <= 0 || rate > cap) {
        throw new Error(`${flag} must be a positive number no greater than ${cap}, got ${raw}`);
    }
    return rate;
}

function parseSettle(raw: string | undefined): number {
    if(raw === undefined) {
        return DEFAULT_SETTLE_SECONDS;
    }
    const seconds = Number(raw);
    if(!Number.isFinite(seconds) || seconds < MIN_SETTLE_SECONDS) {
        throw new Error(`--settle-seconds must be at least ${MIN_SETTLE_SECONDS}, got ${raw}`);
    }
    return seconds;
}

/** Splits the arguments into boolean flags and valued options. */
function tokenize(argv: string[]): { flags: Set<string>, values: Map<string, string> } {
    const flags = new Set<string>();
    const values = new Map<string, string>();
    let awaiting: string | undefined;
    for(const arg of argv) {
        if(awaiting !== undefined) {
            if(arg.startsWith('--')) {
                throw new Error(`${awaiting} needs a value`);
            }
            values.set(awaiting, arg);
            awaiting = undefined;
        } else if(FLAGS.has(arg)) {
            flags.add(arg);
        } else if(VALUED.has(arg)) {
            awaiting = arg;
        } else {
            throw new Error(`Unknown option ${arg}; see --help`);
        }
    }
    if(awaiting !== undefined) {
        throw new Error(`${awaiting} needs a value`);
    }
    return { flags, values };
}

/** Parses the CLI arguments (without the bun and script entries). */
export function parseRepairArgs(argv: string[]): RepairOptions {
    const { flags, values } = tokenize(argv);
    const execute = flags.has('--execute');
    const rawBoost = values.get('--boost');
    if(rawBoost !== undefined && !execute) {
        throw new Error('--boost needs --execute: a dry run never changes capacity');
    }
    const restore = flags.has('--restore-capacity');
    if(restore && execute) {
        throw new Error('--restore-capacity runs on its own, without --execute');
    }
    const out = values.get('--out');
    const restoreFile = values.get('--restore-file') ?? DEFAULT_RESTORE_FILE;
    if(out !== undefined && path.resolve(out) === path.resolve(restoreFile)) {
        throw new Error(`--out must not be the restore file ${restoreFile}`);
    }
    const boost = rawBoost === undefined ? undefined : parseBoost(rawBoost);
    const caps = boost === undefined ? UNBOOSTED_CAPS : boostedRates(boost);
    const defaults = boost === undefined ? DEFAULT_RATES : caps;
    const rates = Object.fromEntries(RATE_KEYS.map(key => [key, parseRate(RATE_FLAGS[key], values.get(RATE_FLAGS[key]), defaults[key], caps[key])])) as Rates;
    return {
        help:            flags.has('--help'),
        execute,
        restoreCapacity: restore,
        boost,
        out,
        restoreFile,
        settleSeconds:   parseSettle(values.get('--settle-seconds')),
        rates,
    };
}

export interface RepairRuntime {
    tableName:   string
    admin:       CapacityAdmin
    createStore: (deps: AdapterDeps) => RepairStore
}

export interface RepairCliDeps {
    loadRuntime?: () => RepairRuntime
    log?:         (text: string) => void
    /** Sleeps `ms`, returning early (without error) once `signal` aborts. */
    sleep?:       (ms: number, signal?: AbortSignal) => Promise<void>
    now?:         () => number
    onSignal?:    (signal: NodeJS.Signals, handler: () => void) => void
    offSignal?:   (signal: NodeJS.Signals, handler: () => void) => void
    restoreFile?: (file: string) => RestoreFile
    saveReport?:  (file: string, text: string) => Promise<void>
}

/** The real timer, cut short by an abort. */
export async function cliSleep(ms: number, signal?: AbortSignal): Promise<void> {
    await sleepRespectingSignal(ms, signal).catch(() => undefined);
}

/** The restore file on disk; created exclusively so a second run never overwrites the originals. */
export function diskRestoreFile(file: string): RestoreFile {
    return {
        path: file,
        async read() {
            try {
                return JSON.parse(await readFile(file, 'utf8')) as CapacityState;
            } catch (error) {
                if((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return undefined;
                }
                throw error;
            }
        },
        async write(state) {
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
        },
        async delete() {
            await unlink(file);
        },
    };
}

export async function saveReportFile(file: string, text: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
}

/** The stage's table through `sst shell`. */
export function defaultRuntime(): RepairRuntime {
    const { client, docClient, tableName } = createDynamoDBClient(loadDynamoDBConfig(Resource));
    return { tableName, admin: createCapacityAdmin(client, tableName), createStore: deps => createRepairStore(docClient, tableName, deps) };
}

function describeUnits(units: Rates, rates: Rates): string {
    return RATE_KEYS.map(key => `${key} ${units[key]} (~${Math.ceil(units[key] / rates[key])} s)`).join(', ');
}

interface RunDeps {
    log:        (text: string) => void
    now:        () => number
    ctx:        RepairContext
    consumed:   Rates
    saveReport: (file: string, text: string) => Promise<void>
}

/** Scan, plan and report; with --execute also repair. */
async function repair(options: RepairOptions, rates: Rates, deps: RunDeps): Promise<void> {
    const { log, ctx } = deps;
    log(`${options.execute ? 'EXECUTE' : '[DRY RUN]'}: rates ${JSON.stringify(rates)} units/s`);
    const snapshot = await scan(ctx);
    const scanConsumed = { ...deps.consumed };
    const plan = planRepair(snapshot, toEpochSeconds(deps.now()));
    for(const name of BUCKET_NAMES) {
        const bucket = plan.buckets[name];
        log(`${name}: ${bucket.count}`);
        for(const example of bucket.examples) {
            log(`    ${example}`);
        }
    }
    const estimate = estimateExecute(snapshot, plan);
    log(`Planned: ${plan.rowWrites} row writes on ${plan.paths.size} memories; ${plan.recount.size} tags to recount`);
    log(`Estimated --execute units: ${describeUnits(estimate, rates)}, plus at least 2 settle intervals of ${options.settleSeconds} s`);
    let result: RepairResult | undefined;
    if(options.execute) {
        result = await executeRepair(ctx, plan, options.settleSeconds * 1000);
        log(`Repaired ${result.repaired}/${plan.paths.size} memories: ${result.rowWrites} row writes, ${result.metaWrites} META writes${result.aborted ? ' (ABORTED)' : ''}`);
        log(`Unsettled memories: ${result.unsettledPaths.join(', ') || 'none'}; unsettled tags: ${result.unsettledTags.join(', ') || 'none'}`);
        log('Run a dry run afterwards to confirm; rerun with --execute if anything is left.');
    } else {
        log('[DRY RUN] No writes sent; rerun with --execute to repair.');
    }
    const out = options.out ?? path.join(tmpdir(), `tag-index-repair-${deps.now()}.json`);
    const report = {
        dryRun:   !options.execute,
        rates,
        scanned:  { tags: snapshot.rows.size, memories: snapshot.memories.size, consumed: scanConsumed },
        buckets:  plan.buckets,
        planned:  { rowWrites: plan.rowWrites, memories: plan.paths.size, recountTags: [...plan.recount] },
        estimate,
        result,
        consumed: deps.consumed,
    };
    await deps.saveReport(out, `${JSON.stringify(report, null, 2)}\n`);
    log(`Report: ${out}`);
}

/**
 * Runs the repair: optional boost, scan, plan, report, optional execute, and restore of any boost
 * however the run ends. Aborts (signals) end the run early with a partial summary.
 */
export async function runRepairCli(argv: string[], deps: RepairCliDeps = {}): Promise<void> {
    // argv is process.argv: the bun binary and the script path come first.
    const options = parseRepairArgs(argv.slice(2));
    const log = deps.log ?? ((text: string) => {
        process.stdout.write(`${text}\n`);
    });
    if(options.help) {
        log(HELP);
        return;
    }
    const runtime = (deps.loadRuntime ?? defaultRuntime)();
    const sleep = deps.sleep ?? cliSleep;
    const now = deps.now ?? Date.now;
    const file = (deps.restoreFile ?? diskRestoreFile)(options.restoreFile);
    const capacity: CapacityDeps = { sleep: async ms => sleep(ms), now, log };
    const abort = new AbortController();
    const onSignal = (): void => {
        if(abort.signal.aborted) {
            log('restoring capacity, please wait');
            return;
        }
        abort.abort();
        log('Stopping after the current request; any capacity boost is restored before exit');
    };
    const on = deps.onSignal ?? ((signal: NodeJS.Signals, handler: () => void) => {
        process.on(signal, handler);
    });
    const off = deps.offSignal ?? ((signal: NodeJS.Signals, handler: () => void) => {
        process.off(signal, handler);
    });
    for(const signal of SIGNALS) {
        on(signal, onSignal);
    }
    try {
        if(options.restoreCapacity) {
            await restoreCapacity(runtime.admin, file, capacity);
            return;
        }
        await boostedRun(options, runtime, file, capacity, {
            log,
            now,
            signal:     abort.signal,
            sleep:      async ms => sleep(ms, abort.signal),
            saveReport: deps.saveReport ?? saveReportFile,
        });
    } finally {
        for(const signal of SIGNALS) {
            off(signal, onSignal);
        }
    }
}

interface BoostedRunDeps {
    log:        (text: string) => void
    now:        () => number
    signal:     AbortSignal
    sleep:      (ms: number) => Promise<void>
    saveReport: (file: string, text: string) => Promise<void>
}

async function boostedRun(options: RepairOptions, runtime: RepairRuntime, file: RestoreFile, capacity: CapacityDeps, deps: BoostedRunDeps): Promise<void> {
    const { log } = deps;
    let boosted = false;
    let failure: Error | undefined;
    try {
        if(options.boost !== undefined) {
            const original = await validateBoost(runtime.admin, file);
            // Ownership starts only once this run has created the restore file: a run that loses
            // that race must not restore, or it would undo another run's boost and delete its file.
            await saveOriginal(file, original, capacity);
            boosted = true;
            await applyBoost(runtime.admin, original, options.boost, capacity);
        }
        const pacing = createPacing(options.rates, deps.sleep, deps.now);
        const store = runtime.createStore({ sleep: deps.sleep, signal: deps.signal });
        const ctx: RepairContext = { store, charge: pacing.charge, sleep: deps.sleep, now: deps.now, log, signal: deps.signal };
        await repair(options, options.rates, { log, now: deps.now, ctx, consumed: pacing.consumed, saveReport: deps.saveReport });
    } catch (error) {
        if(isAbortError(error)) {
            log('Aborted before the scan finished; nothing was repaired');
        } else {
            failure = error as Error;
        }
    }
    if(boosted) {
        try {
            await restoreCapacity(runtime.admin, file, capacity);
        } catch (restoreError) {
            if(failure !== undefined) {
                log(`The repair had already failed: ${failure.message}`);
            }
            throw restoreError;
        }
    }
    if(failure !== undefined) {
        throw failure;
    }
}

// Stryker disable next-line BlockStatement,ConditionalExpression: main-entry guard and block run only as a CLI subprocess, invisible to in-process coverage; forcing the condition false is indistinguishable from an untested branch without invoking bun as a subprocess.
if(import.meta.main) {
    // Stryker disable next-line AwaitDrop: Distinguishing top-level rejection from unhandledRejection requires a main-entry subprocess, exceeding the sub-1ms test budget; not equivalent.
    await runRepairCli(process.argv);
}

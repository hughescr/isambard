import { describe, test, expect, afterEach, jest, spyOn } from 'bun:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    DEFAULT_RESTORE_FILE,
    HELP,
    cliSleep,
    defaultRuntime,
    diskRestoreFile,
    parseRepairArgs,
    runRepairCli,
    saveReportFile,
    type RepairCliDeps,
    type RepairRuntime
} from '../../../tools/repair-tag-index';
import type { AdapterDeps } from '../../../tools/repair-tag-index-aws';
import { EXPECTED, boostedRates, type CapacityAdmin, type CapacityState, type Resource, type RestoreFile } from '../../../tools/repair-tag-index-capacity';
import type { Memory, Meta, RepairStore, TagRow, WriteResult } from '../../../tools/repair-tag-index-core';
import { mockFsPromises, resetMockFs } from '../../setup';

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    resetMockFs();
});

/** process.argv's leading bun binary and script path. */
const ARGV0 = ['bun', 'tools/repair-tag-index.ts'];

const MEMORY: Memory = { path: '/identity/a', tags: new Set(['x']), updatedAt: '2026-01-01T00:00:00.000Z', content: 'hello' };

/**
 * Counts fake operations still settling, per plane. Data-plane requests (the store and its
 * pacing sleeps) may overlap each other, since the repair runs a worker pool; a control-plane
 * operation (capacity, restore file, capacity polls, report) overlapping anything means an await
 * was skipped, or capacity was touched while repair requests were still in flight.
 */
const inFlight = { data: 0, control: 0 };

type Plane = keyof typeof inFlight;

/** Guards against overlap, then lets `turns` microtasks pass before the caller sees the effect. */
async function settle(turns: number, plane: Plane = 'control'): Promise<void> {
    if(inFlight.control > 0 || (plane === 'control' && inFlight.data > 0)) {
        throw new Error(`${plane} operation started before the previous one settled`);
    }
    inFlight[plane]++;
    for(let turn = 0; turn < turns; turn++) {
        // eslint-disable-next-line no-await-in-loop -- sequential: each turn is one microtask
        await Promise.resolve();
    }
    inFlight[plane]--;
}

/** One memory tagged x whose row is missing: the plan puts it and recounts x. */
class SmallStore implements RepairStore {
    readonly calls: string[] = [];
    rows:           TagRow[] = [];
    meta:           Meta | undefined;
    onRead:         (() => void) | undefined;
    memory:         Memory = MEMORY;
    /** Further identity memories the namespace walk returns. */
    others:         Memory[] = [];

    async listMetaCounts(): Promise<{ items: Meta[], next: undefined, units: { gsi2Rcu: number } }> {
        await settle(1, 'data');
        this.calls.push('list');
        return { items: [], next: undefined, units: { gsi2Rcu: 1 } };
    }

    async readTagPartition(tag: string, _start: unknown, strong: boolean): Promise<{ rows: TagRow[], meta: Meta | undefined, next: undefined, units: { baseRcu: number } }> {
        await settle(1, 'data');
        this.calls.push(`partition ${tag} ${String(strong)}`);
        this.onRead?.();
        return { rows: structuredClone(this.rows), meta: structuredClone(this.meta), next: undefined, units: { baseRcu: 1 } };
    }

    async walkNamespace(namespace: string): Promise<{ items: Memory[], next: undefined, units: { gsi1Rcu: number } }> {
        await settle(1, 'data');
        return { items: namespace === 'identity' ? [this.memory, ...this.others] : [], next: undefined, units: { gsi1Rcu: 1 } };
    }

    async getMemory(): Promise<{ item: Memory, units: { baseRcu: number } }> {
        await settle(1, 'data');
        this.calls.push('getMemory');
        return { item: this.memory, units: { baseRcu: 1 } };
    }

    async getRows(): Promise<{ items: TagRow[], unprocessed: string[], units: { baseRcu: number } }> {
        await settle(1, 'data');
        return { items: structuredClone(this.rows), unprocessed: [], units: { baseRcu: 1 } };
    }

    async putRow(row: TagRow): Promise<WriteResult> {
        await settle(1, 'data');
        this.calls.push('putRow');
        this.rows = [row];
        return { status: 'ok', units: { baseWcu: 1 } };
    }

    async deleteRow(): Promise<WriteResult> {
        await settle(1, 'data');
        this.calls.push('deleteRow');
        return { status: 'ok', units: { baseWcu: 1 } };
    }

    async setMeta(tag: string, count: number): Promise<WriteResult> {
        await settle(1, 'data');
        this.calls.push(`setMeta ${tag} ${count}`);
        this.meta = { PK: `TAG#${tag}`, SK: 'META_COUNT', count, GSI2PK: 'TAG_COUNTS', GSI2SK: `TAG#${tag}` };
        return { status: 'ok', units: { baseWcu: 1, gsi2Wcu: 1 } };
    }

    async deleteMeta(): Promise<WriteResult> {
        await settle(1, 'data');
        this.calls.push('deleteMeta');
        return { status: 'ok', units: { baseWcu: 1 } };
    }
}

function provisioned(): CapacityState {
    return {
        tableName: 'IsambardMemory',
        billing:   'PROVISIONED',
        resources: {
            table: { status: 'ACTIVE', ...EXPECTED.table, decreasesToday: 0 },
            GSI1:  { status: 'ACTIVE', ...EXPECTED.GSI1, decreasesToday: 0 },
            GSI2:  { status: 'ACTIVE', ...EXPECTED.GSI2, decreasesToday: 0 },
        },
    };
}

class FakeAdmin implements CapacityAdmin {
    readonly state = provisioned();

    constructor(readonly events: string[]) {}

    async describe(): Promise<CapacityState> {
        await settle(1);
        this.events.push('describe');
        return structuredClone(this.state);
    }

    async update(resource: Resource, rcu: number, wcu: number): Promise<void> {
        await settle(2);
        this.events.push(`update ${resource} ${rcu}/${wcu}`);
        this.state.resources[resource] = { ...this.state.resources[resource], rcu, wcu };
    }
}

function memoryFile(events: string[], saved?: CapacityState): RestoreFile & { saved: CapacityState | undefined } {
    return {
        path: 'restore.json',
        saved,
        async read() {
            await settle(1);
            events.push('file read');
            return structuredClone(this.saved);
        },
        async write(state) {
            await settle(1);
            events.push('file write');
            this.saved = state;
        },
        async delete() {
            await settle(1);
            events.push('file delete');
            this.saved = undefined;
        },
    };
}

interface Cli {
    deps:     RepairCliDeps & { onSignal: NonNullable<RepairCliDeps['onSignal']> }
    store:    SmallStore
    admin:    FakeAdmin
    file:     ReturnType<typeof memoryFile>
    events:   string[]
    logs:     string[]
    sleeps:   { ms: number, signal: AbortSignal | undefined }[]
    reports:  { file: string, text: string }[]
    handlers: Map<string, () => void>
    removed:  { signal: string, handler: () => void }[]
    /** The deps the CLI gave the store adapter. */
    adapter:  { deps: AdapterDeps | undefined }
}

function cli(saved?: CapacityState): Cli {
    const events: string[] = [];
    const logs: string[] = [];
    const sleeps: Cli['sleeps'] = [];
    const reports: Cli['reports'] = [];
    const handlers = new Map<string, () => void>();
    const removed: Cli['removed'] = [];
    const store = new SmallStore();
    const admin = new FakeAdmin(events);
    const file = memoryFile(events, saved);
    let clock = 1_000_000;
    const adapter: Cli['adapter'] = { deps: undefined };
    const runtime: RepairRuntime = {
        tableName:   'IsambardMemory',
        admin,
        createStore: (deps) => {
            adapter.deps = deps;
            return store;
        },
    };
    return {
        store,
        admin,
        file,
        events,
        logs,
        sleeps,
        reports,
        handlers,
        removed,
        adapter,
        deps: {
            loadRuntime: () => runtime,
            log:         (text) => { logs.push(text); },
            now:         () => clock,
            sleep:       async (ms, signal) => {
                sleeps.push({ ms, signal });
                await settle(3, signal === undefined ? 'control' : 'data');
                clock += ms;
            },
            onSignal:    (signal, handler) => { handlers.set(signal, handler); },
            offSignal:   (signal, handler) => { removed.push({ signal, handler }); },
            restoreFile: (name) => {
                events.push(`restore file ${name}`);
                return file;
            },
            saveReport: async (name, text) => {
                await settle(1);
                reports.push({ file: name, text });
                logs.push(`saved ${name}`);
            },
        },
    };
}

describe('repair-tag-index CLI arguments', () => {
    test('parseRepairArgs defaults to a dry run at free-tier-safe rates', () => {
        expect(parseRepairArgs([])).toStrictEqual({
            help:            false,
            execute:         false,
            restoreCapacity: false,
            boost:           undefined,
            out:             undefined,
            restoreFile:     DEFAULT_RESTORE_FILE,
            settleSeconds:   600,
            rates:           { baseRcu: 1, baseWcu: 0.5, gsi1Rcu: 1, gsi2Rcu: 0.5, gsi2Wcu: 0.5 },
            concurrency:     1,
        });
        expect(DEFAULT_RESTORE_FILE).toBe('reports/tag-index-repair-capacity.json');
    });

    test('parseRepairArgs reads every option', () => {
        expect(parseRepairArgs([
            '--execute', '--boost', '6', '--out', 'r.json', '--restore-file', 'f.json', '--settle-seconds', '360',
            '--base-rcu', '0.5', '--base-wcu', '4', '--gsi1-rcu', '4', '--gsi2-rcu', '0.5', '--gsi2-wcu', '5', '--concurrency', '7', '--help',
        ])).toStrictEqual({
            help:            true,
            execute:         true,
            restoreCapacity: false,
            boost:           6,
            out:             'r.json',
            restoreFile:     'f.json',
            settleSeconds:   360,
            rates:           { baseRcu: 0.5, baseWcu: 4, gsi1Rcu: 4, gsi2Rcu: 0.5, gsi2Wcu: 5 },
            concurrency:     7,
        });
    });

    test('parseRepairArgs defaults boosted rates to the boost minus the original capacity', () => {
        expect(parseRepairArgs(['--execute', '--boost', '50']).rates).toStrictEqual(boostedRates(50));
    });

    test('parseRepairArgs defaults the concurrency from the chosen rates', () => {
        expect(parseRepairArgs(['--execute', '--boost', '50']).concurrency).toBe(30);
        expect(parseRepairArgs(['--execute', '--boost', '50', '--gsi2-wcu', '10', '--base-wcu', '10', '--gsi1-rcu', '10']).concurrency).toBe(27);
    });

    test('parseRepairArgs accepts a concurrency from 1 to 64 and rejects anything else', () => {
        expect(parseRepairArgs(['--concurrency', '1']).concurrency).toBe(1);
        expect(parseRepairArgs(['--concurrency', '64']).concurrency).toBe(64);
        for(const raw of ['0', '65', '2.5', 'many']) {
            expect(() => parseRepairArgs(['--concurrency', raw])).toThrow(`--concurrency must be an integer from 1 to 64, got ${raw}`);
        }
    });

    test('parseRepairArgs caps unboosted rates at half of provisioned', () => {
        expect(parseRepairArgs(['--base-rcu', '2.5']).rates.baseRcu).toBe(2.5);
        expect(() => parseRepairArgs(['--base-rcu', '2.6'])).toThrow('--base-rcu must be a positive number no greater than 2.5, got 2.6');
        expect(() => parseRepairArgs(['--gsi2-wcu', '0.6'])).toThrow('--gsi2-wcu must be a positive number no greater than 0.5, got 0.6');
    });

    test('parseRepairArgs caps boosted rates at the boost minus the original capacity', () => {
        expect(parseRepairArgs(['--execute', '--boost', '50', '--base-rcu', '45']).rates.baseRcu).toBe(45);
        expect(() => parseRepairArgs(['--execute', '--boost', '50', '--base-rcu', '45.5'])).toThrow('--base-rcu must be a positive number no greater than 45, got 45.5');
    });

    test('parseRepairArgs rejects rates that are not finite and positive', () => {
        expect(() => parseRepairArgs(['--gsi1-rcu', '0'])).toThrow('--gsi1-rcu must be a positive number no greater than 1, got 0');
        expect(() => parseRepairArgs(['--gsi1-rcu', '-1'])).toThrow('--gsi1-rcu must be a positive number no greater than 1, got -1');
        expect(() => parseRepairArgs(['--gsi1-rcu', 'fast'])).toThrow('--gsi1-rcu must be a positive number no greater than 1, got fast');
    });

    test('parseRepairArgs rejects a settle interval below 360 seconds or not finite', () => {
        expect(() => parseRepairArgs(['--settle-seconds', '359'])).toThrow('--settle-seconds must be at least 360, got 359');
        expect(() => parseRepairArgs(['--settle-seconds', 'Infinity'])).toThrow('--settle-seconds must be at least 360, got Infinity');
        expect(() => parseRepairArgs(['--settle-seconds', 'soon'])).toThrow('--settle-seconds must be at least 360, got soon');
    });

    test('parseRepairArgs rejects a boost without --execute and out of range', () => {
        expect(() => parseRepairArgs(['--boost', '50'])).toThrow('--boost needs --execute: a dry run never changes capacity');
        expect(() => parseRepairArgs(['--execute', '--boost', '5'])).toThrow('--boost must be an integer from 6 to 50, got 5');
        expect(() => parseRepairArgs(['--execute', '--boost', '51'])).toThrow('--boost must be an integer from 6 to 50, got 51');
    });

    test('parseRepairArgs rejects --restore-capacity with --execute', () => {
        expect(parseRepairArgs(['--restore-capacity']).restoreCapacity).toBe(true);
        expect(() => parseRepairArgs(['--restore-capacity', '--execute'])).toThrow('--restore-capacity runs on its own, without --execute');
    });

    test('parseRepairArgs rejects a report path that is the restore file', () => {
        expect(() => parseRepairArgs(['--out', './reports/tag-index-repair-capacity.json'])).toThrow('--out must not be the restore file reports/tag-index-repair-capacity.json');
        expect(() => parseRepairArgs(['--execute', '--boost', '50', '--restore-file', './restore.json', '--out', 'restore.json'])).toThrow('--out must not be the restore file ./restore.json');
    });

    test('parseRepairArgs rejects unknown options and missing values', () => {
        expect(() => parseRepairArgs(['--dry-run'])).toThrow('Unknown option --dry-run; see --help');
        expect(() => parseRepairArgs(['--out'])).toThrow('--out needs a value');
        expect(() => parseRepairArgs(['--out', '--execute'])).toThrow('--out needs a value');
    });

    test('parseRepairArgs accepts a value that contains -- without starting with it', () => {
        expect(parseRepairArgs(['--out', 'a--b']).out).toBe('a--b');
    });
});

describe('repair-tag-index CLI runs', () => {
    test('--help prints usage without loading the runtime', async () => {
        const logs: string[] = [];

        await runRepairCli([...ARGV0, '--help'], {
            log:         (text) => { logs.push(text); },
            loadRuntime: () => {
                throw new Error('runtime must stay unloaded');
            },
        });

        expect(logs).toStrictEqual([HELP]);
        expect(HELP).toContain('sst shell -- bun tools/repair-tag-index.ts [--execute] [--boost N]');
    });

    test('--help writes to stdout by default', async () => {
        const write = spyOn(process.stdout, 'write').mockImplementation(() => true);

        await runRepairCli([...ARGV0, '--help']);

        expect(write).toHaveBeenCalledWith(`${HELP}\n`);
    });

    test('a dry run sends no writes and reports buckets, estimates and the report path', async () => {
        const run = cli();

        await runRepairCli(ARGV0, run.deps);

        expect(run.store.calls).toStrictEqual(['list', 'partition x false']);
        expect(run.events).toStrictEqual([`restore file ${DEFAULT_RESTORE_FILE}`]);
        expect(run.logs).toContain('[DRY RUN]: rates {"baseRcu":1,"baseWcu":0.5,"gsi1Rcu":1,"gsi2Rcu":0.5,"gsi2Wcu":0.5} units/s, concurrency 1');
        expect(run.logs).toContain('missing: 1');
        expect(run.logs).toContain('    x :: /identity/a');
        expect(run.logs).toContain('Planned: 1 row writes on 1 memories; 1 tags to recount');
        expect(run.logs).toContain('Estimated --execute units: baseRcu 7 (~7 s), baseWcu 2 (~4 s), gsi1Rcu 0 (~0 s), gsi2Rcu 0 (~0 s), gsi2Wcu 1 (~2 s), plus at least 2 settle intervals of 600 s');
        expect(run.logs).toContain('[DRY RUN] No writes sent; rerun with --execute to repair.');
        // Paced before each request: only the 2nd to 4th GSI1 walks wait (1 s each) on the one before.
        const reportFile = path.join(tmpdir(), 'tag-index-repair-1003000.json');
        expect(run.logs.slice(-2)).toStrictEqual([`saved ${reportFile}`, `Report: ${reportFile}`]);
        expect(run.reports).toHaveLength(1);
        expect(run.reports[0]?.file).toBe(reportFile);
        expect(run.reports[0]?.text.startsWith('{\n  "dryRun": true,\n  "rates": {\n    "baseRcu": 1,')).toBe(true);
        expect(run.reports[0]?.text.endsWith('\n}\n')).toBe(true);
        const report = JSON.parse(run.reports[0]?.text ?? '') as Record<string, unknown>;
        expect(report.dryRun).toBe(true);
        expect(report.planned).toStrictEqual({ rowWrites: 1, memories: 1, recountTags: ['x'] });
        expect(report.scanned).toStrictEqual({ tags: 1, memories: 1, consumed: { baseRcu: 1, baseWcu: 0, gsi1Rcu: 4, gsi2Rcu: 1, gsi2Wcu: 0 } });
        expect(report.result).toBeUndefined();
        expect(run.handlers.size).toBe(3);
        expect(run.removed.map(entry => entry.signal)).toStrictEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
    });

    test('--execute repairs, recounts and summarises', async () => {
        const run = cli();

        await runRepairCli([...ARGV0, '--execute', '--out', 'out.json'], run.deps);

        expect(run.store.calls).toContain('putRow');
        expect(run.store.calls).toContain('setMeta x 1');
        expect(run.logs).toContain('Repaired 1/1 memories: 1 row writes, 1 META writes');
        expect(run.logs).toContain('Unsettled memories: none; unsettled tags: none');
        expect(run.logs).toContain('Run a dry run afterwards to confirm; rerun with --execute if anything is left.');
        expect(run.reports[0]?.file).toBe('out.json');
        const report = JSON.parse(run.reports[0]?.text ?? '') as { dryRun: boolean, result: Record<string, unknown> };
        expect(report.dryRun).toBe(false);
        expect(report.result).toStrictEqual({ repaired: 1, unsettledPaths: [], unsettledTags: [], rowWrites: 1, metaWrites: 1, aborted: false });
        expect(run.sleeps.filter(entry => entry.ms === 600_000)).toHaveLength(2);
        expect(run.sleeps.every(entry => entry.signal instanceof AbortSignal)).toBe(true);
    });

    test('--execute lists unsettled memories and tags', async () => {
        const run = cli();
        run.store.putRow = async () => ({ status: 'conditionFailed', units: { baseWcu: 1 } });
        run.store.setMeta = async () => ({ status: 'conditionFailed', units: { baseWcu: 1 } });
        run.store.rows = [{ PK: 'TAG#x', SK: 'PATH#/identity/other' }];
        run.store.memory = { ...MEMORY, tags: new Set(['x', 'y']) };

        await runRepairCli([...ARGV0, '--execute'], run.deps);

        expect(run.logs).toContain('Unsettled memories: /identity/other, /identity/a; unsettled tags: x, y');
    });

    test('--execute --boost boosts before the scan and restores afterwards', async () => {
        const run = cli();
        run.store.onRead = () => {
            run.events.push('scan');
            run.store.onRead = undefined;
        };

        await runRepairCli([...ARGV0, '--execute', '--boost', '6'], run.deps);

        expect(run.events).toStrictEqual([
            `restore file ${DEFAULT_RESTORE_FILE}`,
            'file read', 'describe', 'file write',
            'update table 6/6', 'describe', 'update GSI1 6/2', 'describe', 'update GSI2 1/6', 'describe', 'describe',
            'scan',
            'file read', 'describe', 'describe', 'update table 5/2', 'describe', 'update GSI1 2/2', 'describe', 'update GSI2 1/1', 'describe', 'file delete',
        ]);
        expect(run.logs).toContain('EXECUTE: rates {"baseRcu":1,"baseWcu":4,"gsi1Rcu":4,"gsi2Rcu":0.5,"gsi2Wcu":5} units/s, concurrency 3');
        expect(run.admin.state).toStrictEqual(provisioned());
    });

    test('a refused boost changes nothing and scans nothing', async () => {
        const run = cli(provisioned());

        await expect(runRepairCli([...ARGV0, '--execute', '--boost', '6'], run.deps)).rejects.toThrow('Restore file restore.json exists from an earlier run');

        expect(run.events).toStrictEqual([`restore file ${DEFAULT_RESTORE_FILE}`, 'file read']);
        expect(run.store.calls).toStrictEqual([]);
        expect(run.removed).toHaveLength(3);
    });

    test('a boost that loses the restore file to another run restores nothing and changes no capacity', async () => {
        const run = cli();
        run.file.write = async () => {
            await settle(1);
            run.events.push('file write refused');
            throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
        };

        await expect(runRepairCli([...ARGV0, '--execute', '--boost', '6'], run.deps)).rejects.toThrow('EEXIST: file already exists');

        expect(run.events).toStrictEqual([`restore file ${DEFAULT_RESTORE_FILE}`, 'file read', 'describe', 'file write refused']);
        expect(run.store.calls).toStrictEqual([]);
        expect(run.admin.state).toStrictEqual(provisioned());
    });

    test('a failing repair still restores a boost and then rethrows the failure', async () => {
        const run = cli();
        run.store.listMetaCounts = async () => {
            throw new Error('boom');
        };

        await expect(runRepairCli([...ARGV0, '--execute', '--boost', '6'], run.deps)).rejects.toThrow('boom');

        expect(run.events.at(-1)).toBe('file delete');
        expect(run.admin.state).toStrictEqual(provisioned());
    });

    test('a failing restore after a failing repair reports both and rethrows the restore failure', async () => {
        const run = cli();
        run.store.listMetaCounts = async () => {
            throw new Error('boom');
        };
        run.file.delete = async () => {
            throw new Error('disk gone');
        };

        await expect(runRepairCli([...ARGV0, '--execute', '--boost', '6'], run.deps)).rejects.toThrow('disk gone');

        expect(run.logs).toContain('The repair had already failed: boom');
    });

    test('a failing restore after a successful repair rethrows the restore failure', async () => {
        const run = cli();
        run.file.delete = async () => {
            throw new Error('disk gone');
        };

        await expect(runRepairCli([...ARGV0, '--execute', '--boost', '6'], run.deps)).rejects.toThrow('disk gone');

        expect(run.logs.some(line => line.startsWith('The repair had already failed'))).toBe(false);
    });

    test('capacity polls sleep without the abort signal', async () => {
        const run = cli();
        let polls = 0;
        const describeTable = run.admin.describe.bind(run.admin);
        run.admin.describe = async () => {
            const state = await describeTable();
            if(++polls === 3) {
                state.resources.GSI1.status = 'UPDATING';
            }
            return state;
        };

        await runRepairCli([...ARGV0, '--execute', '--boost', '6'], run.deps);

        expect(run.sleeps[0]).toStrictEqual({ ms: 5000, signal: undefined });
    });

    test('the first signal aborts the run with a partial summary and later ones ask to wait', async () => {
        const run = cli();
        run.store.listMetaCounts = async () => {
            run.handlers.get('SIGTERM')?.();
            run.handlers.get('SIGINT')?.();
            return { items: [], next: undefined, units: { gsi2Rcu: 1 } };
        };

        await runRepairCli([...ARGV0, '--execute', '--boost', '6'], run.deps);

        expect(run.logs).toContain('Stopping: no new requests; waiting for the ones in flight, then any capacity boost is restored before exit');
        expect(run.logs).toContain('restoring capacity, please wait');
        expect(run.logs).toContain('Aborted before the scan finished; nothing was repaired');
        expect(run.logs.filter(line => line.startsWith('Stopping'))).toHaveLength(1);
        expect(run.store.calls).toStrictEqual([]);
        expect(run.events.at(-1)).toBe('file delete');
        expect(run.reports).toStrictEqual([]);
        expect(run.removed).toHaveLength(3);
        expect(run.removed.every(entry => entry.handler === run.handlers.get('SIGINT'))).toBe(true);
    });

    test('an abort during the repair prints the partial summary', async () => {
        const run = cli();
        run.store.getMemory = async () => {
            run.handlers.get('SIGHUP')?.();
            return { item: MEMORY, units: { baseRcu: 1 } };
        };

        await runRepairCli([...ARGV0, '--execute'], run.deps);

        expect(run.logs).toContain('Repaired 0/1 memories: 0 row writes, 0 META writes (ABORTED)');
        expect(run.reports).toHaveLength(1);
    });

    test('an abort with several requests in flight restores the boost only after they all settle', async () => {
        const run = cli();
        run.store.others = ['/identity/b', '/identity/c', '/identity/d'].map(memoryPath => ({ ...MEMORY, path: memoryPath }));
        const gates: PromiseWithResolvers<void>[] = [];
        const allHeld = Promise.withResolvers<void>();
        run.store.getMemory = async () => {
            const gate = Promise.withResolvers<void>();
            gates.push(gate);
            run.events.push(`getMemory ${gates.length} sent`);
            if(gates.length === 3) {
                allHeld.resolve();
            }
            await gate.promise;
            run.events.push('getMemory settled');
            return { item: MEMORY, units: { baseRcu: 1 } };
        };

        const running = runRepairCli([...ARGV0, '--execute', '--boost', '6'], run.deps);
        await allHeld.promise;
        run.handlers.get('SIGINT')?.();
        const heldAt = run.events.length;
        for(const gate of gates) {
            gate.resolve();
            // eslint-disable-next-line no-await-in-loop -- sequential: settle one request in flight at a time
            await Promise.resolve();
        }
        await running;

        expect(run.events.slice(heldAt - 3, heldAt + 4)).toStrictEqual(['getMemory 1 sent', 'getMemory 2 sent', 'getMemory 3 sent', 'getMemory settled', 'getMemory settled', 'getMemory settled', 'file read']);
        expect(run.events.at(-1)).toBe('file delete');
        expect(run.logs).toContain('Repaired 0/4 memories: 0 row writes, 0 META writes (ABORTED)');
    });

    test('a throttled request waits out its hold in the run\'s shared pacing', async () => {
        const run = cli();
        const events: string[] = [];
        run.store.listMetaCounts = async () => {
            events.push('listed');
            await run.adapter.deps?.onThrottle(['gsi2Rcu'], 7000);
            events.push('hold ended');
            return { items: [], next: undefined, units: { gsi2Rcu: 1 } };
        };

        await runRepairCli([...ARGV0, '--out', 'o.json'], run.deps);

        // The retry waits the 7 s hold on the run's abortable data sleep; the three GSI1 walks
        // after the first then wait 1 s each for the one before.
        expect(events).toStrictEqual(['listed', 'hold ended']);
        expect(run.sleeps.map(entry => `${entry.ms} ${entry.signal === undefined ? 'control' : 'data'}`)).toStrictEqual(['7000 data', '1000 data', '1000 data', '1000 data']);
    });

    test('--restore-capacity restores from the restore file', async () => {
        const run = cli(provisioned());
        run.admin.state.resources.table = { ...run.admin.state.resources.table, rcu: 50, wcu: 50 };

        await runRepairCli([...ARGV0, '--restore-capacity', '--restore-file', 'mine.json'], run.deps);

        expect(run.events[0]).toBe('restore file mine.json');
        expect(run.admin.state).toStrictEqual(provisioned());
        expect(run.file.saved).toBeUndefined();
        expect(run.store.calls).toStrictEqual([]);
        expect(run.removed).toHaveLength(3);
    });
});

describe('repair-tag-index CLI defaults', () => {
    test('defaultRuntime builds the adapters for the stage table', () => {
        const runtime = defaultRuntime();

        expect(runtime.tableName).toBe('IsambardMemory');
        expect(typeof runtime.admin.describe).toBe('function');
        expect(typeof runtime.createStore({ onThrottle: async () => undefined }).getRows).toBe('function');
    });

    test('the default signal hooks register and remove process handlers', async () => {
        const on = spyOn(process, 'on');
        const off = spyOn(process, 'off');
        const run = cli();

        await expect(runRepairCli([...ARGV0, '--restore-capacity'], { ...run.deps, onSignal: undefined, offSignal: undefined })).rejects.toThrow('No restore file at restore.json; nothing to restore');

        const handler = on.mock.calls.find(call => String(call[0]) === 'SIGINT')?.[1];
        expect(on.mock.calls.filter(call => ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(String(call[0])))).toHaveLength(3);
        expect(off).toHaveBeenCalledWith('SIGHUP', handler);
    });

    test('the default runtime and restore file are used when not injected', async () => {
        const run = cli();

        await expect(runRepairCli([...ARGV0, '--restore-capacity', '--restore-file', '/tmp/none.json'], { log: run.deps.log, onSignal: run.deps.onSignal, offSignal: run.deps.offSignal })).rejects.toThrow('No restore file at /tmp/none.json; nothing to restore');
    });

    test('the default clock and report writer are used when not injected', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(5_000_000));
        const run = cli();
        // The pacing checks the default clock once each wait ends, so a sleep must move it.
        const sleep = async (ms: number): Promise<void> => {
            await Promise.resolve();
            jest.setSystemTime(new Date(Date.now() + ms));
        };

        await runRepairCli(ARGV0, { ...run.deps, now: undefined, saveReport: undefined, sleep });

        // Three GSI1 walks each wait 1 s for the one before, on the default clock.
        const reportFile = path.join(tmpdir(), 'tag-index-repair-5003000.json');
        expect(run.logs.at(-1)).toBe(`Report: ${reportFile}`);
        expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(1);
        expect(mockFsPromises.writeFile.mock.calls[0]?.[0]).toBe(reportFile);
    });

    test('cliSleep waits on a real timer', async () => {
        jest.useFakeTimers();
        let done = false;

        const sleeping = (async () => {
            await cliSleep(1000);
            done = true;
        })();
        jest.advanceTimersByTime(999);
        await Promise.resolve();
        expect(done).toBe(false);
        jest.advanceTimersByTime(1);
        await sleeping;

        expect(done).toBe(true);
    });

    test('cliSleep returns early without error once aborted', async () => {
        jest.useFakeTimers();
        const abort = new AbortController();

        const sleeping = cliSleep(60_000, abort.signal);
        abort.abort();

        expect(await sleeping).toBeUndefined();
    });

    test('diskRestoreFile reads nothing when the file is missing', async () => {
        expect(await diskRestoreFile('reports/missing.json').read()).toBeUndefined();
    });

    test('diskRestoreFile writes exclusively, reads back and deletes', async () => {
        const file = diskRestoreFile('reports/capacity.json');

        await file.write(provisioned());

        expect(mockFsPromises.mkdir).toHaveBeenCalledWith('reports', { recursive: true });
        expect(mockFsPromises.writeFile).toHaveBeenCalledWith('reports/capacity.json', `${JSON.stringify(provisioned(), null, 2)}\n`, { flag: 'wx' });
        expect(await file.read()).toStrictEqual(provisioned());
        expect(mockFsPromises.readFile).toHaveBeenCalledWith('reports/capacity.json', 'utf8');
        expect(file.path).toBe('reports/capacity.json');
        await file.delete();
        expect(await file.read()).toBeUndefined();
    });

    test('diskRestoreFile rethrows read errors other than a missing file', async () => {
        mockFsPromises.readFile.mockImplementationOnce(async () => {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        });

        await expect(diskRestoreFile('reports/capacity.json').read()).rejects.toThrow('EACCES: permission denied');
    });

    test('diskRestoreFile write propagates a mkdir failure and never writes the file', async () => {
        mockFsPromises.mkdir.mockImplementationOnce(async () => {
            throw new Error('mkdir boom');
        });

        await expect(diskRestoreFile('reports/capacity.json').write(provisioned())).rejects.toThrow('mkdir boom');

        expect(mockFsPromises.writeFile).not.toHaveBeenCalled();
    });

    test('diskRestoreFile write propagates a writeFile failure', async () => {
        mockFsPromises.writeFile.mockImplementationOnce(async () => {
            throw new Error('write boom');
        });

        await expect(diskRestoreFile('reports/capacity.json').write(provisioned())).rejects.toThrow('write boom');
    });

    test('diskRestoreFile delete propagates an unlink failure', async () => {
        mockFsPromises.unlink.mockImplementationOnce(async () => {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        });

        await expect(diskRestoreFile('reports/capacity.json').delete()).rejects.toThrow('EACCES: permission denied');
    });

    test('saveReportFile creates the directory and writes the report', async () => {
        await saveReportFile('out/dir/report.json', '{}\n');

        expect(mockFsPromises.mkdir).toHaveBeenCalledWith('out/dir', { recursive: true });
        expect(mockFsPromises.writeFile).toHaveBeenCalledWith('out/dir/report.json', '{}\n');
    });

    test('saveReportFile propagates a mkdir failure and never writes the file', async () => {
        mockFsPromises.mkdir.mockImplementationOnce(async () => {
            throw new Error('mkdir boom');
        });

        await expect(saveReportFile('out/dir/report.json', '{}\n')).rejects.toThrow('mkdir boom');

        expect(mockFsPromises.writeFile).not.toHaveBeenCalled();
    });

    test('saveReportFile propagates a writeFile failure', async () => {
        mockFsPromises.writeFile.mockImplementationOnce(async () => {
            throw new Error('write boom');
        });

        await expect(saveReportFile('out/dir/report.json', '{}\n')).rejects.toThrow('write boom');
    });
});

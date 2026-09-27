import { describe, test, expect } from 'bun:test';
import {
    ACTIVE_TIMEOUT_MS,
    DEFAULT_RATES,
    EXPECTED,
    RESTORE_WINDOW_MS,
    UNBOOSTED_CAPS,
    applyBoost,
    boostTargets,
    boostedRates,
    parseBoost,
    restoreCapacity,
    restoreCommands,
    saveOriginal,
    validateBoost,
    waitActive,
    type CapacityAdmin,
    type CapacityDeps,
    type CapacityState,
    type Resource,
    type RestoreFile
} from '../../../tools/repair-tag-index-capacity';

function provisioned(overrides: Partial<Record<Resource, Partial<CapacityState['resources'][Resource]>>> = {}): CapacityState {
    return {
        tableName: 'IsambardMemory',
        billing:   'PROVISIONED',
        resources: {
            table: { status: 'ACTIVE', ...EXPECTED.table, decreasesToday: 0, ...overrides.table },
            GSI1:  { status: 'ACTIVE', ...EXPECTED.GSI1, decreasesToday: 0, ...overrides.GSI1 },
            GSI2:  { status: 'ACTIVE', ...EXPECTED.GSI2, decreasesToday: 0, ...overrides.GSI2 },
        },
    };
}

/** Counts fake operations still settling; starting another meanwhile means an await was skipped. */
const inFlight = { count: 0 };

/** Guards against overlap, then lets `turns` microtasks pass before the caller sees the effect. */
async function settle(turns: number): Promise<void> {
    if(inFlight.count > 0) {
        throw new Error('operation started before the previous one settled');
    }
    inFlight.count++;
    for(let turn = 0; turn < turns; turn++) {
        // eslint-disable-next-line no-await-in-loop -- sequential: each turn is one microtask
        await Promise.resolve();
    }
    inFlight.count--;
}

/** A table that goes UPDATING on each update and back to ACTIVE after `pollsToActive` describes. */
class FakeAdmin implements CapacityAdmin {
    readonly calls:    string[] = [];
    readonly failures: unknown[] = [];
    pollsToActive = 1;
    private pending = 0;

    constructor(public state: CapacityState = provisioned()) {}

    async describe(): Promise<CapacityState> {
        await settle(1);
        this.calls.push('describe');
        const state = structuredClone(this.state);
        if(this.pending > 0) {
            this.pending--;
            state.resources.table.status = 'UPDATING';
        }
        return state;
    }

    async update(resource: Resource, rcu: number, wcu: number): Promise<void> {
        await settle(2);
        this.calls.push(`update ${resource} ${rcu}/${wcu}`);
        if(this.failures.length > 0) {
            throw this.failures.shift();
        }
        this.state.resources[resource] = { ...this.state.resources[resource], rcu, wcu };
        this.pending = this.pollsToActive;
    }
}

class FakeFile implements RestoreFile {
    readonly path = 'reports/tag-index-repair-capacity.json';
    readonly calls: string[] = [];

    constructor(public saved: CapacityState | undefined = undefined) {}

    async read(): Promise<CapacityState | undefined> {
        await settle(1);
        this.calls.push('read');
        return structuredClone(this.saved);
    }

    async write(state: CapacityState): Promise<void> {
        await settle(1);
        this.calls.push('write');
        this.saved = structuredClone(state);
    }

    async delete(): Promise<void> {
        await settle(1);
        this.calls.push('delete');
        this.saved = undefined;
    }
}

function deps(): CapacityDeps & { logs: string[], sleeps: number[], clock: { now: number } } {
    const clock = { now: 0 };
    const logs: string[] = [];
    const sleeps: number[] = [];
    return {
        clock,
        logs,
        sleeps,
        now:   () => clock.now,
        log:   (text) => { logs.push(text); },
        sleep: async (ms) => {
            sleeps.push(ms);
            await settle(3);
            clock.now += ms;
        },
    };
}

function limitExceeded(): Error {
    return Object.assign(new Error('Subscriber limit exceeded'), { name: 'LimitExceededException' });
}

describe('repair-tag-index capacity rates', () => {
    test('default rates are free-tier safe and within the unboosted caps', () => {
        expect(DEFAULT_RATES).toStrictEqual({ baseRcu: 1, baseWcu: 0.5, gsi1Rcu: 1, gsi2Rcu: 0.5, gsi2Wcu: 0.5 });
        expect(UNBOOSTED_CAPS).toStrictEqual({ baseRcu: 2.5, baseWcu: 1, gsi1Rcu: 1, gsi2Rcu: 0.5, gsi2Wcu: 0.5 });
    });

    test('restore window is exactly 75 minutes', () => {
        expect(RESTORE_WINDOW_MS).toBe(4_500_000);
    });

    test('boostedRates leave the original capacity as headroom', () => {
        expect(boostedRates(6)).toStrictEqual({ baseRcu: 1, baseWcu: 4, gsi1Rcu: 4, gsi2Rcu: 0.5, gsi2Wcu: 5 });
        expect(boostedRates(50)).toStrictEqual({ baseRcu: 45, baseWcu: 48, gsi1Rcu: 48, gsi2Rcu: 0.5, gsi2Wcu: 49 });
    });

    test('boostTargets raise base RCU and WCU, GSI1 RCU and GSI2 WCU only', () => {
        expect(boostTargets(50)).toStrictEqual({ table: { rcu: 50, wcu: 50 }, GSI1: { rcu: 50, wcu: 2 }, GSI2: { rcu: 1, wcu: 50 } });
    });

    test('parseBoost accepts integers from 6 to 50', () => {
        expect(parseBoost('6')).toBe(6);
        expect(parseBoost('50')).toBe(50);
    });

    test('parseBoost rejects values outside 6 to 50 and non-integers', () => {
        expect(() => parseBoost('5')).toThrow('--boost must be an integer from 6 to 50, got 5');
        expect(() => parseBoost('51')).toThrow('--boost must be an integer from 6 to 50, got 51');
        expect(() => parseBoost('6.5')).toThrow('--boost must be an integer from 6 to 50, got 6.5');
        expect(() => parseBoost('lots')).toThrow('--boost must be an integer from 6 to 50, got lots');
    });
});

describe('repair-tag-index capacity refusals', () => {
    test('validateBoost returns the described originals when everything is as provisioned', async () => {
        const admin = new FakeAdmin(provisioned({ GSI2: { decreasesToday: 3 } }));
        const file = new FakeFile();

        expect(await validateBoost(admin, file)).toStrictEqual(provisioned({ GSI2: { decreasesToday: 3 } }));
        expect(file.calls).toStrictEqual(['read']);
        expect(admin.calls).toStrictEqual(['describe']);
    });

    test('validateBoost refuses when a restore file exists, before describing', async () => {
        const admin = new FakeAdmin();
        const file = new FakeFile(provisioned());

        await expect(validateBoost(admin, file)).rejects.toThrow('Restore file reports/tag-index-repair-capacity.json exists from an earlier run; run sst shell -- bun tools/repair-tag-index.ts --restore-capacity first');
        expect(admin.calls).toStrictEqual([]);
        expect(file.calls).toStrictEqual(['read']);
    });

    test('validateBoost refuses a table that is not ACTIVE', async () => {
        const admin = new FakeAdmin(provisioned({ table: { status: 'UPDATING' } }));
        await expect(validateBoost(admin, new FakeFile())).rejects.toThrow('Refusing to boost: table UPDATING, GSI1 ACTIVE, GSI2 ACTIVE; everything must be ACTIVE');
    });

    test('validateBoost refuses a GSI that is not ACTIVE', async () => {
        const admin = new FakeAdmin(provisioned({ GSI2: { status: 'CREATING' } }));
        await expect(validateBoost(admin, new FakeFile())).rejects.toThrow('Refusing to boost: table ACTIVE, GSI1 ACTIVE, GSI2 CREATING; everything must be ACTIVE');
    });

    test('validateBoost refuses on-demand billing', async () => {
        const state = { ...provisioned(), billing: 'PAY_PER_REQUEST' };
        await expect(validateBoost(new FakeAdmin(state), new FakeFile())).rejects.toThrow('Refusing to boost: the table uses on-demand billing');
    });

    test('validateBoost refuses capacity that differs from the provisioned values', async () => {
        await expect(validateBoost(new FakeAdmin(provisioned({ table: { rcu: 6 } })), new FakeFile())).rejects.toThrow('Refusing to boost: table has RCU 6, WCU 2, expected RCU 5, WCU 2');
        await expect(validateBoost(new FakeAdmin(provisioned({ GSI2: { wcu: 3 } })), new FakeFile())).rejects.toThrow('Refusing to boost: GSI2 has RCU 1, WCU 3, expected RCU 1, WCU 1');
    });

    test('validateBoost refuses when a resource already used four decreases today', async () => {
        const admin = new FakeAdmin(provisioned({ GSI1: { decreasesToday: 4 } }));
        await expect(validateBoost(admin, new FakeFile())).rejects.toThrow('Refusing to boost: GSI1 already used 4 capacity decreases today, so a same-day restore is not guaranteed');
    });
});

describe('repair-tag-index capacity boost', () => {
    test('saveOriginal creates the restore file with the originals and logs it', async () => {
        const file = new FakeFile();
        const d = deps();

        await saveOriginal(file, provisioned(), d);

        expect(file.calls).toStrictEqual(['write']);
        expect(file.saved).toStrictEqual(provisioned());
        expect(d.logs).toStrictEqual(['Saved original capacity to reports/tag-index-repair-capacity.json']);
    });

    test('saveOriginal rethrows a refused exclusive create without logging a save', async () => {
        const file = new FakeFile();
        const d = deps();
        file.write = async () => {
            throw new Error('EEXIST: file already exists');
        };

        await expect(saveOriginal(file, provisioned(), d)).rejects.toThrow('EEXIST: file already exists');
        expect(d.logs).toStrictEqual([]);
    });

    test('applyBoost updates one resource at a time waiting for ACTIVE', async () => {
        const admin = new FakeAdmin();
        const d = deps();

        await applyBoost(admin, provisioned(), 50, d);

        expect(admin.calls).toStrictEqual([
            'update table 50/50', 'describe', 'describe',
            'update GSI1 50/2', 'describe', 'describe',
            'update GSI2 1/50', 'describe', 'describe',
            'describe',
        ]);
        expect(d.sleeps).toStrictEqual([5000, 5000, 5000]);
        expect(d.logs).toStrictEqual([
            'Boosted table: RCU 5, WCU 2 -> RCU 50, WCU 50',
            'Boosted GSI1: RCU 2, WCU 2 -> RCU 50, WCU 2',
            'Boosted GSI2: RCU 1, WCU 1 -> RCU 1, WCU 50',
        ]);
    });

    test('applyBoost fails when DescribeTable does not show the boosted capacity', async () => {
        const admin = new FakeAdmin();
        const update = admin.update.bind(admin);
        admin.update = async (resource, rcu, wcu) => {
            await update(resource, resource === 'table' ? rcu : rcu - 1, wcu);
        };

        await expect(applyBoost(admin, provisioned(), 50, deps())).rejects.toThrow('Boost verification failed for GSI1, GSI2');
    });

    test('applyBoost fails verification when exactly one resource differs', async () => {
        const admin = new FakeAdmin();
        const update = admin.update.bind(admin);
        admin.update = async (resource, rcu, wcu) => {
            await update(resource, resource === 'GSI1' ? rcu - 1 : rcu, wcu);
        };

        await expect(applyBoost(admin, provisioned(), 50, deps())).rejects.toThrow('Boost verification failed for GSI1');
    });

    test('waitActive times out after 15 minutes of polling', async () => {
        const admin = new FakeAdmin(provisioned({ GSI1: { status: 'UPDATING' } }));
        const d = deps();

        await expect(waitActive(admin, d)).rejects.toThrow('Timed out after 15 min waiting for IsambardMemory to become ACTIVE');
        expect(d.sleeps).toHaveLength(ACTIVE_TIMEOUT_MS / 5000);
    });
});

describe('repair-tag-index capacity restore', () => {
    function boosted(): FakeAdmin {
        const admin = new FakeAdmin(provisioned());
        for(const [resource, target] of Object.entries(boostTargets(50))) {
            admin.state.resources[resource as Resource] = { ...admin.state.resources[resource as Resource], ...target };
        }
        return admin;
    }

    test('restoreCapacity restores every resource, verifies and deletes the file', async () => {
        const admin = boosted();
        const file = new FakeFile(provisioned());
        const d = deps();

        await restoreCapacity(admin, file, d);

        expect(admin.state).toStrictEqual(provisioned());
        expect(file.calls).toStrictEqual(['read', 'delete']);
        expect(admin.calls.filter(call => call.startsWith('update'))).toStrictEqual(['update table 5/2', 'update GSI1 2/2', 'update GSI2 1/1']);
        expect(admin.calls.at(-1)).toBe('describe');
        expect(d.logs).toStrictEqual([
            'Restoring table: RCU 50, WCU 50 -> RCU 5, WCU 2',
            'Restoring GSI1: RCU 50, WCU 2 -> RCU 2, WCU 2',
            'Restoring GSI2: RCU 1, WCU 50 -> RCU 1, WCU 1',
            'Restored table: RCU 5, WCU 2',
            'Restored GSI1: RCU 2, WCU 2',
            'Restored GSI2: RCU 1, WCU 1',
            'Capacity verified; deleted reports/tag-index-repair-capacity.json',
        ]);
    });

    test('restoreCapacity updates only the resources that differ', async () => {
        const admin = new FakeAdmin(provisioned({ GSI1: { rcu: 50 } }));

        await restoreCapacity(admin, new FakeFile(provisioned()), deps());

        expect(admin.calls.filter(call => call.startsWith('update'))).toStrictEqual(['update GSI1 2/2']);
    });

    test('restoreCapacity retries LimitExceededException with a doubling backoff then succeeds', async () => {
        const admin = boosted();
        admin.failures.push(limitExceeded(), Object.assign(new Error('busy'), { name: 'ResourceInUseException' }));
        const file = new FakeFile(provisioned());
        const d = deps();

        await restoreCapacity(admin, file, d);

        expect(d.sleeps).toStrictEqual([30_000, 60_000, 5000, 5000, 5000]);
        expect(d.logs.slice(0, 2)).toStrictEqual([
            'Restoring table hit LimitExceededException; retrying in 30s (restoring capacity, please wait)',
            'Restoring table hit ResourceInUseException; retrying in 60s (restoring capacity, please wait)',
        ]);
        expect(admin.state).toStrictEqual(provisioned());
        expect(file.saved).toBeUndefined();
    });

    test('restoreCapacity gives up after 75 minutes, keeps the file and prints the manual commands', async () => {
        const admin = boosted();
        admin.pollsToActive = 30;
        const update = admin.update.bind(admin);
        admin.update = async (resource, rcu, wcu) => {
            if(resource === 'GSI1') {
                admin.calls.push('update GSI1 refused');
                throw limitExceeded();
            }
            await update(resource, rcu, wcu);
        };
        const file = new FakeFile(provisioned());
        const d = deps();

        await expect(restoreCapacity(admin, file, d)).rejects.toThrow('Capacity restore failed: Subscriber limit exceeded');

        expect(d.sleeps).toStrictEqual([...Array.from({ length: 30 }, () => 5000), 30_000, 60_000, 120_000, 240_000, ...Array.from({ length: 13 }, () => 300_000)]);
        expect(d.clock.now).toBe(75 * 60_000);
        expect(file.saved).toStrictEqual(provisioned());
        expect(file.calls).toStrictEqual(['read']);
        expect(d.logs.slice(-6)).toStrictEqual([
            '!!! CAPACITY RESTORE FAILED: Subscriber limit exceeded',
            '!!! The restore file reports/tag-index-repair-capacity.json is kept. Rerun: sst shell -- bun tools/repair-tag-index.ts --restore-capacity',
            '!!! Or restore by hand:',
            ...restoreCommands(provisioned()),
        ]);
    });

    test('restoreCapacity fails at once on an error that is not retryable', async () => {
        const admin = boosted();
        admin.failures.push('access denied');
        const file = new FakeFile(provisioned());
        const d = deps();
        let caught: unknown;

        try {
            await restoreCapacity(admin, file, d);
        } catch (error) {
            caught = error;
        }

        expect(caught).toMatchObject({ message: 'Capacity restore failed: access denied', cause: 'access denied' });
        expect(d.sleeps).toStrictEqual([]);
        expect(file.saved).toStrictEqual(provisioned());
    });

    test('restoreCapacity fails verification and keeps the file when capacity did not change', async () => {
        const admin = boosted();
        admin.update = async () => undefined;
        const file = new FakeFile(provisioned());

        await expect(restoreCapacity(admin, file, deps())).rejects.toThrow('Capacity restore failed: verification found table at RCU 50, WCU 50, GSI1 at RCU 50, WCU 2, GSI2 at RCU 1, WCU 50');
        expect(file.saved).toStrictEqual(provisioned());
    });

    test('restoreCapacity fails verification when exactly one resource differs', async () => {
        const admin = boosted();
        const update = admin.update.bind(admin);
        admin.update = async (resource, rcu, wcu) => {
            if(resource !== 'GSI1') {
                await update(resource, rcu, wcu);
            }
        };

        await expect(restoreCapacity(admin, new FakeFile(provisioned()), deps())).rejects.toThrow('Capacity restore failed: verification found GSI1 at RCU 50, WCU 2');
    });

    test('restoreCapacity refuses a restore file for another table', async () => {
        const admin = boosted();
        const file = new FakeFile({ ...provisioned(), tableName: 'OtherTable' });

        await expect(restoreCapacity(admin, file, deps())).rejects.toThrow('Capacity restore failed: restore file is for OtherTable, but this stage\'s table is IsambardMemory');
        expect(admin.calls.filter(call => call.startsWith('update'))).toStrictEqual([]);
    });

    test('restoreCapacity fails when there is no restore file', async () => {
        const admin = new FakeAdmin();

        await expect(restoreCapacity(admin, new FakeFile(), deps())).rejects.toThrow('No restore file at reports/tag-index-repair-capacity.json; nothing to restore');
        expect(admin.calls).toStrictEqual([]);
    });

    test('restoreCommands prints the table and GSI update-table commands', () => {
        expect(restoreCommands(provisioned())).toStrictEqual([
            'aws dynamodb update-table --table-name IsambardMemory --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=2',
            'aws dynamodb update-table --table-name IsambardMemory --global-secondary-index-updates \'[{"Update":{"IndexName":"GSI1","ProvisionedThroughput":{"ReadCapacityUnits":2,"WriteCapacityUnits":2}}}]\'',
            'aws dynamodb update-table --table-name IsambardMemory --global-secondary-index-updates \'[{"Update":{"IndexName":"GSI2","ProvisionedThroughput":{"ReadCapacityUnits":1,"WriteCapacityUnits":1}}}]\'',
        ]);
    });
});

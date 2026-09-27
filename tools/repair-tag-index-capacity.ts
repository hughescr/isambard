/**
 * Opt-in temporary capacity boost for the one-off tag-index repair (tools/repair-tag-index.ts):
 * refuse unless the table is exactly as provisioned, save the originals to a restore file
 * before any change, boost, and always restore and verify. Every AWS call goes through the
 * {@link CapacityAdmin} port and every file access through {@link RestoreFile}.
 */
import type { Rates } from './repair-tag-index-core';

export const RESOURCES = ['table', 'GSI1', 'GSI2'] as const;
export type Resource = typeof RESOURCES[number];

export interface Capacity {
    rcu: number
    wcu: number
}

export interface Throughput extends Capacity {
    status:          string
    /** DynamoDB's NumberOfDecreasesToday. */
    decreasesToday:  number
    lastDecreaseAt?: string
}

export interface CapacityState {
    tableName: string
    billing:   string
    resources: Record<Resource, Throughput>
}

export interface CapacityAdmin {
    describe(): Promise<CapacityState>
    /** One UpdateTable for one resource, setting both its RCU and WCU. */
    update(resource: Resource, rcu: number, wcu: number): Promise<void>
}

export interface RestoreFile {
    readonly path: string
    read(): Promise<CapacityState | undefined>
    /** Creates the file; fails if it already exists. */
    write(state: CapacityState): Promise<void>
    delete(): Promise<void>
}

export interface CapacityDeps {
    sleep: (ms: number) => Promise<void>
    now:   () => number
    log:   (text: string) => void
}

/** Provisioned capacity per sst/dynamo.ts:28-46; the boost refuses to touch anything else. */
export const EXPECTED: Record<Resource, Capacity> = { table: { rcu: 5, wcu: 2 }, GSI1: { rcu: 2, wcu: 2 }, GSI2: { rcu: 1, wcu: 1 } };
export const MAX_BOOST = 50;
/** One above the largest boosted original (base RCU 5), so every boosted resource goes up. */
export const MIN_BOOST = 6;
/** DynamoDB allows 4 decreases per table or GSI at any time in a UTC day. */
export const MAX_DECREASES_TODAY = 4;
export const POLL_MS = 5000;
export const ACTIVE_TIMEOUT_MS = 15 * 60_000;
export const RESTORE_WINDOW_MS = 75 * 60_000;
export const RESTORE_FIRST_BACKOFF_MS = 30_000;
export const RESTORE_MAX_BACKOFF_MS = 5 * 60_000;
const RETRYABLE = new Set(['LimitExceededException', 'ResourceInUseException']);
export const RESTORE_COMMAND = 'sst shell -- bun tools/repair-tag-index.ts --restore-capacity';

/** Free-tier-safe default rates. */
export const DEFAULT_RATES: Rates = { baseRcu: 1, baseWcu: 0.5, gsi1Rcu: 1, gsi2Rcu: 0.5, gsi2Wcu: 0.5 };

/** Without --boost every rate is capped at half of its provisioned capacity, leaving the rest to Izzy. */
export const UNBOOSTED_CAPS: Rates = {
    baseRcu: EXPECTED.table.rcu / 2,
    baseWcu: EXPECTED.table.wcu / 2,
    gsi1Rcu: EXPECTED.GSI1.rcu / 2,
    gsi2Rcu: EXPECTED.GSI2.rcu / 2,
    gsi2Wcu: EXPECTED.GSI2.wcu / 2,
};

/** Base RCU and WCU, GSI1 RCU and GSI2 WCU go to `n`; GSI1 WCU and GSI2 RCU keep their originals. */
export function boostTargets(n: number): Record<Resource, Capacity> {
    return { table: { rcu: n, wcu: n }, GSI1: { rcu: n, wcu: EXPECTED.GSI1.wcu }, GSI2: { rcu: EXPECTED.GSI2.rcu, wcu: n } };
}

/** Boosted rates leave each resource's original capacity as headroom for Izzy. */
export function boostedRates(n: number): Rates {
    return {
        baseRcu: n - EXPECTED.table.rcu,
        baseWcu: n - EXPECTED.table.wcu,
        gsi1Rcu: n - EXPECTED.GSI1.rcu,
        gsi2Rcu: UNBOOSTED_CAPS.gsi2Rcu,
        gsi2Wcu: n - EXPECTED.GSI2.wcu,
    };
}

/** Parses --boost: an integer from {@link MIN_BOOST} to {@link MAX_BOOST}. */
export function parseBoost(raw: string): number {
    const n = Number(raw);
    if(!Number.isInteger(n) || n < MIN_BOOST || n > MAX_BOOST) {
        throw new Error(`--boost must be an integer from ${MIN_BOOST} to ${MAX_BOOST}, got ${raw}`);
    }
    return n;
}

function describeCapacity(capacity: Capacity): string {
    return `RCU ${capacity.rcu}, WCU ${capacity.wcu}`;
}

function sameCapacity(a: Capacity, b: Capacity): boolean {
    return a.rcu === b.rcu && a.wcu === b.wcu;
}

function allActive(state: CapacityState): boolean {
    return RESOURCES.every(resource => state.resources[resource].status === 'ACTIVE');
}

/**
 * Every refusal, checked before the restore file is written or any update is sent. Returns the
 * described state, whose capacities are the originals to save.
 */
export async function validateBoost(admin: CapacityAdmin, file: RestoreFile): Promise<CapacityState> {
    if(await file.read() !== undefined) {
        throw new Error(`Restore file ${file.path} exists from an earlier run; run ${RESTORE_COMMAND} first`);
    }
    const state = await admin.describe();
    if(!allActive(state)) {
        const statuses = RESOURCES.map(resource => `${resource} ${state.resources[resource].status}`).join(', ');
        throw new Error(`Refusing to boost: ${statuses}; everything must be ACTIVE`);
    }
    if(state.billing === 'PAY_PER_REQUEST') {
        throw new Error('Refusing to boost: the table uses on-demand billing');
    }
    for(const resource of RESOURCES) {
        const actual = state.resources[resource];
        if(!sameCapacity(actual, EXPECTED[resource])) {
            throw new Error(`Refusing to boost: ${resource} has ${describeCapacity(actual)}, expected ${describeCapacity(EXPECTED[resource])}`);
        }
        if(actual.decreasesToday >= MAX_DECREASES_TODAY) {
            throw new Error(`Refusing to boost: ${resource} already used ${actual.decreasesToday} capacity decreases today, so a same-day restore is not guaranteed`);
        }
    }
    return state;
}

/** Polls DescribeTable until the table and every GSI are ACTIVE. */
export async function waitActive(admin: CapacityAdmin, deps: CapacityDeps): Promise<CapacityState> {
    const deadline = deps.now() + ACTIVE_TIMEOUT_MS;
    for(;;) {
        // eslint-disable-next-line no-await-in-loop -- sequential: polling
        const state = await admin.describe();
        if(allActive(state)) {
            return state;
        }
        if(deps.now() >= deadline) {
            throw new Error(`Timed out after ${ACTIVE_TIMEOUT_MS / 60_000} min waiting for ${state.tableName} to become ACTIVE`);
        }
        // eslint-disable-next-line no-await-in-loop -- sequential: polling interval
        await deps.sleep(POLL_MS);
    }
}

/**
 * Creates the restore file holding `original`. Creation is exclusive, so a concurrent run that
 * loses the race fails here, owns no boost and must neither boost nor restore.
 */
export async function saveOriginal(file: RestoreFile, original: CapacityState, deps: CapacityDeps): Promise<void> {
    await file.write(original);
    deps.log(`Saved original capacity to ${file.path}`);
}

/**
 * Raises one resource at a time to its target, waiting for ACTIVE after each, and verifies the
 * result with DescribeTable. Call it only after {@link saveOriginal} succeeded.
 */
export async function applyBoost(admin: CapacityAdmin, original: CapacityState, n: number, deps: CapacityDeps): Promise<void> {
    const targets = boostTargets(n);
    for(const resource of RESOURCES) {
        // eslint-disable-next-line no-await-in-loop -- sequential: one UpdateTable at a time
        await admin.update(resource, targets[resource].rcu, targets[resource].wcu);
        // eslint-disable-next-line no-await-in-loop -- sequential: DynamoDB allows one update in flight
        await waitActive(admin, deps);
        deps.log(`Boosted ${resource}: ${describeCapacity(original.resources[resource])} -> ${describeCapacity(targets[resource])}`);
    }
    const state = await admin.describe();
    const wrong = RESOURCES.filter(resource => !sameCapacity(state.resources[resource], targets[resource]));
    if(wrong.length > 0) {
        throw new Error(`Boost verification failed for ${wrong.join(', ')}`);
    }
}

/** The equivalent manual restore commands. */
export function restoreCommands(saved: CapacityState): string[] {
    return RESOURCES.map((resource) => {
        const { rcu, wcu } = saved.resources[resource];
        if(resource === 'table') {
            return `aws dynamodb update-table --table-name ${saved.tableName} --provisioned-throughput ReadCapacityUnits=${rcu},WriteCapacityUnits=${wcu}`;
        }
        const update = JSON.stringify([{ Update: { IndexName: resource, ProvisionedThroughput: { ReadCapacityUnits: rcu, WriteCapacityUnits: wcu } } }]);
        return `aws dynamodb update-table --table-name ${saved.tableName} --global-secondary-index-updates '${update}'`;
    });
}

function errorName(error: unknown): string {
    return (new Object(error) as { name?: string }).name ?? '';
}

/** Restores one resource, retrying the decrease limit and in-flight updates until `deadline`. */
async function restoreResource(admin: CapacityAdmin, saved: CapacityState, resource: Resource, deadline: number, deps: CapacityDeps): Promise<void> {
    const target = saved.resources[resource];
    let delay = RESTORE_FIRST_BACKOFF_MS;
    for(;;) {
        // eslint-disable-next-line no-await-in-loop -- sequential: DynamoDB allows one update in flight
        const state = await waitActive(admin, deps);
        const current = state.resources[resource];
        if(sameCapacity(current, target)) {
            return;
        }
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: one UpdateTable at a time
            await admin.update(resource, target.rcu, target.wcu);
            deps.log(`Restoring ${resource}: ${describeCapacity(current)} -> ${describeCapacity(target)}`);
            return;
        } catch (error) {
            if(!RETRYABLE.has(errorName(error)) || deps.now() + delay > deadline) {
                throw error;
            }
            deps.log(`Restoring ${resource} hit ${errorName(error)}; retrying in ${delay / 1000}s (restoring capacity, please wait)`);
            // eslint-disable-next-line no-await-in-loop -- sequential: backoff between restore attempts
            await deps.sleep(delay);
            delay = Math.min(delay * 2, RESTORE_MAX_BACKOFF_MS);
        }
    }
}

/**
 * Restores every resource to the capacity saved in the restore file, verifies it with
 * DescribeTable and only then deletes the file. On failure the file is kept, the manual commands
 * are printed and the returned promise rejects.
 */
export async function restoreCapacity(admin: CapacityAdmin, file: RestoreFile, deps: CapacityDeps): Promise<void> {
    const saved = await file.read();
    if(saved === undefined) {
        throw new Error(`No restore file at ${file.path}; nothing to restore`);
    }
    const deadline = deps.now() + RESTORE_WINDOW_MS;
    try {
        const state = await waitActive(admin, deps);
        if(state.tableName !== saved.tableName) {
            throw new Error(`restore file is for ${saved.tableName}, but this stage's table is ${state.tableName}`);
        }
        for(const resource of RESOURCES) {
            // eslint-disable-next-line no-await-in-loop -- sequential: one UpdateTable at a time
            await restoreResource(admin, saved, resource, deadline, deps);
        }
        const restored = await waitActive(admin, deps);
        const wrong = RESOURCES.filter(resource => !sameCapacity(restored.resources[resource], saved.resources[resource]));
        if(wrong.length > 0) {
            const found = wrong.map(resource => `${resource} at ${describeCapacity(restored.resources[resource])}`).join(', ');
            throw new Error(`verification found ${found}`);
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        deps.log(`!!! CAPACITY RESTORE FAILED: ${reason}`);
        deps.log(`!!! The restore file ${file.path} is kept. Rerun: ${RESTORE_COMMAND}`);
        deps.log('!!! Or restore by hand:');
        for(const command of restoreCommands(saved)) {
            deps.log(command);
        }
        throw new Error(`Capacity restore failed: ${reason}`, { cause: error });
    }
    await file.delete();
    for(const resource of RESOURCES) {
        deps.log(`Restored ${resource}: ${describeCapacity(saved.resources[resource])}`);
    }
    deps.log(`Capacity verified; deleted ${file.path}`);
}

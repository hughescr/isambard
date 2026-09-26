import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import {
    DynamoDBDocumentClient,
    PutCommand,
    GetCommand,
    QueryCommand,
    UpdateCommand,
    type PutCommandInput,
    type GetCommandInput,
    type QueryCommandInput,
    type UpdateCommandInput
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { ApprovedOutboundActionBackend } from '@/services/approved-outbound-action/backend';
import { createApprovedOutboundActionExecutor, type ApprovedOutboundActionExecutorLogger } from '@/services/approved-outbound-action/executor';
import { createApprovedActionOutcomeReporter } from '@/services/approved-outbound-action/outcome-reporter';
import type { ApprovedOutboundAction, ApprovedOutboundActionType, UnverifiedApprovedOutboundAction } from '@/services/approved-outbound-action/types';
import type { ServiceHealthRegistry } from '@/services/health-registry';
import { createPrefixedKey } from '@/storage';

/**
 * Drives the real {@link ApprovedOutboundActionBackend} — not a hand-rolled re-implementation of
 * its guards — against an in-memory DynamoDB fake that evaluates whatever ConditionExpression,
 * FilterExpression and UpdateExpression strings the backend actually sends. If a future change
 * dropped the `#state = :from AND #claimId = :claimId` guard from `settleClaim`'s put, the string
 * this fake receives would change and it would honour the weaker (or missing) condition, so the
 * marker-survival assertions below would fail — the guard is exercised, not assumed.
 *
 * Only equality (`name = value`) and `IN (...)` clauses joined by `AND` are supported: every
 * condition/filter/key expression the backend actually builds (see backend.ts) is one of those.
 */

const ACTION_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const TABLE_NAME = 'TestTable';
/** Every write in this test is stamped with this one frozen instant. */
const FROZEN_AT = '2026-09-24T10:00:00.000Z';

const CONDITIONAL_CHECK_FAILED = Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

function itemKey(item: { PK: unknown, SK: unknown }): string {
    return `${String(item.PK)}#${String(item.SK)}`;
}

/** Mirrors backend.ts's private `ACTION_PK`/`actionSK` — needed to write raw rows straight into
 *  the fake below, bypassing the backend, for the two guard-isolation tests. */
function actionKey(id: string): { PK: string, SK: string } {
    return { PK: 'APPROVAL#SAGA', SK: createPrefixedKey('SAGA', id) };
}

function resolveName(token: string, names: Record<string, string> | undefined): string {
    return names?.[token] ?? token;
}

/** Evaluates an `AND`-joined DynamoDB condition/filter/key expression against one item. */
function evaluateExpression(
    expression: string,
    names: Record<string, string> | undefined,
    values: Record<string, unknown> | undefined,
    item: Record<string, unknown> | undefined
): boolean {
    return expression.split(' AND ').every((rawClause) => {
        const clause = rawClause.trim();
        const inClause = /^(\S+) IN \(([^)]+)\)$/.exec(clause);
        if(inClause) {
            const [, nameToken, valuesList] = inClause;
            const attrName = resolveName(nameToken, names);
            const candidates = valuesList.split(',').map(token => values?.[token.trim()]);
            return candidates.includes(item?.[attrName]);
        }
        const eqClause = /^(\S+) = (\S+)$/.exec(clause);
        if(eqClause) {
            const [, nameToken, valueToken] = eqClause;
            const attrName = resolveName(nameToken, names);
            return item?.[attrName] === values?.[valueToken];
        }
        throw new Error(`executor-outcome-reporter-race fake: unsupported expression clause "${clause}"`);
    });
}

/** Applies a DynamoDB `SET`/`REMOVE` UpdateExpression to a copy of `item`. */
function applyUpdate(
    expression: string,
    names: Record<string, string> | undefined,
    values: Record<string, unknown> | undefined,
    item: Record<string, unknown>
): Record<string, unknown> {
    const next = { ...item };
    const setClause = /^SET (.+)$/.exec(expression);
    if(setClause) {
        for(const assignment of setClause[1].split(',')) {
            const [nameToken, valueToken] = assignment.split('=').map(part => part.trim());
            next[resolveName(nameToken, names)] = values?.[valueToken];
        }
        return next;
    }
    const removeClause = /^REMOVE (.+)$/.exec(expression);
    if(removeClause) {
        for(const nameToken of removeClause[1].split(',').map(part => part.trim())) {
            delete next[resolveName(nameToken, names)];
        }
        return next;
    }
    throw new Error(`executor-outcome-reporter-race fake: unsupported update expression "${expression}"`);
}

/**
 * An in-memory DynamoDB document client whose Put/Update/Query handlers evaluate the real
 * ConditionExpression/FilterExpression/UpdateExpression strings sent to them, and whose
 * `armSettleFault` reproduces "the write landed but the caller's response was lost" by writing
 * through and then throwing, exactly once, on the next put whose condition mentions `#claimId`
 * (the settle put — see backend.ts's `settleClaim`).
 */
function createConditionEvaluatingDynamoFake() {
    const rows = new Map<string, Record<string, unknown>>();
    let settleFault: { error: Error, applied: boolean } | undefined;

    const ddbMock = mockClient(DynamoDBDocumentClient);

    ddbMock.on(PutCommand).callsFake((input: PutCommandInput) => {
        const item = input.Item as Record<string, unknown>;
        const key = itemKey(item as { PK: unknown, SK: unknown });
        const existing = rows.get(key);
        if(input.ConditionExpression !== undefined && !evaluateExpression(input.ConditionExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues, existing)) {
            throw CONDITIONAL_CHECK_FAILED;
        }
        // A settle put is the only write that sets outcomeReportPending — identifying it this way
        // (rather than by inspecting ConditionExpression) means the fault still fires on the
        // settle put even if a future change weakens or drops that condition's guard clauses.
        const isSettlePut = item.outcomeReportPending === true;
        if(isSettlePut && settleFault !== undefined) {
            const fault = settleFault;
            settleFault = undefined;
            if(fault.applied) {
                rows.set(key, item);
            }
            throw fault.error;
        }
        rows.set(key, item);
        return {};
    });

    ddbMock.on(GetCommand).callsFake((input: GetCommandInput) => {
        return { Item: rows.get(itemKey(input.Key as { PK: unknown, SK: unknown })) };
    });

    ddbMock.on(UpdateCommand).callsFake((input: UpdateCommandInput) => {
        const key = itemKey(input.Key as { PK: unknown, SK: unknown });
        const existing = rows.get(key);
        if(input.ConditionExpression !== undefined && !evaluateExpression(input.ConditionExpression, input.ExpressionAttributeNames, input.ExpressionAttributeValues, existing)) {
            throw CONDITIONAL_CHECK_FAILED;
        }
        rows.set(key, applyUpdate(input.UpdateExpression ?? '', input.ExpressionAttributeNames, input.ExpressionAttributeValues, existing ?? {}));
        return {};
    });

    ddbMock.on(QueryCommand).callsFake((input: QueryCommandInput) => {
        const items = [...rows.values()].filter(item => evaluateExpression(
            input.KeyConditionExpression ?? '',
            input.ExpressionAttributeNames,
            input.ExpressionAttributeValues,
            item
        ));
        const filtered = input.FilterExpression === undefined
            ? items
            : items.filter(item => evaluateExpression(input.FilterExpression!, input.ExpressionAttributeNames, input.ExpressionAttributeValues, item));
        return { Items: filtered };
    });

    return {
        docClient: ddbMock as unknown as DynamoDBDocumentClient,
        restore:   () => { ddbMock.restore(); },
        armSettleFault(fault: { error: Error, applied: boolean }): void {
            settleFault = fault;
        },
    };
}

function makeLogger(): ApprovedOutboundActionExecutorLogger {
    return {
        debug: mock((): void => undefined),
        warn:  mock((): void => undefined),
        error: mock((): void => undefined),
        info:  mock((): void => undefined),
    };
}

function makeExecutors(): Record<ApprovedOutboundActionType, ReturnType<typeof mock<(params: Record<string, unknown>) => Promise<void>>>> {
    return {
        bsky_reply: mock(async (_params: Record<string, unknown>): Promise<void> => undefined),
        bsky_dm:    mock(async (_params: Record<string, unknown>): Promise<void> => undefined),
        email_send: mock(async (_params: Record<string, unknown>): Promise<void> => undefined),
    };
}

async function flush(): Promise<void> {
    for(let turn = 0; turn < 50; turn++) {
        // eslint-disable-next-line no-await-in-loop -- each turn drains one microtask hop of the executor's promise chain.
        await Promise.resolve();
    }
}

describe('approved outbound action executor and outcome reporter, driven against the real backend', () => {
    let fake: ReturnType<typeof createConditionEvaluatingDynamoFake>;
    let backend: ApprovedOutboundActionBackend;
    let registry: ServiceHealthRegistry;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(FROZEN_AT));
        fake = createConditionEvaluatingDynamoFake();
        backend = new ApprovedOutboundActionBackend(fake.docClient, TABLE_NAME);
        registry = { isAvailable: mock((): boolean => true) } as unknown as ServiceHealthRegistry;
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        fake.restore();
    });

    test('a lost settle response, a reporter notification, and the executor\'s retry never double-count or clobber the outcome-notification marker', async () => {
        await backend.create({
            id:        ACTION_ID,
            state:     'approved',
            type:      'bsky_reply',
            params:    { text: 'hello' },
            createdAt: FROZEN_AT,
            updatedAt: FROZEN_AT,
        });

        const executors = makeExecutors();
        const activityLogger = { log: mock(async (): Promise<void> => undefined) };
        const onOutcomeRecorded = mock((): void => undefined);
        const executor = createApprovedOutboundActionExecutor({
            backend,
            registry,
            executors,
            verifiers: {
                bsky_reply: { check: async () => ({ verdict: 'delivered' }), contentKey: () => undefined },
                bsky_dm:    { check: async () => ({ verdict: 'delivered' }), contentKey: () => undefined },
                email_send: { check: async () => ({ verdict: 'delivered' }), contentKey: () => undefined },
            },
            activityLogger,
            onOutcomeRecorded,
            logger: makeLogger(),
            now:    () => Date.now(),
        });

        // Step 1: the executor's settle write lands, but its response is lost.
        fake.armSettleFault({ error: new Error('socket hang up'), applied: true });
        await expect(executor.executeOnce()).rejects.toThrow('socket hang up');

        const afterLostResponse = await backend.get(ACTION_ID);
        expect(afterLostResponse).toMatchObject({ state: 'executed', outcomeReportPending: true });
        expect(afterLostResponse?.outcomeNotified).toBeUndefined();
        expect(afterLostResponse?.claimId).toBeUndefined();
        expect(activityLogger.log).not.toHaveBeenCalled();
        expect(onOutcomeRecorded).not.toHaveBeenCalled();

        // Step 2: the outcome reporter's delivery notifies Izzy and persists the marker, frozen
        // mid-report (the card edit and `markOutcomeReported` have not happened yet).
        const notify = mock((): boolean => true);
        async function deliver(action: ApprovedOutboundAction): Promise<boolean> {
            const notified = action.outcomeNotified === true || notify();
            if(notified && action.outcomeNotified !== true && !await backend.markOutcomeNotified(action)) {
                return false;
            }
            return notified;
        }

        expect(await deliver(afterLostResponse!)).toBe(true);
        expect(notify).toHaveBeenCalledTimes(1);

        const afterNotified = await backend.get(ACTION_ID);
        expect(afterNotified).toMatchObject({ state: 'executed', outcomeReportPending: true, outcomeNotified: true });

        // Step 3: the executor retries the lost settle. The retry's guard (`state = sending AND
        // claimId = <the resolved claim>`) no longer matches the now-`executed` row, so it is a
        // no-op: no double result count, no second activity event, no clobbered marker.
        expect(await executor.executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 0 });

        const afterRetry = await backend.get(ACTION_ID);
        expect(afterRetry).toEqual(afterNotified);
        expect(activityLogger.log).not.toHaveBeenCalled();
        expect(onOutcomeRecorded).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(1);

        // Step 4: finish the report cycle for completeness — the marker survived, so the reporter
        // can now clear it durably.
        const reporter = createApprovedActionOutcomeReporter({ backend, deliver, logger: makeLogger() });
        expect(await reporter.reportOnce()).toEqual({ delivered: 1, pending: 0 });
        expect(notify).toHaveBeenCalledTimes(1);

        const afterReport = await backend.get(ACTION_ID);
        expect(afterReport?.outcomeNotified).toBeUndefined();
        expect(afterReport?.outcomeReportPending).toBeUndefined();
    });

    test('a destination-check resolution wins over a late timeout success without duplicate sent side effects', async () => {
        await backend.create({
            id:        ACTION_ID,
            state:     'approved',
            type:      'bsky_reply',
            params:    { text: 'hello' },
            createdAt: FROZEN_AT,
            updatedAt: FROZEN_AT,
        });
        const send = Promise.withResolvers<undefined>();
        const executors = makeExecutors();
        executors.bsky_reply.mockImplementation(async () => send.promise);
        const logger = makeLogger();
        const activityLogger = { log: mock(async (): Promise<void> => undefined) };
        const onOutcomeRecorded = mock((): void => undefined);
        const executor = createApprovedOutboundActionExecutor({
            backend,
            registry,
            executors,
            verifiers: {
                bsky_reply: { check: async () => ({ verdict: 'delivered' }), contentKey: () => undefined },
                bsky_dm:    { check: async () => ({ verdict: 'delivered' }), contentKey: () => undefined },
                email_send: { check: async () => ({ verdict: 'delivered' }), contentKey: () => undefined },
            },
            activityLogger,
            onOutcomeRecorded,
            logger,
            sendTimeoutMs: 1000,
            claimLeaseMs:  1001,
        });
        const pass = executor.executeOnce();
        await flush();
        jest.advanceTimersByTime(1000);
        await pass;

        const unverified = await backend.get(ACTION_ID);
        expect(unverified).toMatchObject({ state: 'unverified', outcomeReportPending: true });
        const resolved = await backend.resolveUnverified(unverified! as UnverifiedApprovedOutboundAction, 'executed');
        expect(resolved).toMatchObject({ state: 'executed', outcomeReportPending: true });

        send.resolve(undefined);
        await flush();

        expect(await backend.get(ACTION_ID)).toEqual(resolved);
        expect(activityLogger.log).not.toHaveBeenCalled();
        expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            { actionId: ACTION_ID, outcome: { state: 'executed' } },
            'Approved outbound action late success not recorded: its unverified row was already resolved elsewhere'
        );
    });

    test('settleClaim\'s claimId guard alone rejects a stale claim once the row is reclaimed under a new claimId while still sending', async () => {
        await backend.create({
            id:        ACTION_ID,
            state:     'approved',
            type:      'bsky_reply',
            params:    { text: 'hello' },
            createdAt: FROZEN_AT,
            updatedAt: FROZEN_AT,
        });

        const approved = await backend.get(ACTION_ID);
        const staleClaim = await backend.claim(approved!);
        expect(staleClaim).toBeDefined();

        // A stale-claim sweep resets the row to `approved` without going through the backend (no
        // public `sending -> approved` reset path exists), so a second claim can take it under a
        // fresh claimId while the row is `sending` again — the shape settleClaim's claimId clause
        // (not its state clause, which still reads `sending`) must reject the first claim against.
        const raw = await fake.docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: actionKey(ACTION_ID), ConsistentRead: true }));
        const { claimId: _staleClaimId, ...withoutClaimId } = raw.Item as Record<string, unknown>;
        await fake.docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...withoutClaimId, state: 'approved' } }));

        const reclaimed = await backend.claim((await backend.get(ACTION_ID))!);
        expect(reclaimed).toBeDefined();
        expect(reclaimed!.claimId).not.toBe(staleClaim!.claimId);

        expect(await backend.settleClaim(staleClaim!, { state: 'executed' })).toBeUndefined();

        expect(await backend.get(ACTION_ID)).toMatchObject({ state: 'sending', claimId: reclaimed!.claimId });
    });

    test('settleClaim\'s state guard alone rejects a settle whose stale claimId matches a row that has moved off sending', async () => {
        await backend.create({
            id:        ACTION_ID,
            state:     'approved',
            type:      'bsky_reply',
            params:    { text: 'hello' },
            createdAt: FROZEN_AT,
            updatedAt: FROZEN_AT,
        });

        const approved = await backend.get(ACTION_ID);
        const claimed = await backend.claim(approved!);
        expect(claimed).toBeDefined();

        // Contrived: force the row back to `approved` while leaving the claim's id in place, so
        // only settleClaim's state clause (not its claimId clause, which still matches) can reject
        // a settle bearing that claimId. Production code never produces this row shape on its own
        // — claimId is stripped on every transition but `claim` — but the guard must not depend on
        // that invariant holding to do its job.
        const raw = await fake.docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: actionKey(ACTION_ID), ConsistentRead: true }));
        await fake.docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...raw.Item, state: 'approved' } }));

        expect(await backend.settleClaim(claimed!, { state: 'executed' })).toBeUndefined();

        expect(await backend.get(ACTION_ID)).toMatchObject({ state: 'approved', claimId: claimed!.claimId });
    });
});

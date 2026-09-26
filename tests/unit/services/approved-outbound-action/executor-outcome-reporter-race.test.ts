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
import type { ButtonInteraction, Channel } from 'discord.js';
import type { ChannelId } from '@/config';
import { ApprovalCardEditGate } from '@/integrations/discord/approvals/card-edit-gate';
import { ApprovedActionEscalationHandler } from '@/integrations/discord/approvals/escalation-interaction-handler';
import { createApprovedActionOutcomeDelivery } from '@/integrations/discord/approvals/outcome-delivery';
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
 * Only equality (`name = value`), `name <= value`, `IN (...)` and `attribute_not_exists(name)`
 * clauses joined by `AND`, with one top-level `OR` of parenthesised groups, are supported: every
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

/** Splits `expression` on `separator` wherever it is outside parentheses. */
function splitTopLevel(expression: string, separator: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for(let index = 0; index < expression.length; index++) {
        if(expression[index] === '(') {
            depth++;
        } else if(expression[index] === ')') {
            depth--;
        } else if(depth === 0 && expression.startsWith(separator, index)) {
            parts.push(expression.slice(start, index));
            start = index + separator.length;
        }
    }
    parts.push(expression.slice(start));
    return parts;
}

/**
 * Evaluates a DynamoDB condition/filter/key expression against one item: top-level `OR` of
 * (optionally parenthesised) `AND`-joined clauses.
 */
function evaluateExpression(
    expression: string,
    names: Record<string, string> | undefined,
    values: Record<string, unknown> | undefined,
    item: Record<string, unknown> | undefined
): boolean {
    const alternatives = splitTopLevel(expression.trim(), ' OR ');
    if(alternatives.length > 1) {
        return alternatives.some(alternative => evaluateExpression(alternative, names, values, item));
    }
    const single = expression.trim();
    if(single.startsWith('(') && single.endsWith(')')) {
        return evaluateExpression(single.slice(1, -1), names, values, item);
    }
    return single.split(' AND ').every((rawClause) => {
        const clause = rawClause.trim();
        const absent = /^attribute_not_exists\((\S+)\)$/.exec(clause);
        if(absent) {
            return item?.[resolveName(absent[1], names)] === undefined;
        }
        const atMost = /^(\S+) <= (\S+)$/.exec(clause);
        if(atMost) {
            const [, nameToken, valueToken] = atMost;
            return String(item?.[resolveName(nameToken, names)]) <= String(values?.[valueToken]);
        }
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

describe('an outcome unknown for 24 h, escalated to the admin, driven against the real backend (#125)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const ADMIN = '1234567890';
    let fake: ReturnType<typeof createConditionEvaluatingDynamoFake>;
    let backend: ApprovedOutboundActionBackend;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(FROZEN_AT));
        fake = createConditionEvaluatingDynamoFake();
        backend = new ApprovedOutboundActionBackend(fake.docClient, TABLE_NAME);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        fake.restore();
    });

    async function createUnknown(overrides: Partial<ApprovedOutboundAction> = {}): Promise<void> {
        await backend.create({
            id:             ACTION_ID,
            state:          'unverified',
            type:           'email_send',
            params:         { uid: 42 },
            lastError:      'fetch failed',
            firstClaimedAt: FROZEN_AT,
            approvalCard:   { channelId: '111', messageId: '222' },
            createdAt:      FROZEN_AT,
            updatedAt:      FROZEN_AT,
            ...overrides,
        });
    }

    /** The admin channel's ping message, as Discord answers a send. */
    const PING = { channelId: '333', messageId: '444' };

    function makeDiscord(cardEdits = new ApprovalCardEditGate()) {
        const edit = mock(async (messageId: string, options: { components: unknown[] }): Promise<unknown> => ({ url: `https://discord.com/channels/g/c/${messageId}`, options }));
        const send = mock(async (_options: unknown): Promise<unknown> => ({ channelId: PING.channelId, id: PING.messageId }));
        const channel = { isTextBased: () => true, isSendable: () => true, messages: { edit }, send } as unknown as Channel;
        const notify = mock((): boolean => true);
        const deliver = createApprovedActionOutcomeDelivery({
            fetchChannel:   async () => channel,
            isDiscordReady: () => true,
            notify,
            backend,
            cardEdits,
            adminChannelId: 'admin-review' as ChannelId,
            adminUserId:    ADMIN,
        });
        return { edit, send, notify, deliver };
    }

    function makeHandler(cardEdits = new ApprovalCardEditGate()) {
        const wakeExecutor = mock((): void => undefined);
        const handler = new ApprovedActionEscalationHandler({ backend, adminUserId: ADMIN, wakeReporter: () => undefined, wakeExecutor, cardEdits });
        return { handler, wakeExecutor };
    }

    function click(prefix: string, revision: string, messageId = '222') {
        const reply = mock(async (_options: unknown): Promise<unknown> => ({}));
        const update = mock(async (_options: unknown): Promise<unknown> => ({}));
        const interaction = { customId: `${prefix}:${ACTION_ID}:${revision}`, user: { id: ADMIN }, message: { id: messageId }, reply, update } as unknown as ButtonInteraction;
        return { interaction, reply, update };
    }

    /** Resend through the executor's own claim and settle, ending unknown again: a new unknown episode. */
    async function resendEndingUnknown(): Promise<string> {
        const reset = await backend.get(ACTION_ID);
        const claimed = await backend.claim(reset!);
        await backend.settleClaim(claimed!, { state: 'unverified', lastError: 'fetch failed' });
        return (await backend.get(ACTION_ID))!.updatedAt;
    }

    function controlsShown(edit: ReturnType<typeof mock<(messageId: string, options: { components: unknown[] }) => Promise<unknown>>>): boolean[] {
        return edit.mock.calls.map(([, options]) => options.components.length > 0);
    }

    test('escalates at exactly 24 h, pings once across a restart, and a later unknown episode regains only the controls', async () => {
        await createUnknown();
        const discord = makeDiscord();
        const reporterAt = (at: number) => createApprovedActionOutcomeReporter({ backend, deliver: discord.deliver, logger: makeLogger(), now: () => at });

        expect(await reporterAt(Date.parse(FROZEN_AT) + DAY_MS - 1).reportOnce()).toEqual({ delivered: 0, pending: 0 });
        expect(discord.edit).not.toHaveBeenCalled();

        expect(await reporterAt(Date.parse(FROZEN_AT) + DAY_MS).reportOnce()).toEqual({ delivered: 1, pending: 0 });
        expect(discord.send).toHaveBeenCalledTimes(1);
        expect(discord.notify).not.toHaveBeenCalled();
        expect(await backend.get(ACTION_ID)).toMatchObject({ state: 'unverified', updatedAt: FROZEN_AT, escalated: true });
        expect(await backend.getAdminPing(ACTION_ID)).toStrictEqual({});

        // A restarted reporter finds nothing to do: the episode is escalated and its report cleared.
        expect(await reporterAt(Date.parse(FROZEN_AT) + (2 * DAY_MS)).reportOnce()).toEqual({ delivered: 0, pending: 0 });
        expect(discord.send).toHaveBeenCalledTimes(1);

        // The admin authorises a resend; the resend's own send ends unknown again.
        jest.setSystemTime(new Date(Date.parse(FROZEN_AT) + (2 * DAY_MS)));
        const { handler, wakeExecutor } = makeHandler();
        await handler.handleButton(click('approved-action-resend', FROZEN_AT).interaction);
        expect(wakeExecutor).toHaveBeenCalledTimes(1);
        const reset = await backend.get(ACTION_ID);
        expect(reset).toMatchObject({ state: 'approved' });
        expect(reset).not.toHaveProperty('escalated');
        const secondEpisode = await resendEndingUnknown();

        // Its interim report goes out as usual, then 24 h later the controls return without a second ping.
        expect(await reporterAt(Date.parse(secondEpisode)).reportOnce()).toEqual({ delivered: 1, pending: 0 });
        expect(await reporterAt(Date.parse(secondEpisode) + DAY_MS).reportOnce()).toEqual({ delivered: 1, pending: 0 });
        expect(controlsShown(discord.edit)).toEqual([true, false, true]);
        expect(discord.send).toHaveBeenCalledTimes(1);
    });

    test('a destination check that decides first wins; the admin click changes nothing', async () => {
        await createUnknown({ escalated: true });
        const listed = (await backend.get(ACTION_ID)) as UnverifiedApprovedOutboundAction;
        expect(await backend.resolveUnverified(listed, 'executed')).toBeDefined();

        const { handler, wakeExecutor } = makeHandler();
        const fakeClick = click('approved-action-resend', FROZEN_AT);
        await handler.handleButton(fakeClick.interaction);

        expect(fakeClick.reply).toHaveBeenCalledTimes(1);
        expect(wakeExecutor).not.toHaveBeenCalled();
        expect(await backend.get(ACTION_ID)).toMatchObject({ state: 'executed' });
    });

    test('a double Resend resets once, and only the executor\'s claim sends it, once', async () => {
        await createUnknown({ escalated: true });
        const { handler } = makeHandler();
        const first = click('approved-action-resend', FROZEN_AT);
        const second = click('approved-action-resend', FROZEN_AT);
        await Promise.all([handler.handleButton(first.interaction), handler.handleButton(second.interaction)]);
        expect(first.update.mock.calls.length + second.update.mock.calls.length).toBe(1);

        const executors = makeExecutors();
        const executor = createApprovedOutboundActionExecutor({
            backend,
            registry:  { isAvailable: () => true } as unknown as ServiceHealthRegistry,
            executors,
            verifiers: {
                bsky_reply: { check: async () => ({ verdict: 'undetermined', reason: 'n/a' }), contentKey: () => undefined },
                bsky_dm:    { check: async () => ({ verdict: 'undetermined', reason: 'n/a' }), contentKey: () => undefined },
                email_send: { check: async () => ({ verdict: 'undetermined', reason: 'n/a' }), contentKey: () => undefined },
            },
            onOutcomeRecorded: () => undefined,
            logger:            makeLogger(),
        });
        await executor.executeOnce();
        await executor.executeOnce();

        expect(executors.email_send).toHaveBeenCalledTimes(1);
        expect(await backend.get(ACTION_ID)).toMatchObject({ state: 'executed' });
    });

    test('a timed-out send that succeeds after its row was escalated and the admin pinged still resolves the row (#126)', async () => {
        await createUnknown({ state: 'approved', lastError: undefined, firstClaimedAt: undefined });
        const send = Promise.withResolvers<undefined>();
        const executors = makeExecutors();
        executors.email_send.mockImplementation(async () => send.promise);
        const executor = createApprovedOutboundActionExecutor({
            backend,
            registry:  { isAvailable: () => true } as unknown as ServiceHealthRegistry,
            executors,
            verifiers: {
                bsky_reply: { check: async () => ({ verdict: 'undetermined', reason: 'n/a' }), contentKey: () => undefined },
                bsky_dm:    { check: async () => ({ verdict: 'undetermined', reason: 'n/a' }), contentKey: () => undefined },
                email_send: { check: async () => ({ verdict: 'undetermined', reason: 'n/a' }), contentKey: () => undefined },
            },
            onOutcomeRecorded: () => undefined,
            logger:            makeLogger(),
            sendTimeoutMs:     1000,
            claimLeaseMs:      1001,
        });
        const pass = executor.executeOnce();
        await flush();
        jest.advanceTimersByTime(1000);
        await pass;
        const episode = (await backend.get(ACTION_ID))!.updatedAt;

        // The interim report, then the escalation a day later with its admin ping.
        const discord = makeDiscord();
        expect(await createApprovedActionOutcomeReporter({ backend, deliver: discord.deliver, logger: makeLogger(), now: () => Date.parse(episode) }).reportOnce()).toEqual({ delivered: 1, pending: 0 });
        expect(await createApprovedActionOutcomeReporter({ backend, deliver: discord.deliver, logger: makeLogger(), now: () => Date.parse(episode) + DAY_MS }).reportOnce()).toEqual({ delivered: 1, pending: 0 });
        expect(discord.send).toHaveBeenCalledTimes(1);

        send.resolve(undefined);
        await flush();

        expect(await backend.get(ACTION_ID)).toMatchObject({ state: 'executed', outcomeReportPending: true });
        expect(await backend.getAdminPing(ACTION_ID)).toStrictEqual({});
    });

    test('a ping Discord accepted while a check moved the row on is still recorded, so a later episode never pings again', async () => {
        await createUnknown();
        const discord = makeDiscord();
        discord.send.mockImplementation(async () => {
            // The destination check decides "definitely absent" while Discord is taking the ping.
            await backend.resolveUnverified((await backend.get(ACTION_ID)) as UnverifiedApprovedOutboundAction, 'approved');
            return { channelId: PING.channelId, id: PING.messageId };
        });
        const reporterAt = (at: number) => createApprovedActionOutcomeReporter({ backend, deliver: discord.deliver, logger: makeLogger(), now: () => at });

        await reporterAt(Date.parse(FROZEN_AT) + DAY_MS).reportOnce();
        expect(await backend.get(ACTION_ID)).toMatchObject({ state: 'approved' });
        expect(await backend.getAdminPing(ACTION_ID)).toStrictEqual({});

        const secondEpisode = await resendEndingUnknown();
        await reporterAt(Date.parse(secondEpisode) + DAY_MS).reportOnce();
        expect(await backend.get(ACTION_ID)).toMatchObject({ state: 'unverified', escalated: true });
        expect(discord.send).toHaveBeenCalledTimes(1);
    });

    test('a card-less row keeps working controls on its one ping across unknown episodes', async () => {
        await createUnknown({ approvalCard: undefined });
        const discord = makeDiscord();
        const reporterAt = (at: number) => createApprovedActionOutcomeReporter({ backend, deliver: discord.deliver, logger: makeLogger(), now: () => at });

        await reporterAt(Date.parse(FROZEN_AT) + DAY_MS).reportOnce();
        expect(discord.send).toHaveBeenCalledTimes(1);
        expect(discord.edit).not.toHaveBeenCalled();
        expect(await backend.getAdminPing(ACTION_ID)).toStrictEqual({ message: PING });

        // The admin resends from the ping; the resend ends unknown again.
        jest.setSystemTime(new Date(Date.parse(FROZEN_AT) + (2 * DAY_MS)));
        await makeHandler().handler.handleButton(click('approved-action-resend', FROZEN_AT, PING.messageId).interaction);
        const secondEpisode = await resendEndingUnknown();

        // Its interim report clears the ping's old controls; 24 h later the ping regains controls for the new episode.
        await reporterAt(Date.parse(secondEpisode)).reportOnce();
        await reporterAt(Date.parse(secondEpisode) + DAY_MS).reportOnce();
        expect(discord.edit.mock.calls.map(([messageId]) => messageId)).toEqual([PING.messageId, PING.messageId]);
        expect(controlsShown(discord.edit)).toEqual([false, true]);
        const [controls] = (discord.edit.mock.calls[1]?.[1] as unknown as { components: { toJSON: () => { components: { custom_id: string }[] } }[] }).components.map(row => row.toJSON());
        expect(controls.components.map(button => button.custom_id)).toEqual([`approved-action-mark-sent:${ACTION_ID}:${secondEpisode}`, `approved-action-resend:${ACTION_ID}:${secondEpisode}`]);
        expect(discord.send).toHaveBeenCalledTimes(1);
    });

    test('an interim report Izzy never took does not hold back the escalation', async () => {
        await createUnknown({ outcomeReportPending: true });
        const discord = makeDiscord();
        discord.notify.mockImplementation(() => false);

        const pass = await createApprovedActionOutcomeReporter({ backend, deliver: discord.deliver, logger: makeLogger(), now: () => Date.parse(FROZEN_AT) + (2 * DAY_MS) }).reportOnce();

        expect(pass).toEqual({ delivered: 0, pending: 1 });
        expect(controlsShown(discord.edit)).toEqual([true]);
        expect(discord.send).toHaveBeenCalledTimes(1);
        expect(await backend.get(ACTION_ID)).toMatchObject({ state: 'unverified', escalated: true, outcomeReportPending: true });
        expect(await backend.get(ACTION_ID)).not.toHaveProperty('outcomeNotified');
        expect(await backend.getAdminPing(ACTION_ID)).toStrictEqual({});
    });

    test('an escalation still waiting on the card when the admin resends never paints stale controls over the resend', async () => {
        await createUnknown({ escalated: true, outcomeReportPending: true, outcomeNotified: true });
        const cardEdits = new ApprovalCardEditGate();
        const discord = makeDiscord(cardEdits);
        const escalatedSnapshot = await backend.get(ACTION_ID);
        const resend = click('approved-action-resend', FROZEN_AT);
        // The admin's click holds the card first; the escalation's delivery queues behind it.
        const clicked = makeHandler(cardEdits).handler.handleButton(resend.interaction);
        const delivered = discord.deliver(escalatedSnapshot!);

        await clicked;
        expect(await delivered).toBe(false);
        expect(resend.update).toHaveBeenCalledTimes(1);
        expect(discord.edit).not.toHaveBeenCalled();
        expect(await backend.get(ACTION_ID)).toMatchObject({ state: 'approved' });
    });
});

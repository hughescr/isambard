import { describe, expect, test } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
    runTagIndexReconciliation,
    type ReconcilerDeps,
    type ReconcilerOptions
} from '@/storage/memory-tool/reconciliation/reconciler';
import type { MemoryPath, MemoryToolItemData } from '@/storage/memory-tool/types';

type AbortScenario = 'phase-a-pre-aborted' | 'phase-b-abort-during-tag-enumeration';

type Settlement = { kind: 'fulfilled' } | { kind: 'rejected', error: unknown };

interface BoundaryMarker {
    promise: Promise<{ kind: 'marker' }>
    start:   () => void
}

function markerAfterMicrotasks(depth: number): BoundaryMarker {
    let resolveMarker!: (value: { kind: 'marker' }) => void;
    let started = false;
    const promise = new Promise<{ kind: 'marker' }>((resolve) => {
        resolveMarker = resolve;
    });

    return {
        promise,
        start: () => {
            if(started) {
                throw new Error('Abort boundary marker started twice');
            }
            started = true;
            let currentDepth = 0;
            const tick = () => {
                currentDepth++;
                if(currentDepth === depth) {
                    resolveMarker({ kind: 'marker' });
                    return;
                }
                void Promise.resolve().then(tick);
            };
            void Promise.resolve().then(tick);
        },
    };
}

function launchAbortScenario(
    scenario: AbortScenario,
    onAbortBoundary: () => void
): { promise: Promise<unknown>, calls: string[] } {
    const controller = new AbortController();
    const calls: string[] = [];

    const docClient = {
        send(command: { input?: Record<string, unknown> }) {
            const input = command.input ?? {};
            const indexName = typeof input.IndexName === 'string' ? input.IndexName : 'TABLE';
            const keyCondition = typeof input.KeyConditionExpression === 'string'
                ? input.KeyConditionExpression
                : '';
            calls.push(`${indexName}:${keyCondition}`);

            if(indexName === 'GSI1') {
                return Promise.resolve({ Items: [] });
            }

            if(indexName === 'GSI2' && scenario === 'phase-b-abort-during-tag-enumeration') {
                controller.abort();
                onAbortBoundary();
                return Promise.resolve({
                    Items: [{
                        PK:     'TAG#probe',
                        SK:     'META_COUNT',
                        GSI2PK: 'TAG_COUNTS',
                        GSI2SK: 'TAG#probe',
                        count:  1,
                    }],
                });
            }

            throw new Error(`Unexpected DynamoDB call after abort: ${JSON.stringify(input)}`);
        },
    } as unknown as DynamoDBDocumentClient;

    const unreachable = async (): Promise<never> => {
        throw new Error('Unexpected dependency call after abort');
    };
    const deps: ReconcilerDeps = {
        docClient,
        tableName: 'AbortOrderTestTable',
        tagIndex:  {
            createTagIndexItems:  unreachable,
            deleteTagIndexItems:  unreachable,
            refreshTagIndexItems: unreachable,
            listTagCounts:        unreachable,
        },
        getMemory: async (_path: MemoryPath): Promise<MemoryToolItemData | undefined> => undefined,
    };
    const options: ReconcilerOptions = {
        operationDelayMs: 0,
        scanPageSize:     25,
        backoff:          { baseDelayMs: 0, maxAttempts: 1 },
        signal:           controller.signal,
    };

    if(scenario === 'phase-a-pre-aborted') {
        controller.abort();
    }

    const promise = runTagIndexReconciliation(deps, options);
    if(scenario === 'phase-a-pre-aborted') {
        onAbortBoundary();
    }
    return { promise, calls };
}

async function expectAbortBeforeMarker(
    scenario: AbortScenario,
    markerDepth: number,
    expectedCalls: string[]
): Promise<void> {
    const marker = markerAfterMicrotasks(markerDepth);
    const { promise, calls } = launchAbortScenario(scenario, marker.start);
    // A separate catch would add a promise reaction and move the ordering boundary under test.
    // eslint-disable-next-line promise/prefer-catch -- observe fulfillment/rejection in one reaction
    const settlement: Promise<Settlement> = promise.then(
        () => ({ kind: 'fulfilled' }),
        error => ({ kind: 'rejected', error })
    );

    const winner = await Promise.race([settlement, marker.promise]);
    expect(winner.kind).toBe('rejected');
    const rejection = winner as Extract<Settlement, { kind: 'rejected' }>;
    expect(rejection.error).toBeInstanceOf(DOMException);
    expect(rejection.error).toMatchObject({
        name:    'AbortError',
        message: 'Aborted',
    });
    expect(calls).toEqual(expectedCalls);
}

describe('runTagIndexReconciliation abort settlement order', () => {
    test('Phase A pre-abort rejects before the second boundary microtask', async () => {
        expect.hasAssertions();
        // The outer throw wins at depth 2; delegating to async scanLayer loses this race.
        await expectAbortBeforeMarker('phase-a-pre-aborted', 2, []);
    });

    test('Phase B enumeration abort rejects before the ninth boundary microtask', async () => {
        expect.hasAssertions();
        // Four Phase A partitions add one await before Phase B's enumeration boundary.
        await expectAbortBeforeMarker('phase-b-abort-during-tag-enumeration', 9, [
            'GSI1:GSI1PK = :gsi1pk',
            'GSI1:GSI1PK = :gsi1pk',
            'GSI1:GSI1PK = :gsi1pk',
            'GSI1:GSI1PK = :gsi1pk',
            'GSI2:GSI2PK = :gsi2pk',
        ]);
    });
});

import { describe, expect, mock, test, jest, beforeEach, afterEach } from 'bun:test';
import { type DynamoDBDocumentClient, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockLogger } from '../../../../setup';
import { runTagIndexReconciliation, type ReconcilerDeps, type ReconcilerOptions } from '@/storage/memory-tool/reconciliation/reconciler';
import type { MemoryPath, MemoryToolItemData } from '@/storage/memory-tool/types';

/**
 * Pins the reconciler's pagination-pacing and abort edges that the broader reconciler suites leave
 * loose: the GSI2 tag-name enumeration's pacing wait and missing-capacity stop, Phase B's per-tag
 * scan missing-capacity stop, Phase A's between-pages abort check, and Phase C's COUNT pagination
 * (abort between pages, missing capacity, and an omitted Count).
 */

type Input = Record<string, unknown>;
type Send = (command: { input: Input }) => Promise<Record<string, unknown>>;

const options: ReconcilerOptions = {
    operationDelayMs: 0,
    scanPageSize:     25,
    backoff:          { baseDelayMs: 0, maxAttempts: 1 },
};

const isGsi1 = (input: Input): boolean => input.IndexName === 'GSI1';
const isGsi2 = (input: Input): boolean => input.IndexName === 'GSI2';
const isIdentityLayer = (input: Input): boolean =>
    isGsi1(input) && (input.ExpressionAttributeValues as Input | undefined)?.[':gsi1pk'] === 'LAYER#identity';
const isTagPrefixQuery = (input: Input): boolean => input.KeyConditionExpression === 'PK = :pk AND begins_with(SK, :skPrefix)';
const isTagScan = (input: Input): boolean => isTagPrefixQuery(input) && input.Select === undefined;
const isCountQuery = (input: Input): boolean => isTagPrefixQuery(input) && input.Select === 'COUNT';

function makeDeps(send: Send, tagCounts: { tag: string, count: number }[] = []): ReconcilerDeps {
    const empty = mock(async (): Promise<void> => {});
    return {
        docClient: { send } as unknown as DynamoDBDocumentClient,
        tableName: 'PacingGapTable',
        tagIndex:  {
            createTagIndexItems:  empty,
            refreshTagIndexItems: empty,
            deleteTagIndexItems:  empty,
            listTagCounts:        mock(async () => tagCounts),
        },
        getMemory: mock(async (_path: MemoryPath): Promise<MemoryToolItemData | undefined> => undefined),
    };
}

/** Records every command sent, answering with `route(input)`, or an empty terminal page when it returns undefined. */
function recordingSend(route: (input: Input) => Record<string, unknown> | undefined): { send: Send, commands: unknown[], inputs: Input[] } {
    const commands: unknown[] = [];
    const inputs: Input[] = [];
    const send: Send = async (command) => {
        commands.push(command);
        inputs.push(command.input);
        return route(command.input) ?? { Items: [] };
    };
    return { send, commands, inputs };
}

async function flushMicrotasks(): Promise<void> {
    for(let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential: draining the microtask queue one tick at a time
        await Promise.resolve();
    }
}

beforeEach(() => {
    mockLogger.warn.mockReset();
});

afterEach(() => {
    mockLogger.warn.mockReset();
});

describe('getAllTagNames (Phase B tag-name enumeration over GSI2)', () => {
    describe('RCU pacing', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('holds the next GSI2 page until the previous page\'s reported capacity has been paid off', async () => {
            let gsi2Page = 0;
            const { send, inputs } = recordingSend((input) => {
                if(isGsi2(input)) {
                    gsi2Page++;
                    return gsi2Page === 1
                        ? { Items: [], LastEvaluatedKey: { PK: 'cursor', SK: 'first' }, ConsumedCapacity: { CapacityUnits: 3 } }
                        : { Items: [] };
                }
                return undefined;
            });
            const gsi2Calls = () => inputs.filter(input => isGsi2(input));

            // rateLimitRcuPerSec unset: GSI2's provisioned 1 RCU/s, so 3 RCU owes 3000ms
            const resultPromise = runTagIndexReconciliation(makeDeps(send), options);
            for(let i = 0; i < 10 && gsi2Calls().length === 0; i++) {
                // eslint-disable-next-line no-await-in-loop -- test setup: polling until the first GSI2 page is issued
                await flushMicrotasks();
            }
            await flushMicrotasks();

            expect(gsi2Calls()).toHaveLength(1);
            jest.advanceTimersByTime(2999);
            await flushMicrotasks();
            expect(gsi2Calls()).toHaveLength(1);
            jest.advanceTimersByTime(1);
            const result = await resultPromise;

            expect(gsi2Calls()).toHaveLength(2);
            expect(gsi2Calls()[1]?.ExclusiveStartKey).toEqual({ PK: 'cursor', SK: 'first' });
            expect(result.phaseB.errors).toBe(0);
        });
    });

    test('stops enumerating, and fails Phase B with exactly one error, when a continuing page omits ConsumedCapacity', async () => {
        let gsi2Page = 0;
        const { send, inputs } = recordingSend((input) => {
            if(isGsi2(input)) {
                gsi2Page++;
                return gsi2Page === 1
                    ? { Items: [{ GSI2SK: 'TAG#first' }], LastEvaluatedKey: { PK: 'cursor', SK: 'first' } } // no ConsumedCapacity
                    : { Items: [{ GSI2SK: 'TAG#second' }] };
            }
            return undefined;
        });

        const result = await runTagIndexReconciliation(makeDeps(send), options);

        expect(inputs.filter(input => isGsi2(input))).toHaveLength(1); // the unpaced second page is never read
        expect(inputs.filter(input => isTagScan(input))).toHaveLength(0); // and no tag from the partial list is scanned
        expect(result.phaseB.errors).toBe(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({ msg: 'Failed to enumerate tags for Phase B' });
    });
});

describe('scanTagItems (Phase B per-tag index scan)', () => {
    test('stops the tag\'s scan with exactly one error and a tag-named warning when a continuing page omits ConsumedCapacity', async () => {
        let tagPage = 0;
        const { send, inputs } = recordingSend((input) => {
            if(isGsi2(input)) {
                return { Items: [{ GSI2SK: 'TAG#alpha' }] };
            }
            if(isTagScan(input)) {
                tagPage++;
                return tagPage === 1
                    ? { Items: [], LastEvaluatedKey: { PK: 'TAG#alpha', SK: 'PATH#/x' } } // no ConsumedCapacity
                    : { Items: [] };
            }
            return undefined;
        });

        const result = await runTagIndexReconciliation(makeDeps(send), options);

        expect(inputs.filter(input => isTagScan(input))).toHaveLength(1);
        expect(result.phaseB.errors).toBe(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({
            tag: 'alpha',
            msg: 'scanTagItems omitted ConsumedCapacity; stopping pagination without pacing',
        });
    });
});

describe('scanLayer (Phase A GSI1 layer scan)', () => {
    test('throws an "Aborted" AbortError before reading the next page when the signal fired during the previous one', async () => {
        const controller = new AbortController();
        let identityPage = 0;
        const { send, inputs } = recordingSend((input) => {
            if(isIdentityLayer(input)) {
                identityPage++;
                if(identityPage === 1) {
                    controller.abort(); // fires while page 1 is in flight; page 1 itself still resolves
                    return { Items: [], LastEvaluatedKey: { PK: 'cursor', SK: 'first' }, ConsumedCapacity: { CapacityUnits: 0 } };
                }
            }
            return undefined;
        });

        const error: unknown = await runTagIndexReconciliation(makeDeps(send), { ...options, signal: controller.signal })
            .catch((error_: unknown) => error_);

        expect(inputs.filter(input => isIdentityLayer(input))).toHaveLength(1); // no second page read after the abort
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe('AbortError');
        expect((error as DOMException).message).toBe('Aborted');
    });
});

describe('getActualTagCount (Phase C COUNT pagination)', () => {
    test('gives up on the tag, without reading the next page, when the signal fired during the previous page', async () => {
        const controller = new AbortController();
        let countPage = 0;
        const { send, inputs, commands } = recordingSend((input) => {
            if(isCountQuery(input)) {
                countPage++;
                if(countPage === 1) {
                    controller.abort(); // fires while page 1 is in flight; page 1 itself still resolves
                    return { Count: 1, LastEvaluatedKey: { PK: 'TAG#alpha', SK: 'PATH#/x' }, ConsumedCapacity: { CapacityUnits: 0 } };
                }
                return { Count: 4 };
            }
            return undefined;
        });

        const result = await runTagIndexReconciliation(makeDeps(send, [{ tag: 'alpha', count: 5 }]), { ...options, signal: controller.signal });

        expect(inputs.filter(input => isCountQuery(input))).toHaveLength(1);
        expect(commands.filter(command => command instanceof UpdateCommand || command instanceof DeleteCommand)).toHaveLength(0);
        expect(result.phaseC.errors).toBe(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({ tag: 'alpha', msg: 'Failed to get actual tag count' });
    });

    test('stops the count with exactly one error and a tag-named warning when a continuing page omits ConsumedCapacity', async () => {
        let countPage = 0;
        const { send, inputs, commands } = recordingSend((input) => {
            if(isCountQuery(input)) {
                countPage++;
                return countPage === 1
                    ? { Count: 2, LastEvaluatedKey: { PK: 'TAG#alpha', SK: 'PATH#/x' } } // no ConsumedCapacity
                    : { Count: 3 };
            }
            return undefined;
        });

        const result = await runTagIndexReconciliation(makeDeps(send, [{ tag: 'alpha', count: 5 }]), options);

        expect(inputs.filter(input => isCountQuery(input))).toHaveLength(1);
        expect(commands.filter(command => command instanceof UpdateCommand || command instanceof DeleteCommand)).toHaveLength(0);
        expect(result.phaseC.errors).toBe(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({
            tag: 'alpha',
            msg: 'getActualTagCount omitted ConsumedCapacity; stopping pagination without pacing',
        });
    });

    test('counts a page that omits Count as zero items, so a tag with no index rows has its META_COUNT deleted', async () => {
        const { send, commands } = recordingSend((input) => {
            if(isCountQuery(input)) {
                return {}; // no Count, no further page
            }
            return undefined;
        });

        const result = await runTagIndexReconciliation(makeDeps(send, [{ tag: 'alpha', count: 5 }]), options);

        expect(commands.filter(command => command instanceof UpdateCommand)).toHaveLength(0);
        const deletes = commands.filter(command => command instanceof DeleteCommand);
        expect(deletes.map(command => command.input.Key)).toEqual([{ PK: 'TAG#alpha', SK: 'META_COUNT' }]);
        expect(result.phaseC).toMatchObject({ countsVerified: 1, countsDeleted: 1, countsCorrected: 0, errors: 0 });
    });
});

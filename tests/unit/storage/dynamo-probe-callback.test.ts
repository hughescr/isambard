import { describe, it, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { runDynamoDBProbe, type ProbeEventSender } from '../../../src/storage/dynamo-probe-callback';
import type { RetryLogger } from '@/utils/retry/types';

function makeStubClient(): DynamoDBClient {
    return {} as unknown as DynamoDBClient;
}

function makeStubRegistry(): { eventSender: ProbeEventSender, sendEventMock: ReturnType<typeof mock> } {
    const sendEventMock = mock(() => {});
    const eventSender: ProbeEventSender = {
        sendEvent: sendEventMock,
    };
    return { eventSender, sendEventMock };
}

function makeStubLogger(): RetryLogger {
    return {
        warn:  mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
    };
}

describe('runDynamoDBProbe', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('on probe success', () => {
        it('should call probeFn with the provided client and tableName', async () => {
            const probeFn = mock(async (_client: DynamoDBClient, _tableName: string) => {});
            const client = makeStubClient();
            const { eventSender, sendEventMock } = makeStubRegistry();

            await runDynamoDBProbe(client, 'TestTable', eventSender, undefined, probeFn);

            expect(probeFn).toHaveBeenCalledTimes(1);
            expect(probeFn).toHaveBeenCalledWith(client, 'TestTable');
            expect(sendEventMock).not.toHaveBeenCalled();
        });

        it('should NOT call registry.sendEvent on success', async () => {
            const probeFn = mock(async (_client: DynamoDBClient, _tableName: string) => {});
            const client = makeStubClient();
            const { eventSender, sendEventMock } = makeStubRegistry();

            await runDynamoDBProbe(client, 'TestTable', eventSender, undefined, probeFn);

            expect(sendEventMock).not.toHaveBeenCalled();
        });

        it('should NOT call logger.warn on success', async () => {
            const probeFn = mock(async (_client: DynamoDBClient, _tableName: string) => {});
            const client = makeStubClient();
            const { eventSender } = makeStubRegistry();
            const logger = makeStubLogger();

            await runDynamoDBProbe(client, 'TestTable', eventSender, logger, probeFn);

            expect((logger.warn as ReturnType<typeof mock>)).not.toHaveBeenCalled();
        });
    });

    describe('on probe failure with Error', () => {
        it('should send CONNECTION_LOST to the health registry', async () => {
            const probeFn = mock(async (_client: DynamoDBClient, _tableName: string): Promise<void> => {
                throw new Error('FailedToOpenSocket');
            });
            const client = makeStubClient();
            const { eventSender, sendEventMock } = makeStubRegistry();

            await runDynamoDBProbe(client, 'TestTable', eventSender, undefined, probeFn);

            expect(sendEventMock).toHaveBeenCalledTimes(1);
            expect(sendEventMock).toHaveBeenCalledWith(
                'dynamodb',
                'CONNECTION_LOST',
                { error: 'FailedToOpenSocket' }
            );
        });

        it('should NOT send CONNECT_FAIL (the wrong event) when probe fails', async () => {
            const probeFn = mock(async (_client: DynamoDBClient, _tableName: string): Promise<void> => {
                throw new Error('socket hang up');
            });
            const client = makeStubClient();
            const { eventSender, sendEventMock } = makeStubRegistry();

            await runDynamoDBProbe(client, 'TestTable', eventSender, undefined, probeFn);

            const calls = sendEventMock.mock.calls as unknown[][];
            const connectFailCalls = calls.filter(args => args[1] === 'CONNECT_FAIL');
            expect(connectFailCalls).toHaveLength(0);
        });

        it('should call logger.warn with error details on failure', async () => {
            const probeFn = mock(async (_client: DynamoDBClient, _tableName: string): Promise<void> => {
                throw new Error('ETIMEDOUT');
            });
            const client = makeStubClient();
            const { eventSender } = makeStubRegistry();
            const logger = makeStubLogger();

            await runDynamoDBProbe(client, 'TestTable', eventSender, logger, probeFn);

            const warnMock = logger.warn as ReturnType<typeof mock>;
            expect(warnMock).toHaveBeenCalledTimes(1);
            const warnArg = warnMock.mock.calls[0][0] as Record<string, unknown>;
            expect(warnArg.error).toBe('ETIMEDOUT');
            expect(warnArg.msg).toBe('DynamoDB periodic probe failed');
        });

        it('should resolve without throwing when probe fails', async () => {
            const probeFn = mock(async (_client: DynamoDBClient, _tableName: string): Promise<void> => {
                throw new Error('network error');
            });
            const client = makeStubClient();
            const { eventSender } = makeStubRegistry();

            await runDynamoDBProbe(client, 'TestTable', eventSender, undefined, probeFn);
            // resolves without throwing — void return is the contract
        });
    });

    describe('on probe failure with non-Error', () => {
        it('should send CONNECTION_LOST with stringified error when probe throws a non-Error', async () => {
            const probeFn = mock(async (_client: DynamoDBClient, _tableName: string): Promise<void> => {
                throw 'plain string error';
            });
            const client = makeStubClient();
            const { eventSender, sendEventMock } = makeStubRegistry();

            await runDynamoDBProbe(client, 'TestTable', eventSender, undefined, probeFn);

            expect(sendEventMock).toHaveBeenCalledWith(
                'dynamodb',
                'CONNECTION_LOST',
                { error: 'plain string error' }
            );
        });
    });

    describe('without optional logger', () => {
        it('should send CONNECTION_LOST and not crash when no logger provided', async () => {
            const probeFn = mock(async (_client: DynamoDBClient, _tableName: string): Promise<void> => {
                throw new Error('ECONNRESET');
            });
            const client = makeStubClient();
            const { eventSender, sendEventMock } = makeStubRegistry();

            // No logger argument — should not crash
            await runDynamoDBProbe(client, 'TestTable', eventSender, undefined, probeFn);

            expect(sendEventMock).toHaveBeenCalledWith(
                'dynamodb',
                'CONNECTION_LOST',
                { error: 'ECONNRESET' }
            );
        });
    });

    describe('when eventSender.sendEvent throws', () => {
        it('should resolve cleanly even when sendEvent throws', async () => {
            const probeFn = mock(async (_client: DynamoDBClient, _tableName: string): Promise<void> => {
                throw new Error('network failure');
            });
            const client = makeStubClient();
            const throwingEventSender: ProbeEventSender = {
                sendEvent: mock(() => { throw new Error('registry stopped'); }),
            };
            const logger = makeStubLogger();

            // Should resolve without throwing — the sendEvent failure must be absorbed
            await runDynamoDBProbe(client, 'TestTable', throwingEventSender, logger, probeFn);
            // resolves without throwing — void return is the contract
        });

        it('should log the sendEvent error via the logger when sendEvent throws', async () => {
            const probeFn = mock(async (_client: DynamoDBClient, _tableName: string): Promise<void> => {
                throw new Error('probe error');
            });
            const client = makeStubClient();
            const sendEventError = new Error('registry stopped');
            const throwingEventSender: ProbeEventSender = {
                sendEvent: mock(() => { throw sendEventError; }),
            };
            const logger = makeStubLogger();

            await runDynamoDBProbe(client, 'TestTable', throwingEventSender, logger, probeFn);

            const warnMock = logger.warn as ReturnType<typeof mock>;
            // Two warn calls: one for the probe failure, one for the sendEvent failure
            expect(warnMock).toHaveBeenCalledTimes(2);
            const calls = warnMock.mock.calls as [Record<string, unknown>][];
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; calls[1] is verified by toHaveBeenCalledTimes(2) above
            const sendEventWarnArg = calls[1]![0];
            expect(sendEventWarnArg.msg).toBe('DynamoDB probe: failed to send CONNECTION_LOST event');
            expect(sendEventWarnArg.error).toBe('registry stopped');
        });

        it('should not crash when sendEvent throws and no logger is provided', async () => {
            const probeFn = mock(async (_client: DynamoDBClient, _tableName: string): Promise<void> => {
                throw new Error('probe error');
            });
            const client = makeStubClient();
            const throwingEventSender: ProbeEventSender = {
                sendEvent: mock(() => { throw new Error('registry stopped'); }),
            };

            // No logger — should still resolve without crashing
            await runDynamoDBProbe(client, 'TestTable', throwingEventSender, undefined, probeFn);
            // resolves without throwing — void return is the contract
        });
    });
});

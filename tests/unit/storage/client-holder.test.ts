import { describe, test, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClientHolder } from '../../../src/storage/client-holder';

function makeStubClient(destroyMock?: ReturnType<typeof mock>): DynamoDBClient {
    return { destroy: destroyMock ?? mock(() => {}) } as unknown as DynamoDBClient;
}

function makeStubDocClient(): DynamoDBDocumentClient {
    return {} as unknown as DynamoDBDocumentClient;
}

describe.concurrent('DynamoDBClientHolder', () => {
    describe.concurrent('getClient', () => {
        test('should return the initial client', () => {
            const client    = makeStubClient();
            const docClient = makeStubDocClient();
            const holder    = new DynamoDBClientHolder(client, docClient);

            expect(holder.getClient()).toBe(client);
        });
    });

    describe.concurrent('getDocClient', () => {
        test('should return the initial doc client', () => {
            const client    = makeStubClient();
            const docClient = makeStubDocClient();
            const holder    = new DynamoDBClientHolder(client, docClient);

            expect(holder.getDocClient()).toBe(docClient);
        });
    });

    describe('swap', () => {
        let destroyMock: ReturnType<typeof mock>;

        beforeEach(() => {
            destroyMock = mock(() => {});
            jest.useFakeTimers();
            jest.setSystemTime(0);
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('should update getClient() to return the new client after swap', () => {
            const oldClient    = makeStubClient(destroyMock);
            const oldDocClient = makeStubDocClient();
            const holder       = new DynamoDBClientHolder(oldClient, oldDocClient);

            const newClient    = makeStubClient();
            const newDocClient = makeStubDocClient();
            holder.swap(newClient, newDocClient);

            expect(holder.getClient()).toBe(newClient);
        });

        test('should update getDocClient() to return the new doc client after swap', () => {
            const oldClient    = makeStubClient(destroyMock);
            const oldDocClient = makeStubDocClient();
            const holder       = new DynamoDBClientHolder(oldClient, oldDocClient);

            const newClient    = makeStubClient();
            const newDocClient = makeStubDocClient();
            holder.swap(newClient, newDocClient);

            expect(holder.getDocClient()).toBe(newDocClient);
        });

        test('should NOT call destroy() on the old client synchronously after swap', () => {
            const oldClient    = makeStubClient(destroyMock);
            const oldDocClient = makeStubDocClient();
            const holder       = new DynamoDBClientHolder(oldClient, oldDocClient);

            const newClient    = makeStubClient();
            const newDocClient = makeStubDocClient();
            holder.swap(newClient, newDocClient);

            // Destroy must NOT be called immediately
            expect(destroyMock).not.toHaveBeenCalled();
        });

        test('should call destroy() on the old client after the grace period elapses', () => {
            const oldClient    = makeStubClient(destroyMock);
            const oldDocClient = makeStubDocClient();
            const holder       = new DynamoDBClientHolder(oldClient, oldDocClient);

            const newClient    = makeStubClient();
            const newDocClient = makeStubDocClient();
            holder.swap(newClient, newDocClient);

            expect(destroyMock).not.toHaveBeenCalled();

            // Advance past the grace period (GRACE_MS = 5000)
            jest.advanceTimersByTime(5001);

            expect(destroyMock).toHaveBeenCalledTimes(1);
        });

        test('should NOT call destroy() on the new client after swap', () => {
            const oldClient      = makeStubClient(destroyMock);
            const newDestroyMock = mock(() => {});
            const newClient      = makeStubClient(newDestroyMock);
            const holder         = new DynamoDBClientHolder(oldClient, makeStubDocClient());

            holder.swap(newClient, makeStubDocClient());

            jest.advanceTimersByTime(5001);

            expect(newDestroyMock).not.toHaveBeenCalled();
        });

        test('second swap during grace window: client2 gets a fresh grace period and is eventually destroyed', () => {
            const destroy1 = mock(() => {});
            const destroy2 = mock(() => {});
            const client1  = makeStubClient(destroy1);
            const client2  = makeStubClient(destroy2);
            const client3  = makeStubClient();
            const holder   = new DynamoDBClientHolder(client1, makeStubDocClient());

            // First swap: client1 → client2 (client1 grace timer starts)
            holder.swap(client2, makeStubDocClient());

            // Advance only partway through grace period
            jest.advanceTimersByTime(2000);

            expect(destroy1).not.toHaveBeenCalled();

            // Second swap: client2 → client3; client1 is eagerly destroyed and client2 gets a fresh timer
            holder.swap(client3, makeStubDocClient());

            // client1 was destroyed synchronously at second swap time
            expect(destroy1).toHaveBeenCalledTimes(1);

            // client2 should still be within its own fresh grace window
            expect(destroy2).not.toHaveBeenCalled();

            // Now advance past client2's full grace period (5 s from second swap = 3001 ms more)
            jest.advanceTimersByTime(5001);

            expect(destroy2).toHaveBeenCalledTimes(1);
        });

        test('second swap synchronously destroys the previously-pending client (client1 is eagerly destroyed when client2 replaces it)', () => {
            const destroy1 = mock(() => {});
            const destroy2 = mock(() => {});
            const client1  = makeStubClient(destroy1);
            const client2  = makeStubClient(destroy2);
            const client3  = makeStubClient();
            const holder   = new DynamoDBClientHolder(client1, makeStubDocClient());

            // First swap: client1 goes into grace period
            holder.swap(client2, makeStubDocClient());
            expect(destroy1).not.toHaveBeenCalled();

            // Second swap while timer is still pending — client1 must be destroyed immediately
            holder.swap(client3, makeStubDocClient());

            // client1 must be destroyed synchronously at second swap time
            expect(destroy1).toHaveBeenCalledTimes(1);
            // client2 is now the pending client, not yet destroyed
            expect(destroy2).not.toHaveBeenCalled();
        });

        test('after 3 rapid swaps (all within grace window), client1 and client2 are destroyed before final timer fires', () => {
            const destroy1 = mock(() => {});
            const destroy2 = mock(() => {});
            const destroy3 = mock(() => {});
            const client1  = makeStubClient(destroy1);
            const client2  = makeStubClient(destroy2);
            const client3  = makeStubClient(destroy3);
            const client4  = makeStubClient();
            const holder   = new DynamoDBClientHolder(client1, makeStubDocClient());

            // Swap 1: client1 enters grace period
            holder.swap(client2, makeStubDocClient());
            expect(destroy1).not.toHaveBeenCalled();

            // Swap 2: client1 must be destroyed eagerly; client2 enters grace period
            holder.swap(client3, makeStubDocClient());
            expect(destroy1).toHaveBeenCalledTimes(1);
            expect(destroy2).not.toHaveBeenCalled();

            // Swap 3: client2 must be destroyed eagerly; client3 enters grace period
            holder.swap(client4, makeStubDocClient());
            expect(destroy1).toHaveBeenCalledTimes(1); // unchanged
            expect(destroy2).toHaveBeenCalledTimes(1);
            expect(destroy3).not.toHaveBeenCalled();

            // client3's grace timer fires
            jest.advanceTimersByTime(5001);
            expect(destroy3).toHaveBeenCalledTimes(1);
        });
    });

    describe('holder destroy()', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            jest.setSystemTime(0);
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('should destroy the current client synchronously when holder.destroy() is called', () => {
            const destroyMock = mock(() => {});
            const client    = makeStubClient(destroyMock);
            const docClient = makeStubDocClient();
            const holder    = new DynamoDBClientHolder(client, docClient);

            holder.destroy();

            expect(destroyMock).toHaveBeenCalledTimes(1);
        });

        test('should cancel any pending grace timer and destroy the previous client when holder.destroy() is called', () => {
            const oldDestroy = mock(() => {});
            const oldClient  = makeStubClient(oldDestroy);
            const newDestroy = mock(() => {});
            const newClient  = makeStubClient(newDestroy);
            const holder     = new DynamoDBClientHolder(oldClient, makeStubDocClient());

            // Swap: oldClient goes into grace period
            holder.swap(newClient, makeStubDocClient());

            expect(oldDestroy).not.toHaveBeenCalled();

            // holder.destroy() should synchronously cancel the pending timer and destroy both
            holder.destroy();

            // Both the current client and the old-client-under-grace must be destroyed
            expect(oldDestroy).toHaveBeenCalledTimes(1);
            expect(newDestroy).toHaveBeenCalledTimes(1);

            // Advancing past the grace period should NOT trigger another destroy
            jest.advanceTimersByTime(5001);
            expect(oldDestroy).toHaveBeenCalledTimes(1);
        });

        test('should not throw when holder.destroy() is called with no pending grace timer', () => {
            const holder = new DynamoDBClientHolder(makeStubClient(), makeStubDocClient());

            expect(() => holder.destroy()).not.toThrow();
        });
    });
});

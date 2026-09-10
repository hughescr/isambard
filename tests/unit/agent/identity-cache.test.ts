import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { IdentityCache } from '@/agent/identity-cache';

describe('IdentityCache', () => {
    let loaderMock: ReturnType<typeof mock>;

    beforeEach(() => {
        loaderMock = mock(async (): Promise<string> => 'identity text');
    });

    afterEach(() => {
        mock.restore();
    });

    describe('get()', () => {
        test('cold start — first call invokes loader exactly once', async () => {
            const cache = new IdentityCache(loaderMock);

            const result = await cache.get();

            expect(result).toBe('identity text');
            expect(loaderMock).toHaveBeenCalledTimes(1);
        });

        test('warm hit — second call returns cached value without invoking loader again', async () => {
            const cache = new IdentityCache(loaderMock);

            await cache.get();
            const result = await cache.get();

            expect(result).toBe('identity text');
            expect(loaderMock).toHaveBeenCalledTimes(1);
        });

        test('concurrent in-flight gets share the same loader invocation', async () => {
            let resolveLoader!: (value: string) => void;
            const controlled = mock((): Promise<string> => new Promise<string>((resolve) => {
                resolveLoader = resolve;
            }));
            const cache = new IdentityCache(controlled);

            // Issue two concurrent gets before the loader resolves
            const p1 = cache.get();
            const p2 = cache.get();

            // Resolve the loader
            resolveLoader('shared identity');

            const [r1, r2] = await Promise.all([p1, p2]);

            expect(r1).toBe('shared identity');
            expect(r2).toBe('shared identity');
            // Loader must have been called exactly once
            expect(controlled).toHaveBeenCalledTimes(1);
        });

        test('loader rejection — cache is not populated and next get() retries', async () => {
            let callCount = 0;
            const failThenSucceed = mock(async (): Promise<string> => {
                callCount++;
                if(callCount === 1) {
                    throw new Error('transient failure');
                }
                return 'recovered identity';
            });
            const cache = new IdentityCache(failThenSucceed);

            // First get() should throw
            expect(cache.get()).rejects.toThrow('transient failure');

            // Wait for the rejection to settle
            await Promise.resolve();
            await Promise.resolve();

            // Second get() should retry the loader and succeed
            const result = await cache.get();
            expect(result).toBe('recovered identity');
            expect(callCount).toBe(2);
        });
    });

    describe('invalidate()', () => {
        test('clears the cache so the next get() re-invokes the loader', async () => {
            loaderMock
                .mockImplementationOnce(async () => 'first identity')
                .mockImplementationOnce(async () => 'second identity');
            const cache = new IdentityCache(loaderMock);

            await cache.get();
            cache.invalidate();
            const result = await cache.get();

            expect(result).toBe('second identity');
            expect(loaderMock).toHaveBeenCalledTimes(2);
        });

        test('idempotent — calling invalidate twice is the same as once', async () => {
            const cache = new IdentityCache(loaderMock);

            await cache.get();
            cache.invalidate();
            cache.invalidate(); // second call should not cause extra load

            await cache.get();

            expect(loaderMock).toHaveBeenCalledTimes(2);
        });

        test('no-op when cache is already empty', async () => {
            const cache = new IdentityCache(loaderMock);

            // Should not throw
            cache.invalidate();

            const result = await cache.get();
            expect(result).toBe('identity text');
            expect(loaderMock).toHaveBeenCalledTimes(1);
        });

        test('no-op when neither cached nor inflight — still increments generation cleanly', () => {
            const cache = new IdentityCache(loaderMock);

            // Should not throw on a brand-new cache with nothing loaded
            expect(() => cache.invalidate()).not.toThrow();
            // Should also be safe to call multiple times
            expect(() => cache.invalidate()).not.toThrow();
            // Loader has never been called
            expect(loaderMock).not.toHaveBeenCalled();
        });

        test('invalidate during in-flight load → in-flight caller resolves with old value; next get() triggers fresh load', async () => {
            let resolveFirst!: (value: string) => void;
            let resolveSecond!: (value: string) => void;
            let callCount = 0;
            const controlled = mock((): Promise<string> => {
                callCount++;
                if(callCount === 1) {
                    return new Promise<string>((resolve) => {
                        resolveFirst = resolve;
                    });
                }
                return new Promise<string>((resolve) => {
                    resolveSecond = resolve;
                });
            });

            const cache = new IdentityCache(controlled);

            // Start first load — loader is called once
            const inflightPromise = cache.get();
            expect(controlled).toHaveBeenCalledTimes(1);

            // Invalidate while load is still in flight
            cache.invalidate();

            // Resolve the in-flight load with the "old" value
            resolveFirst('old value');

            // The in-flight caller SHOULD still see the old value (allowed staleness)
            const inflightResult = await inflightPromise;
            expect(inflightResult).toBe('old value');

            // The cache slot must NOT have been populated with the stale value
            // because invalidate fired during the load. The next get() must
            // trigger a second load.
            const secondGetPromise = cache.get();
            expect(controlled).toHaveBeenCalledTimes(2);

            resolveSecond('fresh value');
            const secondResult = await secondGetPromise;
            expect(secondResult).toBe('fresh value');
        });
    });

    describe('set()', () => {
        test('stores a value without invoking the loader', async () => {
            const cache = new IdentityCache(loaderMock);

            cache.set('preset identity');
            const result = await cache.get();

            expect(result).toBe('preset identity');
            expect(loaderMock).not.toHaveBeenCalled();
        });

        test('get() after set() returns the set value', async () => {
            const cache = new IdentityCache(loaderMock);

            cache.set('first');
            const r1 = await cache.get();

            cache.set('second');
            const r2 = await cache.get();

            expect(r1).toBe('first');
            expect(r2).toBe('second');
            expect(loaderMock).not.toHaveBeenCalled();
        });

        test('invalidate after set causes next get() to use loader', async () => {
            const cache = new IdentityCache(loaderMock);

            cache.set('preset identity');
            cache.invalidate();

            const result = await cache.get();

            expect(result).toBe('identity text');
            expect(loaderMock).toHaveBeenCalledTimes(1);
        });

        test('set() during in-flight load wins — the in-flight result does not overwrite the set value', async () => {
            let resolveLoader!: (value: string) => void;
            const controlled = mock((): Promise<string> => new Promise<string>((resolve) => {
                resolveLoader = resolve;
            }));

            const cache = new IdentityCache(controlled);

            // Start a load
            const inflightPromise = cache.get();
            expect(controlled).toHaveBeenCalledTimes(1);

            // While load is in flight, set a newer value directly
            cache.set('pushed value');

            // Resolve the in-flight load with a different value
            resolveLoader('stale loaded value');

            // The in-flight caller gets what the loader returned
            const inflightResult = await inflightPromise;
            expect(inflightResult).toBe('stale loaded value');

            // But the cache should now hold the set() value, not the stale loaded one
            // (get() returns cached, no second load needed)
            const afterResult = await cache.get();
            expect(afterResult).toBe('pushed value');
            expect(controlled).toHaveBeenCalledTimes(1);
        });
    });

    describe('onChange()', () => {
        test('a registered listener fires on invalidate()', () => {
            const cache = new IdentityCache(loaderMock);
            const listener = mock(() => undefined);
            cache.onChange(listener);

            cache.invalidate();

            expect(listener).toHaveBeenCalledTimes(1);
        });

        test('a registered listener fires on set()', () => {
            const cache = new IdentityCache(loaderMock);
            const listener = mock(() => undefined);
            cache.onChange(listener);

            cache.set('new identity');

            expect(listener).toHaveBeenCalledTimes(1);
        });

        test('every registered listener fires, not just the first', () => {
            const cache = new IdentityCache(loaderMock);
            const first = mock(() => undefined);
            const second = mock(() => undefined);
            cache.onChange(first);
            cache.onChange(second);

            cache.invalidate();

            expect(first).toHaveBeenCalledTimes(1);
            expect(second).toHaveBeenCalledTimes(1);
        });

        test('the returned unsubscribe stops further notifications for that listener alone', () => {
            const cache = new IdentityCache(loaderMock);
            const kept = mock(() => undefined);
            const dropped = mock(() => undefined);
            cache.onChange(kept);
            const unsubscribe = cache.onChange(dropped);

            unsubscribe();
            cache.invalidate();

            expect(dropped).not.toHaveBeenCalled();
            expect(kept).toHaveBeenCalledTimes(1);
        });

        test('a plain get() notifies nobody — only an actual change does', async () => {
            const cache = new IdentityCache(loaderMock);
            const listener = mock(() => undefined);
            cache.onChange(listener);

            await cache.get();
            await cache.get();

            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe('revision()', () => {
        test('advances on invalidate() and on set(), but never on get()', async () => {
            const cache = new IdentityCache(loaderMock);
            const start = cache.revision();

            await cache.get();
            expect(cache.revision()).toBe(start);

            cache.invalidate();
            const afterInvalidate = cache.revision();
            expect(afterInvalidate).not.toBe(start);

            cache.set('pushed');
            expect(cache.revision()).not.toBe(afterInvalidate);
        });
    });

    describe('invalidate() clears the in-flight slot', () => {
        test('a get() issued after invalidate() starts a FRESH load rather than joining the pre-write one', async () => {
            const resolvers: ((value: string) => void)[] = [];
            const controlled = mock((): Promise<string> => new Promise<string>((resolve) => {
                resolvers.push(resolve);
            }));
            const cache = new IdentityCache(controlled);

            const stale = cache.get();
            expect(controlled).toHaveBeenCalledTimes(1);

            cache.invalidate();
            const fresh = cache.get();
            expect(controlled).toHaveBeenCalledTimes(2);

            resolvers[0]('pre-write identity');
            resolvers[1]('post-write identity');

            expect(await stale).toBe('pre-write identity');
            expect(await fresh).toBe('post-write identity');
            // The fresh load's value is what got committed, so no third load is needed.
            expect(await cache.get()).toBe('post-write identity');
            expect(controlled).toHaveBeenCalledTimes(2);
        });

        test('a stale load settling after an invalidate() does not clear the newer in-flight slot', async () => {
            const resolvers: ((value: string) => void)[] = [];
            const controlled = mock((): Promise<string> => new Promise<string>((resolve) => {
                resolvers.push(resolve);
            }));
            const cache = new IdentityCache(controlled);

            const stale = cache.get();
            cache.invalidate();
            const fresh = cache.get();
            expect(controlled).toHaveBeenCalledTimes(2);

            // The superseded load settles LAST-but-one; it must neither commit its value nor
            // release the in-flight slot the newer load owns.
            resolvers[0]('pre-write identity');
            expect(await stale).toBe('pre-write identity');

            const joiner = cache.get();
            expect(controlled).toHaveBeenCalledTimes(2);

            resolvers[1]('post-write identity');
            expect(await fresh).toBe('post-write identity');
            expect(await joiner).toBe('post-write identity');
        });

        test('a stale load REJECTING after an invalidate() does not clear the newer in-flight slot', async () => {
            const rejecters: ((error: Error) => void)[] = [];
            const controlled = mock((): Promise<string> => new Promise<string>((_resolve, reject) => {
                rejecters.push(reject);
            }));
            const cache = new IdentityCache(controlled);

            const stale = cache.get();
            // Bun's `expect(promise).rejects` must be created AFTER the promise has already
            // settled — creating it against a still-pending promise deadlocks the test runner.
            // Pre-attach a plain `.catch` so the gap before the real assertion below doesn't
            // trip an unhandled-rejection warning.
            stale.catch(() => undefined);
            cache.invalidate();
            const fresh = cache.get();
            fresh.catch(() => undefined);
            expect(controlled).toHaveBeenCalledTimes(2);

            // The superseded load rejects after the invalidate(); its catch handler must not
            // release the in-flight slot the newer (fresh) load now owns.
            rejecters[0](new Error('stale loader failure'));
            await Promise.resolve();
            await Promise.resolve();
            await expect(stale).rejects.toThrow('stale loader failure');

            // If the generation guard were bypassed, this would clear the fresh in-flight slot
            // and trigger a THIRD loader call instead of joining the still-pending fresh load.
            const joiner = cache.get();
            joiner.catch(() => undefined);
            expect(controlled).toHaveBeenCalledTimes(2);

            rejecters[1](new Error('fresh loader failure'));
            await Promise.resolve();
            await Promise.resolve();
            await expect(fresh).rejects.toThrow('fresh loader failure');
            await expect(joiner).rejects.toThrow('fresh loader failure');
        });
    });
});

import { InvariantViolationError } from '@/errors';

/** Run independent work with a fixed number of in-flight operations, retaining input order. */
export async function mapBounded<T, R>(
    items: readonly T[],
    concurrency: number,
    map: (item: T, index: number) => Promise<R>,
    options?: { drainOnError?: boolean }
): Promise<R[]> {
    const results: R[] = [];
    let nextIndex = 0;
    const abort = new AbortController();

    const worker = async (): Promise<void> => {
        if(abort.signal.aborted) {
            return;
        }
        const index = nextIndex++;
        if(index >= items.length) {
            return;
        }
        try {
            const item = items[index];
            if(item === undefined) {
                throw new InvariantViolationError('mapBounded', `missing item at index ${index}`);
            }
            results[index] = await map(item, index);
        } catch (error) {
            abort.abort(error);
            throw error;
        }
        await worker();
    };

    // Stryker disable next-line llm: the forms differ only for empty input, where the extra worker returns before mapping or writing results.
    const workers = Array.from(
        { length: Math.min(Math.max(1, concurrency), items.length) },
        () => worker()
    );
    if(options?.drainOnError) {
        // A failed write stops new admissions, but callers must not observe completion
        // while already admitted writes are still changing external state.
        await Promise.allSettled(workers);
        if(abort.signal.aborted) {
            throw abort.signal.reason;
        }
    } else {
        await Promise.all(workers);
    }
    return results;
}

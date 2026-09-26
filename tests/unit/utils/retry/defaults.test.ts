import { afterEach, expect, jest, test } from 'bun:test';
import { setupRetryContext } from '@/utils/retry/defaults';

afterEach(() => {
    jest.useRealTimers();
});

test('default retry sleep resolves after its timer fires', async () => {
    jest.useFakeTimers();
    const { deps } = setupRetryContext({}, {});
    const outcome = deps.sleep(1);
    jest.advanceTimersByTime(1);

    await expect(outcome).resolves.toBeUndefined();
});

import { expect, test } from 'bun:test';
import { setupRetryContext } from '@/utils/retry/defaults';

test('default retry sleep resolves after its timer fires', async () => {
    const { deps } = setupRetryContext({}, {});
    const outcome = await Promise.race([
        deps.sleep(1).then(() => 'resolved'),
        Bun.sleep(100).then(() => 'timed out'),
    ]);

    expect(outcome).toBe('resolved');
});

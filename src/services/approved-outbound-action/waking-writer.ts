import type { ApprovedOutboundActionWriter } from './types';

/**
 * Wrap an action writer so every successfully persisted approval wakes the executor, which then
 * sends within seconds instead of waiting up to its 5-minute backoff. The wake happens only
 * after the durable write resolves; a failed write propagates and wakes nothing. The approval
 * code sees a plain {@link ApprovedOutboundActionWriter} and never learns about the executor.
 */
export function createWakingActionWriter(writer: ApprovedOutboundActionWriter, wake: () => void): ApprovedOutboundActionWriter {
    return {
        async create(action) {
            await writer.create(action);
            wake();
        },
    };
}

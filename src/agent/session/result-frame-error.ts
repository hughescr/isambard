/**
 * Adapts a `result` frame's failure shape to the `Error & { status?: number }` shape
 * {@link classifyClaudeError} (src/agent/claude-retry.ts) classifies: `success` with `is_error`
 * carries the API error text in `result` and an optional HTTP-like status in `api_error_status`;
 * the error subtypes (`error_during_execution`, `error_max_turns`, ...) carry no status at all —
 * `classifyClaudeError` falls through to its message-based network check and then to `permanent`
 * for those.
 *
 * @module agent/session/result-frame-error
 */
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Converts `frame` into the error shape the conductor feeds to `classifyClaudeError` when
 * deciding whether an `is_error` result is worth resubmitting.
 */
export function resultFrameToError(frame: SDKResultMessage): Error & { status?: number } {
    if(frame.subtype === 'success') {
        return Object.assign(new Error(frame.result), { status: frame.api_error_status ?? undefined });
    }
    return new Error(frame.errors.join('; ') || frame.subtype);
}

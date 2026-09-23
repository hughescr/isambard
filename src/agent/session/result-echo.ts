/**
 * Which host-pushed user messages a `result` frame answers. The Agent SDK echoes the client
 * `uuid` stamped on an {@link import('@anthropic-ai/claude-agent-sdk').SDKUserMessage} back on
 * the result it causes: `user_message_uuids` lists every message the turn consumed (always
 * including `user_message_uuid`), and older producers send only the singular field. A result
 * the CLI started on its own (a task-notification wake, a peer message) carries neither.
 *
 * {@link import('./input-queue').InputQueue} stamps a fresh uuid on every push, which is what makes
 * this echo usable: SDK 0.3.280 answers every `shouldQuery:false` message with its own bare
 * result (verified on the real CLI, 2026-09-22), and the echo is the only field that tells that
 * acknowledgement apart from a real turn's result — a `/compact` result has the same
 * `num_turns: 0` and empty `result`.
 *
 * @module agent/session/result-echo
 */
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * The client uuids `frame` echoes, oldest first.
 * @param frame A `result` frame
 * @returns `user_message_uuids` when present, else `[user_message_uuid]` when that is present, else `[]`
 */
export function echoedUserMessageUuids(frame: SDKResultMessage): readonly string[] {
    return frame.user_message_uuids ?? (frame.user_message_uuid === undefined ? [] : [frame.user_message_uuid]);
}

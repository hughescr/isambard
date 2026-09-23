/**
 * Tests for {@link echoedUserMessageUuids}: which host-stamped user messages a `result` frame
 * says caused it (SDK 0.3.280 `user_message_uuids`, falling back to `user_message_uuid`).
 */
import { describe, expect, it } from 'bun:test';
import * as frames from '../../../helpers/sdk-frames';
import { echoedUserMessageUuids } from '@/agent/session/result-echo';

describe('echoedUserMessageUuids', () => {
    it('returns user_message_uuids when the frame carries the list', () => {
        const frame = frames.resultSuccess({ user_message_uuid: 'b', user_message_uuids: ['a', 'b'] });

        expect(echoedUserMessageUuids(frame)).toEqual(['a', 'b']);
    });

    it('falls back to the singular user_message_uuid when the list is absent (older producers)', () => {
        const frame = frames.resultSuccess({ user_message_uuid: 'only' });

        expect(echoedUserMessageUuids(frame)).toEqual(['only']);
    });

    it('returns an empty list when the frame echoes nothing (a CLI-started turn, or an unstamped message)', () => {
        expect(echoedUserMessageUuids(frames.resultSuccess())).toEqual([]);
    });

    it('reads an error result the same way', () => {
        const frame = frames.resultInterrupted({ user_message_uuid: 'err', user_message_uuids: ['err'] });

        expect(echoedUserMessageUuids(frame)).toEqual(['err']);
    });
});

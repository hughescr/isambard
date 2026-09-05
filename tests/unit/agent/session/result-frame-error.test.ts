/**
 * Table-driven tests for {@link resultFrameToError}: every case feeds its output straight into
 * the REAL {@link classifyClaudeError} (no fake classifier), so this pins the adapter's shape
 * (message + optional `status`) against the classifier it must satisfy, per the design doc's
 * result-frame -> error -> classification table.
 */
import { describe, expect, it } from 'bun:test';
import * as frames from '../../../helpers/sdk-frames';
import { classifyClaudeError } from '@/agent/claude-retry';
import { resultFrameToError } from '@/agent/session/result-frame-error';

describe('resultFrameToError', () => {
    it('success + is_error with api_error_status 529 classifies transient', () => {
        const frame = frames.resultSuccess({ is_error: true, result: 'overloaded', api_error_status: 529 });

        const error = resultFrameToError(frame);

        expect(error.message).toBe('overloaded');
        expect(error.status).toBe(529);
        expect(classifyClaudeError(error).category).toBe('transient');
    });

    it('success + is_error with api_error_status 503 classifies transient', () => {
        const frame = frames.resultSuccess({ is_error: true, result: 'unavailable', api_error_status: 503 });

        const error = resultFrameToError(frame);

        expect(classifyClaudeError(error).category).toBe('transient');
    });

    it('success + is_error with api_error_status 429 classifies rate_limited', () => {
        const frame = frames.resultSuccess({ is_error: true, result: 'slow down', api_error_status: 429 });

        const error = resultFrameToError(frame);

        expect(classifyClaudeError(error).category).toBe('rate_limited');
    });

    it('success + is_error with api_error_status 400 classifies permanent', () => {
        const frame = frames.resultSuccess({ is_error: true, result: 'bad request', api_error_status: 400 });

        const error = resultFrameToError(frame);

        expect(classifyClaudeError(error).category).toBe('permanent');
    });

    it('success + is_error with api_error_status null classifies permanent', () => {
        const frame = frames.resultSuccess({ is_error: true, result: 'mystery', api_error_status: null });

        const error = resultFrameToError(frame);

        expect(error.status).toBeUndefined();
        expect(classifyClaudeError(error).category).toBe('permanent');
    });

    it('success + is_error with api_error_status absent classifies permanent', () => {
        const frame = frames.resultSuccess({ is_error: true, result: 'mystery' });
        delete (frame as { api_error_status?: number | null }).api_error_status;

        const error = resultFrameToError(frame);

        expect(classifyClaudeError(error).category).toBe('permanent');
    });

    it('error_during_execution with an ECONNRESET-style message classifies transient', () => {
        const frame = frames.resultInterrupted({ errors: ['ECONNRESET: connection reset by peer'] });

        const error = resultFrameToError(frame);

        expect(error.message).toBe('ECONNRESET: connection reset by peer');
        expect(error.status).toBeUndefined();
        expect(classifyClaudeError(error).category).toBe('transient');
    });

    it('multiple errors join with "; " and classify permanent when nothing else matches', () => {
        const frame = frames.resultInterrupted({ errors: ['x', 'y'] });

        const error = resultFrameToError(frame);

        expect(error.message).toBe('x; y');
        expect(classifyClaudeError(error).category).toBe('permanent');
    });

    it('an empty errors array falls back to the subtype as the message', () => {
        const frame = frames.resultInterrupted({ errors: [] });

        const error = resultFrameToError(frame);

        expect(error.message).toBe(frame.subtype);
    });
});

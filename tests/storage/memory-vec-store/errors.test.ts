/**
 * Tests for memory-vec-store/errors.ts — VectorIndex error hierarchy
 */
import { describe, expect, it } from 'bun:test';
import { ErrorCode } from '@/errors/codes';
import { StorageError } from '@/errors/storage';
import {
    VectorIndexClosedError,
    VectorIndexError,
    VectorIndexUnavailableError
} from '@/storage/memory-vec-store/errors';

describe('VectorIndexError', () => {
    it('is an instance of StorageError', () => {
        const err = new VectorIndexError('test error');
        expect(err).toBeInstanceOf(StorageError);
    });

    it('is an instance of Error', () => {
        const err = new VectorIndexError('test error');
        expect(err).toBeInstanceOf(Error);
    });

    it('has name VectorIndexError', () => {
        const err = new VectorIndexError('test error');
        expect(err.name).toBe('VectorIndexError');
    });

    it('has the provided message', () => {
        const err = new VectorIndexError('something went wrong');
        expect(err.message).toBe('something went wrong');
    });

    it('uses VECTOR_INDEX_ERROR as default code', () => {
        const err = new VectorIndexError('test');
        expect(err.code).toBe(ErrorCode.VECTOR_INDEX_ERROR);
    });

    it('accepts an explicit error code', () => {
        const err = new VectorIndexError('test', ErrorCode.VECTOR_INDEX_CLOSED);
        expect(err.code).toBe(ErrorCode.VECTOR_INDEX_CLOSED);
    });
});

describe('VectorIndexClosedError', () => {
    it('is an instance of VectorIndexError', () => {
        const err = new VectorIndexClosedError();
        expect(err).toBeInstanceOf(VectorIndexError);
    });

    it('is an instance of StorageError', () => {
        const err = new VectorIndexClosedError();
        expect(err).toBeInstanceOf(StorageError);
    });

    it('has name VectorIndexClosedError', () => {
        const err = new VectorIndexClosedError();
        expect(err.name).toBe('VectorIndexClosedError');
    });

    it('has error code VECTOR_INDEX_CLOSED', () => {
        const err = new VectorIndexClosedError();
        expect(err.code).toBe(ErrorCode.VECTOR_INDEX_CLOSED);
    });

    it('has a descriptive message containing "closed"', () => {
        const err = new VectorIndexClosedError();
        expect(err.message.toLowerCase()).toContain('closed');
    });
});

describe('VectorIndexUnavailableError', () => {
    it('is an instance of VectorIndexError', () => {
        const err = new VectorIndexUnavailableError('extension load failed');
        expect(err).toBeInstanceOf(VectorIndexError);
    });

    it('is an instance of StorageError', () => {
        const err = new VectorIndexUnavailableError('extension load failed');
        expect(err).toBeInstanceOf(StorageError);
    });

    it('has name VectorIndexUnavailableError', () => {
        const err = new VectorIndexUnavailableError('extension load failed');
        expect(err.name).toBe('VectorIndexUnavailableError');
    });

    it('has error code VECTOR_INDEX_UNAVAILABLE', () => {
        const err = new VectorIndexUnavailableError('extension load failed');
        expect(err.code).toBe(ErrorCode.VECTOR_INDEX_UNAVAILABLE);
    });

    it('includes the reason in the message', () => {
        const err = new VectorIndexUnavailableError('sqlite-vec not found');
        expect(err.message).toContain('sqlite-vec not found');
    });

    it('includes context with the reason', () => {
        const err = new VectorIndexUnavailableError('extension load failed');
        expect((err.context as Record<string, unknown>).reason).toBe('extension load failed');
    });

    it('has a non-empty message', () => {
        const err = new VectorIndexUnavailableError('some reason');
        expect(err.message.length).toBeGreaterThan(0);
    });
});

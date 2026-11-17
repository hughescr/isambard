import { describe, test, expect } from 'bun:test';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';
import { StorageError } from '@/errors/storage';
import { VectorCrossCheckError, VectorIndexError } from '@/errors/vector-index';

describe('VectorCrossCheckError', () => {
    test.each([
        'mass_absence' as const,
        'unprocessed_keys_exhausted' as const,
        'requeue_not_converged' as const,
    ])('is a VectorIndexError carrying its own code and the %s reason', (reason) => {
        const error = new VectorCrossCheckError('cross-check failed', reason);
        expect(error).toBeInstanceOf(VectorCrossCheckError);
        expect(error).toBeInstanceOf(VectorIndexError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error.name).toBe('VectorCrossCheckError');
        expect(error.code).toBe(ErrorCode.VECTOR_CROSS_CHECK_ERROR);
        expect(error.message).toBe('cross-check failed');
        expect(error.context).toEqual({ reason });
    });
});

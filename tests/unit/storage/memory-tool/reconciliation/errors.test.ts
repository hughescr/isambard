import { describe, expect, test } from 'bun:test';
import {
    ReconciliationError,
    ReconciliationThrottledError
} from '@/storage/memory-tool/reconciliation/errors';

describe.concurrent('Reconciliation Errors', () => {
    describe('ReconciliationError', () => {
        test('should be an instance of ReconciliationError and Error', () => {
            const error = new ReconciliationError('Test error', 'TEST_ERROR');
            expect(error).toBeInstanceOf(ReconciliationError);
            expect(error).toBeInstanceOf(Error);
        });

        test('should have correct name', () => {
            const error = new ReconciliationError('Test error', 'TEST_ERROR');
            expect(error.name).toBe('ReconciliationError');
        });

        test('should have correct message', () => {
            const error = new ReconciliationError('Test error', 'TEST_ERROR');
            expect(error.message).toBe('Test error');
        });

        test('should have correct code', () => {
            const error = new ReconciliationError('Test error', 'TEST_ERROR');
            expect(error.code).toBe('TEST_ERROR');
        });

        test('should preserve stack trace', () => {
            const error = new ReconciliationError('Test error', 'TEST_ERROR');
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('ReconciliationError');
        });

        test('should handle different error codes', () => {
            const codes = ['RECONCILIATION_ERROR', 'PHASE_A_FAILED', 'PHASE_B_FAILED'];
            for(const code of codes) {
                const error = new ReconciliationError('Test error', code);
                expect(error.code).toBe(code);
            }
        });
    });

    describe('ReconciliationThrottledError', () => {
        test('should be an instance of ReconciliationThrottledError and ReconciliationError', () => {
            const error = new ReconciliationThrottledError('scan');
            expect(error).toBeInstanceOf(ReconciliationThrottledError);
            expect(error).toBeInstanceOf(ReconciliationError);
            expect(error).toBeInstanceOf(Error);
        });

        test('should have correct name', () => {
            const error = new ReconciliationThrottledError('scan');
            expect(error.name).toBe('ReconciliationThrottledError');
        });

        test('should have correct message format', () => {
            const operation = 'scan';
            const error = new ReconciliationThrottledError(operation);
            expect(error.message).toBe(`Reconciliation throttled during ${operation}`);
        });

        test('should have correct code', () => {
            const error = new ReconciliationThrottledError('scan');
            expect(error.code).toBe('RECONCILIATION_THROTTLED');
        });

        test('should store operation property', () => {
            const operation = 'putItem';
            const error = new ReconciliationThrottledError(operation);
            expect(error.operation).toBe(operation);
        });

        test('should handle different operation types', () => {
            const operations = ['scan', 'putItem', 'deleteItem', 'batchWrite'];
            for(const operation of operations) {
                const error = new ReconciliationThrottledError(operation);
                expect(error.operation).toBe(operation);
                expect(error.message).toContain(operation);
            }
        });

        test('should preserve stack trace', () => {
            const error = new ReconciliationThrottledError('scan');
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('ReconciliationThrottledError');
        });
    });
});

import { describe, test, expect, spyOn, beforeEach, afterEach, jest } from 'bun:test';
import { mockLogger } from '../../setup';
import * as errorBoundaryModule from '@/services/error-boundary';

describe('registerErrorBoundaries', () => {
    let spies: ReturnType<typeof spyOn>[];
    let processOnSpy: ReturnType<typeof spyOn>;
    let processRemoveListenerSpy: ReturnType<typeof spyOn>;
    let processExitSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        jest.useFakeTimers();
        spies = [];
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();

        // Spy on process.on to capture handlers without touching real process
        processOnSpy = spyOn(process, 'on');
        spies.push(processOnSpy);

        processRemoveListenerSpy = spyOn(process, 'removeListener');
        spies.push(processRemoveListenerSpy);

        // Spy on process.exit to prevent actual exit
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- process.exit spy requires casting
        processExitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as any);
        spies.push(processExitSpy);
    });

    afterEach(() => {
        jest.useRealTimers();
        for(const spy of spies) {
            try {
                spy.mockRestore();
            } catch{
                // ignore
            }
        }
        spies.length = 0;
    });

    test('should register unhandledRejection handler on process', () => {
        errorBoundaryModule.registerErrorBoundaries(mockLogger);

        const events = (processOnSpy.mock.calls as [string, unknown][]).map(([event]) => event);
        expect(events).toContain('unhandledRejection');
    });

    test('should register uncaughtException handler on process', () => {
        errorBoundaryModule.registerErrorBoundaries(mockLogger);

        const events = (processOnSpy.mock.calls as [string, unknown][]).map(([event]) => event);
        expect(events).toContain('uncaughtException');
    });

    test('should log unhandledRejection with structured context', () => {
        errorBoundaryModule.registerErrorBoundaries(mockLogger);

        const calls = processOnSpy.mock.calls as [string, (...args: unknown[]) => void][];
        const rejectionCall = calls.find(([event]) => event === 'unhandledRejection');
        expect(rejectionCall).toBeDefined();

        const handler = rejectionCall![1];
        const testError = new Error('test rejection error');
        handler(testError, Promise.resolve());

        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        const [logObj, msg] = mockLogger.error.mock.calls[0] as [Record<string, unknown>, string];
        expect(logObj).toHaveProperty('reason');
        expect(msg).toMatch(/unhandledRejection/i);
    });

    test('should log uncaughtException with structured context', () => {
        errorBoundaryModule.registerErrorBoundaries(mockLogger);

        const calls = processOnSpy.mock.calls as [string, (...args: unknown[]) => void][];
        const exceptionCall = calls.find(([event]) => event === 'uncaughtException');
        expect(exceptionCall).toBeDefined();

        const handler = exceptionCall![1];
        const testError = new Error('test uncaught error');
        handler(testError);

        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        const [logObj, msg] = mockLogger.error.mock.calls[0] as [Record<string, unknown>, string];
        expect(logObj).toHaveProperty('err');
        expect(msg).toMatch(/uncaughtException/i);
    });

    test('should log unhandledRejection when reason is not an Error', () => {
        errorBoundaryModule.registerErrorBoundaries(mockLogger);

        const calls = processOnSpy.mock.calls as [string, (...args: unknown[]) => void][];
        const rejectionCall = calls.find(([event]) => event === 'unhandledRejection');
        const handler = rejectionCall![1];

        handler('string rejection reason', Promise.resolve());

        expect(mockLogger.error).toHaveBeenCalledTimes(1);
        const [logObj] = mockLogger.error.mock.calls[0] as [Record<string, unknown>, string];
        expect(logObj).toHaveProperty('reason');
    });

    test('should call process.exit(1) after logging uncaughtException', () => {
        errorBoundaryModule.registerErrorBoundaries(mockLogger);

        const calls = processOnSpy.mock.calls as [string, (...args: unknown[]) => void][];
        const exceptionCall = calls.find(([event]) => event === 'uncaughtException');
        const handler = exceptionCall![1];

        handler(new Error('fatal'));

        expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    test('should call process.exit(1) AFTER logging (not before)', () => {
        errorBoundaryModule.registerErrorBoundaries(mockLogger);

        const calls = processOnSpy.mock.calls as [string, (...args: unknown[]) => void][];
        const exceptionCall = calls.find(([event]) => event === 'uncaughtException');
        const handler = exceptionCall![1];

        const callOrder: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock implementation return type mismatch is acceptable in test context
        (mockLogger.error as any).mockImplementation(() => {
            callOrder.push('log');
        });
        const exitMockImpl = () => {
            callOrder.push('exit');
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- process.exit returns never; mock implementation doesn't need to
        processExitSpy.mockImplementation(exitMockImpl as any);

        handler(new Error('fatal'));

        expect(callOrder).toEqual(['log', 'exit']);
    });

    test('should not call process.exit after unhandledRejection (only after uncaughtException)', () => {
        errorBoundaryModule.registerErrorBoundaries(mockLogger);

        const calls = processOnSpy.mock.calls as [string, (...args: unknown[]) => void][];
        const rejectionCall = calls.find(([event]) => event === 'unhandledRejection');
        const handler = rejectionCall![1];

        handler(new Error('rejected promise'), Promise.resolve());

        expect(processExitSpy).not.toHaveBeenCalled();
    });

    test('should return an object with unregister function', () => {
        const result = errorBoundaryModule.registerErrorBoundaries(mockLogger);

        expect(result).toBeDefined();
        expect(typeof result.unregister).toBe('function');
    });

    test('unregister should remove both handlers from process', () => {
        const { unregister } = errorBoundaryModule.registerErrorBoundaries(mockLogger);

        unregister();

        // Should have called removeListener for both event types
        const removedEvents = (processRemoveListenerSpy.mock.calls as [string, unknown][]).map(([event]) => event);
        expect(removedEvents).toContain('unhandledRejection');
        expect(removedEvents).toContain('uncaughtException');
    });

    test('should register exactly one handler per event per call', () => {
        errorBoundaryModule.registerErrorBoundaries(mockLogger);

        const events = (processOnSpy.mock.calls as [string, unknown][]).map(([event]) => event);
        const rejectionCount = events.filter(e => e === 'unhandledRejection').length;
        const exceptionCount = events.filter(e => e === 'uncaughtException').length;
        expect(rejectionCount).toBe(1);
        expect(exceptionCount).toBe(1);
    });
});

/**
 * Channel Registry Error Classes Tests
 *
 * Tests for hierarchical error classes for channel registry operations.
 * Verifies error construction, messages, codes, and inheritance.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import {
    ChannelRegistryError,
    ChannelNotFoundError,
    AmbiguousChannelError,
    WellKnownChannelNotFoundError
} from '@/integrations/discord/channel-registry/errors';

describe('ChannelRegistryError', () => {
    it('should construct with message and code', () => {
        const error = new ChannelRegistryError('Test error', 'TEST_CODE');
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(ChannelRegistryError);
        expect(error.message).toBe('Test error');
        expect(error.code).toBe('TEST_CODE');
        expect(error.name).toBe('ChannelRegistryError');
    });

    it('should capture stack trace', () => {
        const error = new ChannelRegistryError('Test error', 'TEST_CODE');
        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('ChannelRegistryError');
    });
});

describe('ChannelNotFoundError', () => {
    it('should construct with channel name', () => {
        const error = new ChannelNotFoundError('general');
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(ChannelRegistryError);
        expect(error).toBeInstanceOf(ChannelNotFoundError);
        expect(error.channelName).toBe('general');
        expect(error.message).toBe('Channel not found: general');
        expect(error.code).toBe('CHANNEL_NOT_FOUND');
        expect(error.name).toBe('ChannelNotFoundError');
    });

    it('should capture stack trace', () => {
        const error = new ChannelNotFoundError('general');
        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('ChannelNotFoundError');
    });

    it('should work with different channel names', () => {
        const error = new ChannelNotFoundError('catch-up');
        expect(error.channelName).toBe('catch-up');
        expect(error.message).toBe('Channel not found: catch-up');
    });
});

describe('AmbiguousChannelError', () => {
    it('should construct with channel name and match count', () => {
        const error = new AmbiguousChannelError('general', 3);
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(ChannelRegistryError);
        expect(error).toBeInstanceOf(AmbiguousChannelError);
        expect(error.channelName).toBe('general');
        expect(error.matchCount).toBe(3);
        expect(error.message).toBe("Ambiguous channel name 'general': found 3 matches");
        expect(error.code).toBe('AMBIGUOUS_CHANNEL');
        expect(error.name).toBe('AmbiguousChannelError');
    });

    it('should capture stack trace', () => {
        const error = new AmbiguousChannelError('general', 3);
        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('AmbiguousChannelError');
    });

    it('should work with different match counts', () => {
        const error = new AmbiguousChannelError('chat', 2);
        expect(error.channelName).toBe('chat');
        expect(error.matchCount).toBe(2);
        expect(error.message).toBe("Ambiguous channel name 'chat': found 2 matches");
    });

    it('should handle single match count correctly', () => {
        const error = new AmbiguousChannelError('test', 1);
        expect(error.message).toBe("Ambiguous channel name 'test': found 1 matches");
    });
});

describe('WellKnownChannelNotFoundError', () => {
    it('should construct with general channel type', () => {
        const error = new WellKnownChannelNotFoundError('general');
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(ChannelRegistryError);
        expect(error).toBeInstanceOf(WellKnownChannelNotFoundError);
        expect(error.channelType).toBe('general');
        expect(error.message).toBe('Required well-known channel not found: general');
        expect(error.code).toBe('WELL_KNOWN_CHANNEL_NOT_FOUND');
        expect(error.name).toBe('WellKnownChannelNotFoundError');
    });

    it('should construct with catch-up channel type', () => {
        const error = new WellKnownChannelNotFoundError('catch-up');
        expect(error.channelType).toBe('catch-up');
        expect(error.message).toBe('Required well-known channel not found: catch-up');
    });

    it('should construct with perch-time channel type', () => {
        const error = new WellKnownChannelNotFoundError('perch-time');
        expect(error.channelType).toBe('perch-time');
        expect(error.message).toBe('Required well-known channel not found: perch-time');
    });

    it('should capture stack trace', () => {
        const error = new WellKnownChannelNotFoundError('general');
        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('WellKnownChannelNotFoundError');
    });
});

describe('Error instanceof checks', () => {
    it('should correctly identify ChannelNotFoundError instance', () => {
        const error = new ChannelNotFoundError('test');
        expect(error instanceof ChannelRegistryError).toBe(true);
        expect(error instanceof ChannelNotFoundError).toBe(true);
        expect(error instanceof AmbiguousChannelError).toBe(false);
        expect(error instanceof WellKnownChannelNotFoundError).toBe(false);
    });

    it('should correctly identify AmbiguousChannelError instance', () => {
        const error = new AmbiguousChannelError('test', 2);
        expect(error instanceof ChannelRegistryError).toBe(true);
        expect(error instanceof AmbiguousChannelError).toBe(true);
        expect(error instanceof ChannelNotFoundError).toBe(false);
        expect(error instanceof WellKnownChannelNotFoundError).toBe(false);
    });

    it('should correctly identify WellKnownChannelNotFoundError instance', () => {
        const error = new WellKnownChannelNotFoundError('general');
        expect(error instanceof ChannelRegistryError).toBe(true);
        expect(error instanceof WellKnownChannelNotFoundError).toBe(true);
        expect(error instanceof ChannelNotFoundError).toBe(false);
        expect(error instanceof AmbiguousChannelError).toBe(false);
    });
});

describe('Error.captureStackTrace handling', () => {
    it('should call Error.captureStackTrace when it exists', () => {
        // Track if captureStackTrace is actually called
        let captureWasCalled = false;
        let receivedTarget: Error | undefined;
        let receivedConstructor: (new (...args: never[]) => Error) | undefined;

        const spy = spyOn(Error, 'captureStackTrace').mockImplementation(
            (target: object, constructorOpt?: (new (...args: never[]) => object)) => {
                captureWasCalled = true;
                receivedTarget = target as Error;
                receivedConstructor = constructorOpt as (new (...args: never[]) => Error) | undefined;
            }
        );

        const error = new ChannelRegistryError('Test error', 'TEST_CODE');

        // Verify captureStackTrace was called (kills mutant that changes condition to false)
        expect(captureWasCalled).toBe(true);
        expect(receivedTarget).toBe(error);
        expect(receivedConstructor).toBe(ChannelRegistryError);

        spy.mockRestore();
    });

    it('should not throw when Error.captureStackTrace is undefined', () => {
        // Save the original captureStackTrace
        const descriptor = Object.getOwnPropertyDescriptor(Error, 'captureStackTrace');

        // Temporarily remove captureStackTrace to simulate non-V8 environments
        Object.defineProperty(Error, 'captureStackTrace', {
            value:        undefined,
            writable:     true,
            configurable: true,
        });

        try {
            // Creating an error should not throw when captureStackTrace is undefined
            // This kills the mutant that changes `if(Error.captureStackTrace)` to `if(true)`
            // because `if(true)` would try to call undefined(), throwing a TypeError
            const error = new ChannelRegistryError('No captureStackTrace', 'NO_CAPTURE');

            // Verify the error is still valid
            expect(error.message).toBe('No captureStackTrace');
            expect(error.code).toBe('NO_CAPTURE');
            expect(error.name).toBe('ChannelRegistryError');
        } finally {
            // Restore the original captureStackTrace
            if(descriptor) {
                Object.defineProperty(Error, 'captureStackTrace', descriptor);
            }
        }
    });
});

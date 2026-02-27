import { describe, expect, test } from 'bun:test';
import {
    VALID_TRANSITIONS,
    isValidTransition,
    assertValidTransition,
    TransitionError,
    getModeEmoji
} from '@/integrations/discord/state/transitions';
import type { OperationalMode } from '@/integrations/discord/state/types';

describe('VALID_TRANSITIONS', () => {
    test('defines valid transitions from idle', () => {
        expect(VALID_TRANSITIONS.idle).toEqual(['catching_up', 'processing_message', 'perching']);
    });

    test('defines valid transitions from catching_up', () => {
        expect(VALID_TRANSITIONS.catching_up).toEqual(['idle']);
    });

    test('defines valid transitions from processing_message', () => {
        expect(VALID_TRANSITIONS.processing_message).toEqual(['idle']);
    });

    test('defines valid transitions from perching', () => {
        expect(VALID_TRANSITIONS.perching).toEqual(['idle']);
    });

    test('includes all operational modes', () => {
        const modes: OperationalMode[] = ['idle', 'catching_up', 'processing_message', 'perching'];
        for(const mode of modes) {
            expect(VALID_TRANSITIONS).toHaveProperty(mode);
        }
    });
});

describe('isValidTransition', () => {
    describe('valid transitions from idle', () => {
        test('idle to catching_up is valid', () => {
            expect(isValidTransition('idle', 'catching_up')).toBe(true);
        });

        test('idle to processing_message is valid', () => {
            expect(isValidTransition('idle', 'processing_message')).toBe(true);
        });

        test('idle to perching is valid', () => {
            expect(isValidTransition('idle', 'perching')).toBe(true);
        });
    });

    describe('valid transitions to idle', () => {
        test('catching_up to idle is valid', () => {
            expect(isValidTransition('catching_up', 'idle')).toBe(true);
        });

        test('processing_message to idle is valid', () => {
            expect(isValidTransition('processing_message', 'idle')).toBe(true);
        });

        test('perching to idle is valid', () => {
            expect(isValidTransition('perching', 'idle')).toBe(true);
        });
    });

    describe('invalid transitions', () => {
        test('catching_up to processing_message is invalid', () => {
            expect(isValidTransition('catching_up', 'processing_message')).toBe(false);
        });

        test('catching_up to perching is invalid', () => {
            expect(isValidTransition('catching_up', 'perching')).toBe(false);
        });

        test('processing_message to catching_up is invalid', () => {
            expect(isValidTransition('processing_message', 'catching_up')).toBe(false);
        });

        test('processing_message to perching is invalid', () => {
            expect(isValidTransition('processing_message', 'perching')).toBe(false);
        });

        test('perching to catching_up is invalid', () => {
            expect(isValidTransition('perching', 'catching_up')).toBe(false);
        });

        test('perching to processing_message is invalid', () => {
            expect(isValidTransition('perching', 'processing_message')).toBe(false);
        });
    });

    describe('edge cases', () => {
        test('idle to idle is invalid', () => {
            expect(isValidTransition('idle', 'idle')).toBe(false);
        });

        test('catching_up to catching_up is invalid', () => {
            expect(isValidTransition('catching_up', 'catching_up')).toBe(false);
        });

        test('processing_message to processing_message is invalid', () => {
            expect(isValidTransition('processing_message', 'processing_message')).toBe(false);
        });

        test('perching to perching is invalid', () => {
            expect(isValidTransition('perching', 'perching')).toBe(false);
        });
    });
});

describe('assertValidTransition', () => {
    test('does not throw for valid transition', () => {
        expect(() => assertValidTransition('idle', 'catching_up')).not.toThrow();
    });

    test('throws TransitionError for invalid transition', () => {
        expect(() => assertValidTransition('catching_up', 'processing_message'))
            .toThrow(TransitionError);
    });

    test('throws TransitionError with correct from and to modes', () => {
        try {
            assertValidTransition('catching_up', 'processing_message');
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(TransitionError);
            const transitionError = error as TransitionError;
            expect(transitionError.context.fromMode).toBe('catching_up');
            expect(transitionError.context.toMode).toBe('processing_message');
        }
    });

    test('throws TransitionError with default message', () => {
        try {
            assertValidTransition('catching_up', 'processing_message');
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe('Invalid transition from catching_up to processing_message');
        }
    });

    test('throws for same mode to same mode', () => {
        expect(() => assertValidTransition('idle', 'idle'))
            .toThrow(TransitionError);
    });
});

describe('getModeEmoji', () => {
    test('idle returns sleep emoji', () => {
        expect(getModeEmoji('idle')).toBe('💤');
    });

    test('catching_up returns inbox emoji', () => {
        expect(getModeEmoji('catching_up')).toBe('📥');
    });

    test('processing_message returns speech emoji', () => {
        expect(getModeEmoji('processing_message')).toBe('💬');
    });

    test('perching returns feather emoji', () => {
        expect(getModeEmoji('perching')).toBe('🪶');
    });
});

describe('TransitionError', () => {
    test('has correct name', () => {
        const error = new TransitionError('idle', 'catching_up');
        expect(error.name).toBe('TransitionError');
    });

    test('stores fromMode and toMode', () => {
        const error = new TransitionError('catching_up', 'processing_message');
        expect(error.context.fromMode).toBe('catching_up');
        expect(error.context.toMode).toBe('processing_message');
    });

    test('uses default message when not provided', () => {
        const error = new TransitionError('catching_up', 'processing_message');
        expect(error.message).toBe('Invalid transition from catching_up to processing_message');
    });

    test('uses custom message when provided', () => {
        const error = new TransitionError('catching_up', 'processing_message', 'Custom error');
        expect(error.message).toBe('Custom error');
    });

    test('is instanceof Error', () => {
        const error = new TransitionError('idle', 'catching_up');
        expect(error).toBeInstanceOf(Error);
    });
});

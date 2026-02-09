import { describe, test, expect, spyOn } from 'bun:test';
import _ from 'lodash';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';
import {
    DiscordError,
    InvalidTokenError,
    PermissionError,
    ChannelNotFoundByIdError,
    ChannelNotAccessibleError,
    RateLimitError,
    MessageFetchError,
    InvalidSnowflakeError,
    ChannelRegistryError,
    ChannelNotFoundByNameError,
    AmbiguousChannelError,
    WellKnownChannelNotFoundError,
    PresenceError,
    StatusGenerationError,
    TransitionError
} from '@/errors/discord';

describe.concurrent('DiscordError', () => {
    test('should have correct inheritance chain', () => {
        const error = new DiscordError('Test error');
        expect(error).toBeInstanceOf(DiscordError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and default code', () => {
        const error = new DiscordError('Test error');
        expect(error.name).toBe('DiscordError');
        expect(error.code).toBe(ErrorCode.DISCORD_ERROR);
    });

    test('should preserve stack trace', () => {
        const error = new DiscordError('Test error');
        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('DiscordError');
    });
});

describe.concurrent('InvalidTokenError', () => {
    test('should have correct properties', () => {
        const error = new InvalidTokenError();
        expect(error).toBeInstanceOf(InvalidTokenError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error.message).toBe('Discord bot token is invalid or expired');
        expect(error.code).toBe(ErrorCode.INVALID_TOKEN);
        expect(error.name).toBe('InvalidTokenError');
    });
});

describe.concurrent('PermissionError', () => {
    test.each([
        'send messages',
        'read message history',
        'manage roles',
    ])('should have correct properties for action: %s', (action) => {
        const error = new PermissionError(action);
        expect(error).toBeInstanceOf(PermissionError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error.message).toBe(`Bot lacks permission to ${action}`);
        expect(error.code).toBe(ErrorCode.PERMISSION_DENIED);
        expect(error.context.action).toBe(action);
        expect(error.name).toBe('PermissionError');
    });
});

describe.concurrent('ChannelNotFoundByIdError', () => {
    test.each([
        '987654321098765432',
        '111111111111111111',
    ])('should have correct properties for channelId: %s', (channelId) => {
        const error = new ChannelNotFoundByIdError(channelId);
        expect(error).toBeInstanceOf(ChannelNotFoundByIdError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error.message).toBe(`Discord channel not found: ${channelId}`);
        expect(error.code).toBe(ErrorCode.CHANNEL_NOT_FOUND_BY_ID);
        expect(error.context.channelId).toBe(channelId);
        expect(error.name).toBe('ChannelNotFoundByIdError');
    });
});

describe.concurrent('ChannelNotAccessibleError', () => {
    test('should have correct properties', () => {
        const error = new ChannelNotAccessibleError('123456789');
        expect(error).toBeInstanceOf(ChannelNotAccessibleError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error.message).toBe('Discord channel not accessible: 123456789');
        expect(error.code).toBe(ErrorCode.CHANNEL_NOT_ACCESSIBLE);
        expect(error.context.channelId).toBe('123456789');
        expect(error.name).toBe('ChannelNotAccessibleError');
    });
});

describe.concurrent('RateLimitError', () => {
    test.each([0, 1000, 5000, 3600000])('should have correct properties for retryAfter: %d', (retryAfter) => {
        const error = new RateLimitError(retryAfter);
        expect(error).toBeInstanceOf(RateLimitError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error.message).toBe(`Discord rate limit exceeded. Retry after ${retryAfter}ms`);
        expect(error.code).toBe(ErrorCode.RATE_LIMIT_EXCEEDED);
        expect(error.context.retryAfter).toBe(retryAfter);
        expect(error.name).toBe('RateLimitError');
    });
});

describe.concurrent('MessageFetchError', () => {
    test('should have correct properties', () => {
        const error = new MessageFetchError('123', 'timeout');
        expect(error).toBeInstanceOf(MessageFetchError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error.message).toBe('Failed to fetch messages from channel 123: timeout');
        expect(error.code).toBe(ErrorCode.MESSAGE_FETCH_ERROR);
        expect(error.context.channelId).toBe('123');
        expect(error.context.reason).toBe('timeout');
        expect(error.name).toBe('MessageFetchError');
    });
});

describe.concurrent('InvalidSnowflakeError', () => {
    test('should have correct properties', () => {
        const error = new InvalidSnowflakeError('invalid');
        expect(error).toBeInstanceOf(InvalidSnowflakeError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error.message).toBe('Invalid Discord snowflake: invalid');
        expect(error.code).toBe(ErrorCode.INVALID_SNOWFLAKE);
        expect(error.context.snowflake).toBe('invalid');
        expect(error.name).toBe('InvalidSnowflakeError');
    });
});

describe.concurrent('ChannelRegistryError', () => {
    test('should have correct inheritance chain', () => {
        const error = new ChannelRegistryError('Test error');
        expect(error).toBeInstanceOf(ChannelRegistryError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name and default code', () => {
        const error = new ChannelRegistryError('Test error');
        expect(error.name).toBe('ChannelRegistryError');
        expect(error.code).toBe(ErrorCode.CHANNEL_REGISTRY_ERROR);
    });
});

describe.concurrent('ChannelNotFoundByNameError', () => {
    test('should have correct properties', () => {
        const error = new ChannelNotFoundByNameError('general');
        expect(error).toBeInstanceOf(ChannelNotFoundByNameError);
        expect(error).toBeInstanceOf(ChannelRegistryError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error.message).toBe('Channel not found: general');
        expect(error.code).toBe(ErrorCode.CHANNEL_NOT_FOUND_BY_NAME);
        expect(error.context.channelName).toBe('general');
        expect(error.name).toBe('ChannelNotFoundByNameError');
    });
});

describe.concurrent('AmbiguousChannelError', () => {
    test('should have correct properties', () => {
        const error = new AmbiguousChannelError('general', 3);
        expect(error).toBeInstanceOf(AmbiguousChannelError);
        expect(error).toBeInstanceOf(ChannelRegistryError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error.message).toBe("Ambiguous channel name 'general': found 3 matches");
        expect(error.code).toBe(ErrorCode.AMBIGUOUS_CHANNEL);
        expect(error.context.channelName).toBe('general');
        expect(error.context.matchCount).toBe(3);
        expect(error.name).toBe('AmbiguousChannelError');
    });
});

describe.concurrent('WellKnownChannelNotFoundError', () => {
    test('should have correct properties', () => {
        const error = new WellKnownChannelNotFoundError('general');
        expect(error).toBeInstanceOf(WellKnownChannelNotFoundError);
        expect(error).toBeInstanceOf(ChannelRegistryError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error.message).toBe('Required well-known channel not found: general');
        expect(error.code).toBe(ErrorCode.WELL_KNOWN_CHANNEL_NOT_FOUND);
        expect(error.context.channelType).toBe('general');
        expect(error.name).toBe('WellKnownChannelNotFoundError');
    });
});

describe.concurrent('PresenceError', () => {
    test('should have correct inheritance chain and properties', () => {
        const error = new PresenceError('Test presence error');
        expect(error).toBeInstanceOf(PresenceError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error.name).toBe('PresenceError');
        expect(error.message).toBe('Test presence error');
        expect(error.code).toBe(ErrorCode.PRESENCE_ERROR);
        expect(error.cause).toBeUndefined();
    });

    test.each([
        ['Error', new Error('Original error')],
        ['string', 'string cause'],
        ['null', null],
    ])('should support cause: %s', (_label, causeValue) => {
        const error = new PresenceError('Test error', ErrorCode.PRESENCE_ERROR, causeValue);
        expect(error.cause).toBe(causeValue);
    });
});

describe.concurrent('StatusGenerationError', () => {
    test('should have correct inheritance chain and properties', () => {
        const error = new StatusGenerationError('Status generation failed');
        expect(error).toBeInstanceOf(StatusGenerationError);
        expect(error).toBeInstanceOf(PresenceError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error.name).toBe('StatusGenerationError');
        expect(error.message).toBe('Status generation failed');
        expect(error.code).toBe(ErrorCode.STATUS_GENERATION_ERROR);
    });

    test.each([
        ['Error', new Error('API timeout')],
        ['null', null],
    ])('should support cause: %s', (_label, causeValue) => {
        const error = new StatusGenerationError('Status generation failed', causeValue);
        expect(error.cause).toBe(causeValue);
    });
});

describe.concurrent('TransitionError', () => {
    test('should have correct inheritance chain', () => {
        const error = new TransitionError('idle', 'idle');
        expect(error).toBeInstanceOf(TransitionError);
        expect(error).toBeInstanceOf(DiscordError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct default message', () => {
        const error = new TransitionError('idle', 'idle');
        expect(error.message).toBe('Invalid transition from idle to idle');
    });

    test('should support custom message', () => {
        const error = new TransitionError('idle', 'idle', 'Custom transition error');
        expect(error.message).toBe('Custom transition error');
    });

    test('should have correct properties', () => {
        const error = new TransitionError('catching_up', 'processing_message');
        expect(error.name).toBe('TransitionError');
        expect(error.code).toBe(ErrorCode.TRANSITION_ERROR);
        expect(error.context.fromMode).toBe('catching_up');
        expect(error.context.toMode).toBe('processing_message');
    });
});

describe.concurrent('Error instanceof cross-checks', () => {
    test('ChannelNotFoundByNameError is not ChannelNotFoundByIdError', () => {
        const error = new ChannelNotFoundByNameError('test');
        expect(error instanceof ChannelNotFoundByIdError).toBe(false);
    });

    test('ChannelNotFoundByIdError is not ChannelRegistryError', () => {
        const error = new ChannelNotFoundByIdError('123');
        expect(error instanceof ChannelRegistryError).toBe(false);
    });

    test('AmbiguousChannelError is not ChannelNotFoundByNameError', () => {
        const error = new AmbiguousChannelError('test', 2);
        expect(error instanceof ChannelNotFoundByNameError).toBe(false);
    });
});

describe.concurrent('Error.captureStackTrace handling', () => {
    test('should call captureStackTrace for subclass', () => {
        const spy = spyOn(Error, 'captureStackTrace');
        const error = new InvalidTokenError();
        expect(spy).toHaveBeenCalledWith(error, InvalidTokenError);
        spy.mockRestore();
    });

    test('should handle missing captureStackTrace gracefully', () => {
        const descriptor = Object.getOwnPropertyDescriptor(Error, 'captureStackTrace');
        Object.defineProperty(Error, 'captureStackTrace', {
            value:        undefined,
            writable:     true,
            configurable: true,
        });

        try {
            const error = new DiscordError('No captureStackTrace');
            expect(error.message).toBe('No captureStackTrace');
            expect(error.name).toBe('DiscordError');
        } finally {
            if(descriptor) {
                Object.defineProperty(Error, 'captureStackTrace', descriptor);
            }
        }
    });
});

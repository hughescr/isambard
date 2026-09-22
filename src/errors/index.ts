/**
 * Centralized Error Hierarchy
 *
 * All Isambard error classes are exported from this module.
 * Import errors from '@/errors' or '@/errors/<module>'.
 *
 * @see ./README.md for hierarchy diagram and usage guidelines
 */

export { ErrorCode } from './codes';
export { IsambardError, InvariantViolationError } from './base';
export { ConfigValidationError } from './config';

export {
    StorageError,
    ItemNotFoundError,
    ValidationError,
    DynamoTimeoutError,
    ContactNotFoundError,
    ContactLastIdentifierError,
    ContactNoIdentifiersError,
    BatchWriteExhaustedError
} from './storage';

export {
    DiscordError,
    ChannelNotFoundByIdError,
    ChannelNotAccessibleError,
    ChannelRegistryError,
    ChannelNotFoundByNameError,
    AmbiguousChannelError,
    MessageFetchError,
    InvalidSnowflakeError,
    WellKnownChannelNotFoundError,
    PresenceError,
    StatusGenerationError
} from './discord';

export { PathSecurityError, MediaProcessingError } from './utils';
export type { PathSecurityReason } from './utils';

export { BrowserError, BrowserNavigateTimeoutError } from './browser';

export {
    EmailError,
    ClassifierError,
    EmailProcessingError,
    WildDuckError,
    WildDuckAuthError
} from './email';

export {
    BskyError,
    BskyAuthError,
    BskyRateLimitError,
    BskyValidationError
} from './bsky';

export {
    CaldavError,
    CaldavAuthError,
    CaldavFetchError,
    CaldavTimeoutError,
    AmbiguousCalendarMatchError
} from './caldav';

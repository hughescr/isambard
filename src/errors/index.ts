/**
 * Centralized Error Hierarchy
 *
 * All Isambard error classes are exported from this module.
 * Import errors from '@/errors' or '@/errors/<module>'.
 *
 * @see ./README.md for hierarchy diagram and usage guidelines
 */

export { ErrorCode } from './codes';
export { IsambardError } from './base';

export {
    ItemNotFoundError,
    ValidationError,
    DynamoTimeoutError,
    PathNotFoundError,
    PathAlreadyExistsError,
    InvalidPathError,
    TextNotFoundError,
    ContentTooLargeError,
    TextNotUniqueError,
    InvalidLineNumberError,
    ContactNotFoundError,
    ContactLastIdentifierError
} from './storage';

export {
    ChannelNotAccessibleError,
    ChannelNotFoundByNameError,
    MessageFetchError,
    InvalidSnowflakeError,
    WellKnownChannelNotFoundError,
    PresenceError,
    StatusGenerationError,
    TransitionError
} from './discord';

export { PathSecurityError } from './utils';

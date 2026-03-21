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
    TextNotUniqueError,
    InvalidLineNumberError
} from './storage';

export {
    ChannelNotAccessibleError,
    MessageFetchError,
    InvalidSnowflakeError,
    WellKnownChannelNotFoundError,
    PresenceError,
    StatusGenerationError,
    TransitionError
} from './discord';

export { PathSecurityError } from './utils';

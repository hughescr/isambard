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
    BatchWriteExhaustedError,
    ConsumedCapacityMissingError,
    MemoryAccessRepairConflictError
} from './storage';

export {
    DiscordError,
    ChannelNotFoundByIdError,
    ChannelNotAccessibleError,
    ResponseUnavailableError,
    ChannelRegistryError,
    ChannelNotFoundByNameError,
    AmbiguousChannelError,
    MessageFetchError,
    InvalidSnowflakeError,
    WellKnownChannelNotFoundError,
    PresenceError,
    StatusGenerationError,
    InvalidDeliveryTokenError
} from './discord';

export { PathSecurityError, MediaProcessingError } from './utils';
export type { PathSecurityReason } from './utils';

export { BrowserError, BrowserNavigateTimeoutError } from './browser';

export {
    EmailError,
    ClassifierError,
    EmailProcessingError,
    EmailPreviewError,
    WildDuckError,
    WildDuckAuthError
} from './email';
export type { WildDuckErrorContext, WildDuckErrorKind } from './email';

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

export {
    ZoteroError,
    ZoteroAuthError,
    ZoteroNotFoundError,
    ZoteroVersionConflictError,
    ZoteroRateLimitError,
    ZoteroServerError,
    ZoteroQuotaError,
    ZoteroFileError,
    ZoteroUrlFetchError,
    ZoteroMetadataError
} from './zotero';
export type { ZoteroFileErrorReason } from './zotero';

export {
    MemoryVecError,
    ModelFileNotFoundError,
    IncompatibleLlamaCppError,
    EmbedderClosedError
} from './memory-vec';

export {
    VectorIndexError,
    VectorIndexClosedError,
    VectorIndexUnavailableError,
    VectorCrossCheckError
} from './vector-index';
export type { VectorCrossCheckReason } from './vector-index';

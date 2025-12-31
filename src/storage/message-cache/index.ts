// Types
export {
    messageIdSchema,
    createMessageId,
    isMessageId,
    cachedMessageSchema,
    cachedSegmentSchema,
    type MessageId,
    type CachedMessage,
    type CachedSegmentData,
    type CachedSegmentItem,
    type CacheGap
} from './types';

// Key Generator
export {
    MessageCacheKeyGenerator,
    type MessageCacheKeys,
    type ParsedKeys
} from './key-generator';

// Backend
export {
    MessageCacheBackend,
    type StoreSegmentInput
} from './backend';

// Segment Manager
export { SegmentManager } from './segment-manager';

// Cache (main interface)
export {
    MessageCache,
    type CacheQueryResult
} from './cache';

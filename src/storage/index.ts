// Client
export { createDynamoDBClient, type DynamoDBClients } from './client';

// Errors
export { StorageError, ItemNotFoundError, ConflictError, ValidationError } from './errors';

// Models
/** @internal */
export {
    memoryTypeSchema,
    memorySchema,
    createMemoryKeys,
    type Memory,
    type MemoryType,
    type MemoryItem
} from './models/memory';

// Repositories
/** @internal */
export { BaseRepository, type DynamoDBKey } from './repositories/base';

/** @internal */
export {
    MemoryRepository,
    type CreateMemoryInput,
    type UpdateMemoryInput,
    type QueryOptions,
    type QueryResult
} from './repositories/memory';

// Task Session
export { TaskSessionBackend, sessionIdSchema, createSessionId, isSessionId, type SessionId, type TaskSessionItem } from './task-session';

// Utils
/** @internal */
export { stripDynamoKeys } from './utils/index.js';

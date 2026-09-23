import { logger } from '@hughescr/logger';
import { stripDynamoKeys } from '../utils/index.js';
import { normalizeStoredMemoryToolItem, storedMemoryToolItemSchema, type MemoryToolItemData } from './types';

/**
 * Decodes one raw DynamoDB record into {@link MemoryToolItemData}, tolerantly. A row that fails
 * schema validation is logged and treated as absent rather than thrown or blindly cast — callers
 * decide what "absent" means for them (`undefined` for a single get, or skip-this-row for a list).
 *
 * TTL survives on the returned value at runtime — {@link stripDynamoKeys} only removes
 * PK/SK/GSI1PK/GSI1SK — even though {@link MemoryToolItemData} declares no TTL field. This is
 * the escape hatch `MemoryToolBackendCore.update()` relies on to preserve TTL across an update.
 */
export function decodeStoredMemoryToolItem(raw: Record<string, unknown>): MemoryToolItemData | undefined {
    const normalized = normalizeStoredMemoryToolItem(raw);
    const result = storedMemoryToolItemSchema.safeParse(normalized);
    if(!result.success) {
        logger.warn({ issues: result.error.issues }, 'MemoryToolBackend: stored row failed schema validation, skipping');
        return undefined;
    }
    return stripDynamoKeys(result.data);
}

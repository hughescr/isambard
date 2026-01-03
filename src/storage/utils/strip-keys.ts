/**
 * DynamoDB key field names that should be stripped from items.
 * Also includes contentPreview as it's derived data, not user-provided.
 */
export type DynamoDBKeyField = 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK' | 'GSI2PK' | 'GSI2SK' | 'contentPreview';

/**
 * Represents a DynamoDB item that may have key fields.
 * Uses partial optional keys to allow items with or without GSI fields.
 */
interface DynamoDBItem {
    PK?:             string
    SK?:             string
    GSI1PK?:         string
    GSI1SK?:         string
    GSI2PK?:         string
    GSI2SK?:         string
    contentPreview?: string
}

/**
 * Strips DynamoDB key fields from an item.
 *
 * Removes partition keys (PK), sort keys (SK), GSI keys, and derived fields
 * (contentPreview) from DynamoDB items to return just the data portion.
 * Handles items that may not have all GSI fields.
 *
 * @param item - DynamoDB item with key fields
 * @returns Item data without key fields
 *
 * @example
 * ```typescript
 * const item = {
 *     PK: 'USER#123',
 *     SK: 'PROFILE',
 *     GSI1PK: 'EMAIL#test@example.com',
 *     GSI1SK: 'USER#123',
 *     name: 'John Doe',
 *     email: 'test@example.com',
 * };
 * const data = stripDynamoKeys(item);
 * // { name: 'John Doe', email: 'test@example.com' }
 * ```
 */
export function stripDynamoKeys<T extends DynamoDBItem>(
    item: T
): Omit<T, DynamoDBKeyField> {
    const {
        PK:             _PK,
        SK:             _SK,
        GSI1PK:         _GSI1PK,
        GSI1SK:         _GSI1SK,
        GSI2PK:         _GSI2PK,
        GSI2SK:         _GSI2SK,
        contentPreview: _contentPreview,
        ...data
    } = item;
    return data;
}

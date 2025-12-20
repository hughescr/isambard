import { z } from 'zod';

/**
 * Memory types for the three-layer memory system.
 * - identity: Agent personality and metadata
 * - state: Current context and working memory
 * - event: Conversation history and interactions
 */
export const memoryTypeSchema = z.enum(['identity', 'state', 'event']);

/**
 * Memory entity schema with Zod validation.
 */
export const memorySchema = z.object({
    id:          z.string().uuid(),
    memory_type: memoryTypeSchema,
    content:     z.string().min(1).max(350000), // ~350KB limit for DynamoDB
    metadata:    z.record(z.string(), z.any()).default({}),
    version:     z.number().int().nonnegative().default(0), // Optimistic locking
    createdAt:   z.string().datetime(),
    updatedAt:   z.string().datetime(),
    TTL:         z.number().int().positive().optional(),
    embeddingId: z.string().optional(), // Future: reference to vector store
});

export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type Memory = z.infer<typeof memorySchema>;

/**
 * DynamoDB item structure with keys.
 */
export interface MemoryItem extends Memory {
    PK:     string  // MEMORY#{id}
    SK:     string  // TYPE#{memory_type}
    GSI1PK: string  // TYPE#{memory_type}
    GSI1SK: string  // CREATED#{createdAt}
}

/**
 * Creates DynamoDB keys for a Memory entity.
 */
export function createMemoryKeys(memory: Memory): Pick<MemoryItem, 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK'> {
    return {
        PK:     `MEMORY#${memory.id}`,
        SK:     `TYPE#${memory.memory_type}`,
        GSI1PK: `TYPE#${memory.memory_type}`,
        GSI1SK: `CREATED#${memory.createdAt}`,
    };
}

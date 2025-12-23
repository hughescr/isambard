import { z } from 'zod';
import _ from 'lodash';

/**
 * MemoryPath is a branded type representing a valid filesystem-like path.
 * Paths must:
 * - Start with `/`
 * - Not contain `//`
 * - Not end with `/` (except for root `/`)
 */
export const memoryPathSchema = z
    .string()
    .min(1, 'Path cannot be empty')
    .refine(path => _.startsWith(path, '/'), {
        message: 'Path must start with /',
    })
    .refine(path => !path.includes('//'), {
        message: 'Path cannot contain double slashes (//)',
    })
    .refine(path => path === '/' || !_.endsWith(path, '/'), {
        message: 'Path cannot end with / (except root)',
    })
    .brand<'MemoryPath'>();

export type MemoryPath = z.infer<typeof memoryPathSchema>;

/**
 * Supported content types for memory tool items.
 */
export const contentTypeSchema = z.enum(['text/plain', 'text/markdown', 'application/json']);

export type ContentType = z.infer<typeof contentTypeSchema>;

/**
 * Memory tool item schema with Zod validation.
 * Represents a stored piece of content in the agent's memory system.
 */
export const memoryToolItemSchema = z.object({
    path:        memoryPathSchema,
    content:     z.string().min(1).max(300000), // 300KB limit for DynamoDB
    contentType: contentTypeSchema,
    metadata:    z.record(z.string(), z.unknown()).default({}),
    version:     z.number().int().positive(),
    createdAt:   z.string().datetime(),
    updatedAt:   z.string().datetime(),
    tags:        z.array(z.string()).optional(),
});

export type MemoryToolItemData = z.infer<typeof memoryToolItemSchema>;

/**
 * DynamoDB item structure with keys.
 */
export interface MemoryToolItem extends MemoryToolItemData {
    PK:     string  // TOOL_MEMORY#{path}
    SK:     string  // TOOL_MEMORY#{path}
    GSI1PK: string  // TOOL_MEMORY#TAG#{tag} or TOOL_MEMORY#{path}
    GSI1SK: string  // {updatedAt}
}

/**
 * Creates a validated MemoryPath from a string.
 * @throws {z.ZodError} If the path is invalid
 */
export function createMemoryPath(path: string): MemoryPath {
    return memoryPathSchema.parse(path);
}

/**
 * Type guard to check if a value is a valid MemoryPath.
 */
export function isMemoryPath(value: unknown): value is MemoryPath {
    const result = memoryPathSchema.safeParse(value);
    return result.success;
}

/**
 * Creates DynamoDB keys for a MemoryTool entity.
 */
export function createMemoryToolKeys(
    path: MemoryPath,
    tags?: string[],
    updatedAt?: string
): Pick<MemoryToolItem, 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK'> {
    const pk = `TOOL_MEMORY#${path}`;
    const sk = `TOOL_MEMORY#${path}`;

    // GSI1PK: Use first tag if available, otherwise fall back to path
    const gsi1pk = tags && tags.length > 0
        ? `TOOL_MEMORY#TAG#${tags[0]}`
        : `TOOL_MEMORY#${path}`;

    // GSI1SK: Use updatedAt for time-based sorting
    const gsi1sk = updatedAt ?? '';

    return {
        PK:     pk,
        SK:     sk,
        GSI1PK: gsi1pk,
        GSI1SK: gsi1sk,
    };
}

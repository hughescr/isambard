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
    ttl:         z.number().int().positive().optional(), // Unix timestamp for TTL expiration
});

export type MemoryToolItemData = z.infer<typeof memoryToolItemSchema>;

/**
 * DynamoDB item structure with keys.
 */
export interface MemoryToolItem extends MemoryToolItemData {
    PK:      string   // DIR#{parentPath} - groups files by directory
    SK:      string   // FILE#{filename} - identifies file within directory
    GSI1PK:  string   // PATH#{fullPath} - allows lookup by full path
    GSI1SK:  string   // CREATED#{timestamp} - time-based sorting
    GSI2PK?: string   // TAG#{tag} - allows lookup by tag (optional)
    GSI2SK?: string   // LAYER#{layer}#UPDATED#{timestamp} - tag queries with layer and time filtering (optional)
    ttl?:    number   // Unix timestamp for TTL expiration (optional)
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
 * Layer names for organizing memory in a structured hierarchy.
 * - identity: Core beliefs, values, and self-model
 * - state: Current context and working memory
 * - events: Historical timeline and experiences
 */
export const layerNameSchema = z
    .enum(['identity', 'state', 'events'])
    .brand<'LayerName'>();

export type LayerName = z.infer<typeof layerNameSchema>;

/**
 * Extracts the layer name from a memory path if the path starts with a valid layer.
 * Uses word boundary matching to avoid false positives (e.g., /stateoftheart.md).
 * @returns LayerName if path starts with a valid layer, null otherwise
 */
export function extractLayerFromPath(path: MemoryPath): LayerName | null {
    // Match layer at start of path with word boundary
    // Pattern: /^\/({layer})(?:\/|$)/
    // Stryker disable next-line Regex: MemoryPath is guaranteed to start with /, making ^ anchor redundant but kept for clarity
    const regex = /^\/(\w+)(?:\/|$)/;
    const match = regex.exec(path);

    if(!match) {
        return null;
    }

    const candidate = match[1];
    const result = layerNameSchema.safeParse(candidate);

    return result.success ? result.data : null;
}

/**
 * Metadata for layered memory organization.
 * Enables prioritization, access tracking, and relationship mapping.
 */
export const layeredMemoryMetadataSchema = z.object({
    layer:        layerNameSchema,
    importance:   z.number().int().min(1).max(10).default(5),
    lastAccessed: z.string().datetime().optional(),
    accessCount:  z.number().int().min(0).default(0),
    relatedPaths: z.array(memoryPathSchema).default([]),
});

export type LayeredMemoryMetadata = z.infer<typeof layeredMemoryMetadataSchema>;

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

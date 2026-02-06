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
    path:           memoryPathSchema,
    content:        z.string().min(1).max(300000), // 300KB limit for DynamoDB
    contentType:    contentTypeSchema,
    metadata:       z.record(z.string(), z.unknown()).default({}),
    version:        z.number().int().positive(),
    createdAt:      z.string().datetime(),
    updatedAt:      z.string().datetime(),
    tags:           z.array(z.string()).optional(),
    contentPreview: z.string().max(100).optional(), // First 100 chars of content for tag index preview
});

export type MemoryToolItemData = z.infer<typeof memoryToolItemSchema>;

/**
 * DynamoDB item structure with keys.
 * Note: GSI1PK/GSI1SK are optional because version snapshots should not appear in layer queries.
 */
export interface MemoryToolItem extends MemoryToolItemData {
    PK:      string   // DIR#{parentPath} - groups files by directory
    SK:      string   // FILE#{filename} or VERSION#{version}#{timestamp} for snapshots
    GSI1PK?: string   // LAYER#{layer} - allows lookup by layer (optional, not set on version snapshots)
    GSI1SK?: string   // UPDATED#{timestamp} - time-based sorting within layer (optional, not set on version snapshots)
}

/**
 * DynamoDB item structure for tag index entries.
 * Fat pointer carrying preview data to enable search results without fetching full items.
 */
export interface TagIndexItem {
    PK:             string    // TAG#tagname
    SK:             string    // PATH#memoryPath
    memoryPath:     string
    layer:          string
    updatedAt:      string    // ISO 8601
    tags:           string[]  // Full normalized tags array
    contentPreview: string    // First 100 chars of content
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
/* Stryker disable ObjectLiteral,MethodExpression: Zod schema definition with defaults — config defaults are not behavioral */
export const layeredMemoryMetadataSchema = z.object({
    layer:        layerNameSchema,
    importance:   z.number().int().min(1).max(10).default(5),
    lastAccessed: z.string().datetime().optional(),
    accessCount:  z.number().int().min(0).default(0),
    relatedPaths: z.array(memoryPathSchema).default([]),
});
/* Stryker restore ObjectLiteral,MethodExpression */

export type LayeredMemoryMetadata = z.infer<typeof layeredMemoryMetadataSchema>;

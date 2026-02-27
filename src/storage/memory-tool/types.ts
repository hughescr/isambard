import endsWith from 'lodash/endsWith';
import startsWith from 'lodash/startsWith';
import { z } from 'zod';

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
    .refine(path => startsWith(path, '/'), {
        message: 'Path must start with /',
    })
    .refine(path => !path.includes('//'), {
        message: 'Path cannot contain double slashes (//)',
    })
    .refine(path => path === '/' || !endsWith(path, '/'), {
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
 * Creates a validated ContentType from a string.
 * @throws {z.ZodError} If the type is not a valid content type
 */
export function createContentType(type: string): ContentType {
    return contentTypeSchema.parse(type);
}

/**
 * Type guard to check if a value is a valid ContentType.
 */
export function isContentType(value: unknown): value is ContentType {
    const result = contentTypeSchema.safeParse(value);
    return result.success;
}

/**
 * Memory tool item schema with Zod validation.
 * Represents a stored piece of content in the agent's memory system.
 */
export const memoryToolItemSchema = z.object({
    path:           memoryPathSchema,
    content:        z.string().min(1).max(300_000), // 300KB limit for DynamoDB
    contentType:    contentTypeSchema,
    metadata:       z.record(z.string(), z.unknown()).default({}),
    createdAt:      z.iso.datetime(),
    // "Last touched" — updated on both content edits and deliberate memory access (recordAccess)
    updatedAt:      z.iso.datetime(),
    // Stryker disable next-line ConditionalExpression: Zod custom validator for Set<string> type checking
    tags:           z.custom<Set<string>>(val => val === undefined || val instanceof Set).optional(),
    contentPreview: z.string().max(100).optional(), // First 100 chars of content for tag index preview
});

export type MemoryToolItemData = z.infer<typeof memoryToolItemSchema>;

/**
 * DynamoDB item structure with keys.
 */
export interface MemoryToolItem extends MemoryToolItemData {
    PK:     string   // DIR#{parentPath} - groups files by directory
    SK:     string   // FILE#{filename}
    GSI1PK: string   // LAYER#{layer} - allows lookup by layer
    GSI1SK: string   // UPDATED#{timestamp} - time-based sorting within layer
}

/**
 * DynamoDB item structure for tag index entries.
 * Fat pointer carrying preview data to enable search results without fetching full items.
 */
export interface TagIndexItem {
    PK:             string       // TAG#tagname
    SK:             string       // PATH#memoryPath
    memoryPath:     string
    layer:          string
    updatedAt:      string       // ISO 8601
    tags:           Set<string>  // Full normalized tags set
    contentPreview: string       // First 100 chars of content
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
 * Creates a validated LayerName from a string.
 * @throws {z.ZodError} If the name is not a valid layer
 */
export function createLayerName(name: string): LayerName {
    return layerNameSchema.parse(name);
}

/**
 * Type guard to check if a value is a valid LayerName.
 */
export function isLayerName(value: unknown): value is LayerName {
    const result = layerNameSchema.safeParse(value);
    return result.success;
}

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
    lastAccessed: z.iso.datetime().optional(),
    accessCount:  z.number().int().min(0).default(0),
    relatedPaths: z.array(memoryPathSchema).default([]),
});
/* Stryker restore ObjectLiteral,MethodExpression */

export type LayeredMemoryMetadata = z.infer<typeof layeredMemoryMetadataSchema>;

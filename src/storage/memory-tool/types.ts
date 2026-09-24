import { z } from 'zod';
import { epochSecondsSchema } from '../repositories/types';

export const CONTENT_PREVIEW_MAX_LENGTH = 100;

/**
 * MemoryPath is a branded type representing a valid filesystem-like path.
 * Paths must:
 * - Start with `/`
 * - Not contain `//`
 * - Not be root `/` or end with `/`
 */
export const memoryPathSchema = z
    .string()
    .min(1, 'Path cannot be empty')
    .refine(path => path.startsWith('/'), {
        message: 'Path must start with /',
    })
    .refine(path => !path.includes('//'), {
        message: 'Path cannot contain double slashes (//)',
    })
    .refine(path => path !== '/', {
        message: 'Root path / is not a memory item',
    })
    .refine(path => !path.endsWith('/'), {
        message: 'Path cannot end with /',
    })
    .brand<'MemoryPath'>();

export type MemoryPath = z.infer<typeof memoryPathSchema>;

/** Host-owned access stats; persisted as metadata.accessCount and metadata.lastAccessed. */
export const memoryAccessStatsSchema = z.object({
    accessCount:    z.number().int().nonnegative(),
    lastAccessedAt: z.iso.datetime(),
});
export type MemoryAccessStats = z.infer<typeof memoryAccessStatsSchema>;

/** Invalid legacy counts decode as zero. No production writer emits fractional counts. */
export function decodeMemoryAccessStats(metadata: unknown, fallbackLastAccessedAt: string): MemoryAccessStats {
    const raw = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : {};
    const count = memoryAccessStatsSchema.shape.accessCount.safeParse(raw.accessCount);
    const timestamp = memoryAccessStatsSchema.shape.lastAccessedAt.safeParse(raw.lastAccessed);
    return {
        accessCount:    count.success ? count.data : 0,
        lastAccessedAt: timestamp.success ? timestamp.data : fallbackLastAccessedAt,
    };
}

/** Decode-only legacy rename tombstone: its original writer has been removed. */
const stringTagsSchema = z.array(z.string());
export const pendingRenameIndexCleanupSchema = z.object({
    oldPath: memoryPathSchema,
    tags:    z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('known'), tags: stringTagsSchema }),
        z.object({ kind: z.literal('legacy-unknown') }),
    ]),
});
export type PendingRenameIndexCleanup = z.infer<typeof pendingRenameIndexCleanupSchema>;

export function decodePendingRenameIndexCleanup(metadata: unknown): PendingRenameIndexCleanup | undefined {
    if(metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return undefined;
    }
    const raw = metadata as Record<string, unknown>;
    const oldPath = memoryPathSchema.safeParse(raw.previouslyKnownAs);
    if(!oldPath.success) {
        return undefined;
    }
    const tags = stringTagsSchema.safeParse(raw.previouslyKnownAsTags);
    return {
        oldPath: oldPath.data,
        tags:    tags.success ? { kind: 'known', tags: tags.data } : { kind: 'legacy-unknown' },
    };
}

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

/** Managed metadata keys remain tolerant so legacy rows are decoded, not rejected. */
const memoryMetadataSchema = z.record(z.string(), z.unknown());

/**
 * Memory tool item schema with Zod validation.
 * Represents a stored piece of content in the agent's memory system.
 */
export const memoryToolItemSchema = z.object({
    path:           memoryPathSchema,
    content:        z.string().min(1).max(300_000), // 300KB limit for DynamoDB
    contentType:    contentTypeSchema,
    metadata:       memoryMetadataSchema.default({}),
    createdAt:      z.iso.datetime(),
    // "Last touched" — updated on both content edits and deliberate memory access
    updatedAt:      z.iso.datetime(),
    tags:           z.custom<Set<string>>(val => val instanceof Set).optional(),
    contentPreview: z.string().max(CONTENT_PREVIEW_MAX_LENGTH).optional(), // First 100 chars of content for tag index preview
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

/** DynamoDB may still contain legacy rows with absent or null metadata. */
export type StoredMemoryToolItem = Omit<MemoryToolItem, 'metadata'> & { metadata?: Record<string, unknown> | null };

/**
 * Validates a raw DynamoDB record as a full memory tool row before it is trusted. Extends
 * {@link memoryToolItemSchema} with the DynamoDB key fields (always present on a real row) and
 * the raw `TTL` attribute (optional, epoch seconds) — `TTL` is a DDB-level attribute, not part
 * of the domain {@link MemoryToolItemData} shape, but must survive validation rather than being
 * silently stripped: {@link MemoryToolBackendCore.update} reads it back off an already-decoded
 * row to preserve TTL across an update.
 */
export const storedMemoryToolItemSchema = memoryToolItemSchema.extend({
    PK:     z.string(),
    SK:     z.string(),
    GSI1PK: z.string(),
    GSI1SK: z.string(),
    TTL:    epochSecondsSchema.optional(),
});

/** Apply only the schema's metadata default at the DynamoDB read boundary, on a raw record. */
export function normalizeStoredMemoryToolItem(item: Record<string, unknown>): Record<string, unknown> {
    return { ...item, metadata: item.metadata ?? {} };
}

/**
 * DynamoDB item structure for tag index entries.
 * Fat pointer carrying preview data to enable search results without fetching full items.
 */
export interface TagIndexItem {
    PK:             string       // TAG#tagname
    SK:             string       // PATH#memoryPath
    memoryPath:     string
    layer:          IndexLayer   // classifyMemoryPath(memoryPath).namespace
    updatedAt:      string       // ISO 8601
    tags:           Set<string>  // Full normalized tags set
    contentPreview: string       // First 100 chars of content
}

/**
 * A tag row as read back from DynamoDB. Legacy rows may predate the content preview field, and
 * `/users/` rows written before #58 carry `layer: 'unknown'`, so a read `layer` is an untrusted
 * string until compared against the classified path (the reconciler rewrites mismatches).
 */
export type TagIndexReadItem = Omit<TagIndexItem, 'contentPreview' | 'layer'> & { contentPreview?: string, layer: string };

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

/** The three cognitive memory layers: the one list every "all layers" iteration derives from. */
export const LAYER_NAME_VALUES = ['identity', 'state', 'events'] as const;
/** The layers `storeSelf` may write: events are not self-knowledge. */
export const SELF_LAYER_NAME_VALUES = ['identity', 'state'] as const;
/** Namespaces the model may filter semantic and tag search by: the cognitive layers plus per-person `/users/`. */
export const SEARCHABLE_NAMESPACE_VALUES = [...LAYER_NAME_VALUES, 'users'] as const;

/**
 * The first segment of a memory path — what the GSI1 key, the tag index and the vector index
 * actually store as their `layer`. It is not necessarily a cognitive layer (`/users/…` is not).
 */
export const pathNamespaceSchema = z
    .string()
    .min(1, 'Namespace cannot be empty')
    .refine(name => !name.includes('/'), 'Namespace cannot contain /')
    .brand<'PathNamespace'>();
export type PathNamespace = z.infer<typeof pathNamespaceSchema>;
/** The namespace-valued `layer` field written to the tag and vector indexes. */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- IndexLayer names the persisted-index contract at API boundaries.
export type IndexLayer = PathNamespace;

/**
 * Creates a validated IndexLayer (any single path segment) from a string.
 * @throws {z.ZodError} If the name is empty or contains `/`
 */
export function createIndexLayer(name: string): IndexLayer {
    return pathNamespaceSchema.parse(name);
}

/**
 * Layer names for organizing memory in a structured hierarchy.
 * - identity: Core beliefs, values, and self-model
 * - state: Current context and working memory
 * - events: Historical timeline and experiences
 *
 * Doubly branded so every cognitive layer is also assignable where an {@link IndexLayer} is expected.
 */
export const layerNameSchema = z.enum(LAYER_NAME_VALUES).brand<'LayerName'>().brand<'PathNamespace'>();
export type LayerName = z.infer<typeof layerNameSchema>;
export const LAYER_NAMES: readonly LayerName[] = LAYER_NAME_VALUES.map(name => layerNameSchema.parse(name));

export const searchableNamespaceSchema = z.enum(SEARCHABLE_NAMESPACE_VALUES).brand<'PathNamespace'>();
export type SearchableNamespace = z.infer<typeof searchableNamespaceSchema>;
/** Every indexed namespace the reconciler and the vector backfill walk: three layers plus `users`. */
export const SEARCHABLE_NAMESPACES: readonly SearchableNamespace[] = SEARCHABLE_NAMESPACE_VALUES.map(name => searchableNamespaceSchema.parse(name));

/**
 * Creates a validated SearchableNamespace from a string.
 * @throws {z.ZodError} If the name is not a cognitive layer or `users`
 */
export function createSearchableNamespace(name: string): SearchableNamespace {
    return searchableNamespaceSchema.parse(name);
}

/** What a memory path's root says about it. */
export interface MemoryPathClass {
    namespace:       PathNamespace
    /** Set only when the namespace is one of {@link LAYER_NAME_VALUES}. */
    cognitiveLayer?: LayerName
    /** Set only for `/users/<userId>/…` paths. */
    userId?:         string
}

/** Classifies a memory path by its first segment only (so `/stateoftheart.md` is not the state layer). */
export function classifyMemoryPath(path: MemoryPath): MemoryPathClass {
    const [, first, second] = path.split('/');
    const classified: MemoryPathClass = { namespace: pathNamespaceSchema.parse(first) };
    const cognitive = layerNameSchema.safeParse(first);
    if(cognitive.success) {
        classified.cognitiveLayer = cognitive.data;
    }
    if(first === 'users' && second !== undefined) {
        classified.userId = second;
    }
    return classified;
}

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

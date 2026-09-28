/**
 * Loose zod schemas for the Zotero Web API v3 responses the client reads (#157). Loose objects:
 * only the fields the client relies on are checked, everything else passes through untouched, so a
 * full-object write sends back exactly what Zotero returned plus Izzy's edit.
 */

import { z } from 'zod';

/** `fetch` as the client uses it; injected in tests. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const userRefSchema = z.looseObject({
    id:       z.number().optional(),
    username: z.string().optional(),
});

/** An item's `data`: the editable fields, whose names depend on `itemType`. */
export const zoteroItemDataSchema = z.looseObject({
    key:      z.string(),
    version:  z.number(),
    itemType: z.string(),
});

export const zoteroItemSchema = z.looseObject({
    key:     z.string(),
    version: z.number(),
    meta:    z.looseObject({
        createdByUser:      userRefSchema.optional(),
        lastModifiedByUser: userRefSchema.optional(),
        numChildren:        z.number().optional(),
    }).optional(),
    data: zoteroItemDataSchema,
});

export const zoteroItemListSchema = z.array(zoteroItemSchema);

/** A collection's `data`. `parentCollection` is `false` at the top level. */
export const zoteroCollectionDataSchema = z.looseObject({
    key:              z.string(),
    version:          z.number(),
    name:             z.string(),
    parentCollection: z.union([z.string(), z.literal(false)]),
});

export const zoteroCollectionSchema = z.looseObject({
    key:     z.string(),
    version: z.number(),
    meta:    z.looseObject({
        numCollections: z.number().optional(),
        numItems:       z.number().optional(),
    }).optional(),
    data: zoteroCollectionDataSchema,
});

export const zoteroCollectionListSchema = z.array(zoteroCollectionSchema);

/** The response to a multi-object `POST /items` or `/collections`. Keys are the chunk-local indices. */
export const zoteroWriteResponseSchema = z.looseObject({
    successful: z.record(z.string(), z.looseObject({
        key:     z.string(),
        version: z.number(),
        data:    z.looseObject({}),
    })).optional(),
    unchanged: z.record(z.string(), z.string()).optional(),
    failed:    z.record(z.string(), z.looseObject({
        key:     z.string().optional(),
        code:    z.number(),
        message: z.string(),
    })).optional(),
});

/** An item template from `GET /items/new`. */
export const zoteroTemplateSchema = z.looseObject({
    itemType: z.string(),
});

/** Step 1 of the file upload: either the file is already stored, or where to upload it. */
export const zoteroUploadAuthorizationSchema = z.union([
    z.looseObject({ exists: z.literal(1) }),
    z.looseObject({
        url:         z.string(),
        contentType: z.string(),
        prefix:      z.string(),
        suffix:      z.string(),
        uploadKey:   z.string(),
    }),
]);

export type ZoteroItemData = z.infer<typeof zoteroItemDataSchema>;
export type ZoteroItem = z.infer<typeof zoteroItemSchema>;
export type ZoteroCollectionData = z.infer<typeof zoteroCollectionDataSchema>;
export type ZoteroCollection = z.infer<typeof zoteroCollectionSchema>;
export type ZoteroWriteResponse = z.infer<typeof zoteroWriteResponseSchema>;

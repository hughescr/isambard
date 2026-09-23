import { z } from 'zod';
import type { MediaFetchMetadata } from '@/utils';

// Re-export generic media types from utils
export {
    NATIVE_IMAGE_TYPES,
    CONVERTIBLE_IMAGE_TYPES,
    SUPPORTED_IMAGE_TYPES,
    MAX_IMAGE_SIZE_BYTES,
    FetchedImageSchema,
    type FetchedImage,
    isNativeImageType,
    isConvertibleImageType,
    isSupportedImageType,
    FailedMediaSchema as FailedAttachmentSchema
} from '@/utils';

// Schema for Discord attachment metadata
export const AttachmentMetadataSchema = z.object({
    url:         z.url(),
    filename:    z.string(),
    contentType: z.string(),
    size:        z.number().int().positive(),
    width:       z.number().int().positive().optional(),
    height:      z.number().int().positive().optional(),
}) satisfies z.ZodType<MediaFetchMetadata>;
export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>;

// `satisfies` alone is one-way: check surplus keys and optional/required drift too.
type AssertNever<T extends never> = T;
export type AttachmentMetadataShapeContract = [
    AssertNever<Exclude<keyof AttachmentMetadata, keyof MediaFetchMetadata>>,
    AssertNever<Exclude<keyof MediaFetchMetadata, keyof AttachmentMetadata>>,
    AssertNever<Exclude<MediaFetchMetadata, AttachmentMetadata>>
];

// Schema for non-image attachments stored to disk
export const StoredAttachmentSchema = z.object({
    localPath:        z.string(),
    originalFilename: z.string(),
    contentType:      z.string(),
    size:             z.number().int().positive(),
});
export type StoredAttachment = z.infer<typeof StoredAttachmentSchema>;

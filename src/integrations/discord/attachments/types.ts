import { z } from 'zod';

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
    isSupportedImageType
} from '@/utils';

// Schema for Discord attachment metadata
export const AttachmentMetadataSchema = z.object({
    url:         z.url(),
    filename:    z.string(),
    contentType: z.string(),
    size:        z.number().int().positive(),
    width:       z.number().int().positive().optional(),
    height:      z.number().int().positive().optional(),
});
export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>;

// Schema for non-image attachments stored to disk
export const StoredAttachmentSchema = z.object({
    localPath:        z.string(),
    originalFilename: z.string(),
    contentType:      z.string(),
    size:             z.number().int().positive(),
});
export type StoredAttachment = z.infer<typeof StoredAttachmentSchema>;

// Schema for failed attachment processing (Discord-specific alias)
export const FailedAttachmentSchema = z.object({
    filename:    z.string(),
    contentType: z.string(),
    size:        z.number().int().positive(),
    error:       z.string(),
});
export type FailedAttachment = z.infer<typeof FailedAttachmentSchema>;

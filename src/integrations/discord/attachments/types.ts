import { z } from 'zod';

// Claude-native formats (no conversion needed)
export const NATIVE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

// Convertible formats (heic-convert handles these)
export const CONVERTIBLE_IMAGE_TYPES = ['image/heic', 'image/heif'] as const;

// All supported image types
export const SUPPORTED_IMAGE_TYPES = [...NATIVE_IMAGE_TYPES, ...CONVERTIBLE_IMAGE_TYPES] as const;

// Claude's image size limit
export const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

// Schema for Discord attachment metadata
export const AttachmentMetadataSchema = z.object({
    url:         z.string().url(),
    filename:    z.string(),
    contentType: z.string(),
    size:        z.number().int().positive(),
    width:       z.number().int().positive().optional(),
    height:      z.number().int().positive().optional(),
});
export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>;

// Schema for fetched and processed image ready for Claude
export const FetchedImageSchema = z.object({
    filename:     z.string(),
    mediaType:    z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    base64Data:   z.string(),
    originalSize: z.number().int().positive(),
    width:        z.number().int().positive().optional(),
    height:       z.number().int().positive().optional(),
});
export type FetchedImage = z.infer<typeof FetchedImageSchema>;

// Schema for non-image attachments stored to disk
export const StoredAttachmentSchema = z.object({
    localPath:        z.string(),
    originalFilename: z.string(),
    contentType:      z.string(),
    size:             z.number().int().positive(),
});
export type StoredAttachment = z.infer<typeof StoredAttachmentSchema>;

// Schema for failed attachment processing
export const FailedAttachmentSchema = z.object({
    filename:    z.string(),
    contentType: z.string(),
    size:        z.number().int().positive(),
    error:       z.string(),
});
export type FailedAttachment = z.infer<typeof FailedAttachmentSchema>;

// Type guards
export function isNativeImageType(contentType: string): contentType is typeof NATIVE_IMAGE_TYPES[number] {
    return (NATIVE_IMAGE_TYPES as readonly string[]).includes(contentType);
}

export function isConvertibleImageType(contentType: string): contentType is typeof CONVERTIBLE_IMAGE_TYPES[number] {
    return (CONVERTIBLE_IMAGE_TYPES as readonly string[]).includes(contentType);
}

export function isSupportedImageType(contentType: string): boolean {
    return isNativeImageType(contentType) || isConvertibleImageType(contentType);
}

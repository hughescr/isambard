import type { BskyAuthor } from './types';

/**
 * Aspect ratio from Bluesky embed metadata.
 */
export interface BskyAspectRatio {
    width:  number
    height: number
}

/**
 * Normalized image from a Bluesky post embed.
 */
export interface BskyEmbedImage {
    thumb:        string   // thumbnail URL
    fullsize:     string   // full-size URL
    alt:          string   // alt text
    aspectRatio?: BskyAspectRatio
}

/**
 * Normalized video from a Bluesky post embed.
 */
export interface BskyEmbedVideo {
    cid:          string
    playlist:     string   // HLS playlist URL
    thumbnail?:   string   // thumbnail URL
    alt?:         string
    aspectRatio?: BskyAspectRatio
}

/**
 * Normalized external link card from a Bluesky post embed.
 */
export interface BskyEmbedExternal {
    uri:         string
    title:       string
    description: string
    thumbnail?:  string   // thumbnail URL
}

/**
 * Normalized embedded record (forwarded/quoted post).
 *
 * Note: facets from the quoted post's record value are not extracted.
 * Facet normalization requires async DID→handle resolution, but embedded
 * records are normalized synchronously within the embed chain.
 * The raw text is provided as-is; consumers should use the `text` field
 * for display without expecting resolved @mentions.
 */
export interface BskyEmbeddedRecord {
    uri:          string
    cid:          string
    author:       BskyAuthor
    text:         string
    createdAt:    string
    indexedAt:    string
    replyCount?:  number
    likeCount?:   number
    repostCount?: number
    embeds?:      BskyPostEmbed[]  // nested embeds on the quoted post
}

/**
 * Discriminated union of all Bluesky post embed types.
 */
export type BskyPostEmbed
    = | { type: 'images',          images: BskyEmbedImage[] }
      | { type: 'video',           video: BskyEmbedVideo }
      | { type: 'external',        external: BskyEmbedExternal }
      | { type: 'record',          record: BskyEmbeddedRecord }
      | { type: 'recordWithMedia', record: BskyEmbeddedRecord, media: BskyPostEmbed };

/**
 * Individual facet feature — mentions resolve to handles, not DIDs.
 */
export type BskyFacetFeature
    = | { type: 'mention', handle: string }
      | { type: 'link',    uri: string }
      | { type: 'tag',     tag: string };

/**
 * Normalized rich-text facet with byte-range index.
 */
export interface BskyFacet {
    index:    { byteStart: number, byteEnd: number }
    features: BskyFacetFeature[]
}

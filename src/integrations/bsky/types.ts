import { z } from 'zod';
import type { BskyPostEmbed, BskyFacet, BskyEmbeddedRecord } from './embeds';

/**
 * Normalized Bluesky author profile.
 */
export interface BskyAuthor {
    did:             string
    handle:          string
    displayName?:    string
    avatar?:         string
    description?:    string
    followersCount?: number
    followsCount?:   number
    postsCount?:     number
}

/**
 * An AT Protocol AT-URI (`at://...`), branded to prevent mixing with plain strings.
 * Construct with {@link createAtUri}.
 */
export const atUriSchema = z.string().min(1, 'AT URI cannot be empty').refine(v => v.startsWith('at://'), { message: 'AT URI must start with at://' }).brand<'AtUri'>();
export type AtUri = z.infer<typeof atUriSchema>;

/**
 * Parse a string into a branded {@link AtUri}. Throws a ZodError if `uri` is empty or
 * does not start with `at://`.
 */
export function createAtUri(uri: string): AtUri {
    return atUriSchema.parse(uri);
}

/**
 * An AT Protocol content hash (CID), branded to prevent mixing with plain strings.
 * Construct with {@link createCid}.
 */
export const cidSchema = z.string().min(1, 'CID cannot be empty').brand<'Cid'>();
export type Cid = z.infer<typeof cidSchema>;

/**
 * Parse a string into a branded {@link Cid}. Throws a ZodError if `cid` is empty.
 */
export function createCid(cid: string): Cid {
    return cidSchema.parse(cid);
}

/**
 * A strong reference to one revision of an AT Protocol record: an AT-URI plus the CID
 * of that specific revision. Mirrors the AT Protocol SDK's `com.atproto.repo.strongRef`
 * (`ComAtprotoRepoStrongRef`) — the two halves are meaningless apart, so they are always
 * carried together.
 */
export interface BskyStrongRef {
    uri: AtUri
    cid: Cid
}

/**
 * Input for replying to a post: the post being replied to (`parent`), and optionally the
 * thread root when it differs from the parent. An omitted `root` means the reply is a
 * top-level reply, i.e. the parent is also the root.
 */
export interface BskyReplyInput {
    parent: BskyStrongRef
    root?:  BskyStrongRef
}

/**
 * Reply reference identifying the root and parent of a threaded reply.
 * Mirrors AT Protocol's ReplyRef from AppBskyFeedPost.
 */
export interface BskyReplyRef {
    root:   BskyStrongRef
    parent: BskyStrongRef
}

/**
 * Viewer state reflecting the authenticated user's relationship with a post.
 * Mirrors AT Protocol's ViewerState from AppBskyFeedDefs.
 */
export interface BskyViewerState {
    like?:              string   // AT URI of your like record
    repost?:            string   // AT URI of your repost record
    bookmarked?:        boolean
    threadMuted?:       boolean
    replyDisabled?:     boolean
    embeddingDisabled?: boolean
    pinned?:            boolean
}

/**
 * Normalized Bluesky post.
 */
export interface BskyPost {
    uri:         string
    cid:         string
    author:      BskyAuthor
    text:        string
    createdAt:   string
    replyCount:  number
    likeCount:   number
    repostCount: number
    indexedAt:   string
    viewer?:     BskyViewerState
    replyRef?:   BskyReplyRef
    embed?:      BskyPostEmbed
    facets?:     BskyFacet[]
}

/**
 * Bluesky feed item with optional reply context.
 */
export interface BskyFeedItem {
    post:   BskyPost
    reply?: {
        parent: BskyPost
        root:   BskyPost
    }
}

/**
 * Bluesky notification.
 */
export interface BskyNotification {
    reason:    'like' | 'repost' | 'follow' | 'mention' | 'reply' | 'quote'
    uri:       string
    author:    BskyAuthor
    indexedAt: string
}

/**
 * Normalized Bluesky conversation member.
 * Internal types keep DIDs for allowlist checks; MCP responses strip them.
 */
export interface BskyConversationMember {
    did:           string
    handle:        string
    displayName?:  string
    avatar?:       string
    chatDisabled?: boolean
}

/**
 * Normalized Bluesky direct message.
 */
export interface BskyDirectMessage {
    id:        string
    rev:       string
    text:      string
    senderDid: string
    sentAt:    string
    embed?:    BskyEmbeddedRecord
    facets?:   BskyFacet[]
}

/**
 * Normalized Bluesky conversation.
 */
export interface BskyConversation {
    id:           string
    rev:          string
    members:      BskyConversationMember[]
    lastMessage?: BskyDirectMessage
    muted:        boolean
    unreadCount:  number
    status?:      string
}

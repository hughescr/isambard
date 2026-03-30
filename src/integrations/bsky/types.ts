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
 * Reply reference identifying the root and parent of a threaded reply.
 * Mirrors AT Protocol's ReplyRef from AppBskyFeedPost.
 */
export interface BskyReplyRef {
    root:   { uri: string, cid: string }
    parent: { uri: string, cid: string }
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

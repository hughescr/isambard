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

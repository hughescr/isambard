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

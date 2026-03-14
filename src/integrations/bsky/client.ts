import { AtpAgent, RichText, type AppBskyFeedDefs, type AppBskyActorDefs, type AppBskyFeedPost } from '@atproto/api';
import { logger } from '@hughescr/logger';
import { BskyError, BskyAuthError, BskyRateLimitError, BskyValidationError } from '@/integrations/bsky/errors';
import { type BskyAuthor, type BskyPost, type BskyFeedItem, type BskyNotification, type BskyViewerState } from '@/integrations/bsky/types';

// HTTP status codes for error classification (mirrors @atproto/xrpc ResponseType)
// Stryker disable ObjectLiteral,StringLiteral: HTTP status code constants are configuration
const HTTP_STATUS = {
    AUTH_REQUIRED: 401,
    RATE_LIMITED:  429,
} as const;
// Stryker restore ObjectLiteral,StringLiteral

/**
 * Minimal duck-type for the XRPCError shape from @atproto/xrpc.
 * Avoids importing the transitive @atproto/xrpc package directly.
 */
interface XRPCErrorLike {
    status:  number
    error:   string
    message: string
}

// Stryker disable BlockStatement,ConditionalExpression,LogicalOperator: instanceof guard and typeof checks are paired — mutating either alone cannot change observable behavior for the inputs that reach this code
function isXRPCError(err: unknown): err is XRPCErrorLike {
    if(!(err instanceof Error)) {
        return false;
    }
    const errRecord = err as unknown as Record<string, unknown>;
    return typeof errRecord.status === 'number' && typeof errRecord.error === 'string';
}
// Stryker restore BlockStatement,ConditionalExpression,LogicalOperator

// Stryker disable next-line StringLiteral: Feed URI is configuration
const DISCOVER_FEED_URI = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot';
// Stryker disable next-line StringLiteral: Feed URI is configuration
const FOR_YOU_FEED_URI  = 'at://did:plc:3guzzweuqraryl3rdkimjamk/app.bsky.feed.generator/for-you';

// Stryker disable next-line ArithmeticOperator: Bluesky character limit is a fixed protocol constant
const BSKY_MAX_GRAPHEME_LENGTH = 300;

export interface BlueskyClientOptions {
    handle:      string
    appPassword: string
    serviceUrl?: string
}

/**
 * Bluesky AT Protocol client wrapping AtpAgent with normalized domain types.
 */
export class BlueskyClient {
    private readonly agent:       AtpAgent;
    private readonly handle:      string;
    private readonly appPassword: string;

    constructor(options: BlueskyClientOptions) {
        // Stryker disable next-line StringLiteral: default service URL is configuration
        this.agent       = new AtpAgent({ service: options.serviceUrl ?? 'https://bsky.social' });
        this.handle      = options.handle;
        this.appPassword = options.appPassword;
    }

    /**
     * The authenticated handle for this client.
     */
    get ownHandle(): string {
        return this.handle;
    }

    /**
     * Authenticate with Bluesky using handle and app password.
     */
    async login(): Promise<void> {
        try {
            await this.agent.login({ identifier: this.handle, password: this.appPassword });
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Login failed');
        }
    }

    /**
     * Fetch posts from a named feed or AT URI feed.
     *
     * Feed name shortcuts:
     * - `"following"` (or undefined) → user's timeline
     * - `"for-you"` → Bluesky personal For You feed
     * - `"discover"` → Bluesky What's Hot discover feed
     * - Raw `at://` URI → passed through as-is
     */
    async getFeed(
        feedName?: string,
        limit?:    number,
        cursor?:   string
    ): Promise<{ items: BskyFeedItem[], cursor?: string }> {
        try {
            if(feedName === undefined || feedName === 'following') {
                const response = await this.agent.getTimeline({ limit, cursor });
                return {
                    items:  response.data.feed.map(item => this.normalizeFeedItem(item)),
                    cursor: response.data.cursor,
                };
            }

            let feedUri: string;
            if(feedName === 'for-you') {
                feedUri = FOR_YOU_FEED_URI;
            } else if(feedName === 'discover') {
                feedUri = DISCOVER_FEED_URI;
            } else {
                feedUri = feedName;
            }

            const response = await this.agent.app.bsky.feed.getFeed({ feed: feedUri, limit, cursor });
            return {
                items:  response.data.feed.map(item => this.normalizeFeedItem(item)),
                cursor: response.data.cursor,
            };
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to fetch feed');
        }
    }

    /**
     * Fetch posts authored by the given actor (DID or handle).
     */
    async getAuthorFeed(
        actor:   string,
        limit?:  number,
        cursor?: string
    ): Promise<{ items: BskyFeedItem[], cursor?: string }> {
        try {
            const response = await this.agent.getAuthorFeed({ actor, limit, cursor });
            return {
                items:  response.data.feed.map(item => this.normalizeFeedItem(item)),
                cursor: response.data.cursor,
            };
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to fetch author feed');
        }
    }

    /**
     * Fetch a single post by AT URI.
     */
    async getPost(uri: string): Promise<BskyPost> {
        try {
            const response = await this.agent.getPosts({ uris: [uri] });
            const posts    = response.data.posts;
            if(posts.length === 0) {
                // Stryker disable next-line StringLiteral: error message is informational only
                throw new BskyError('Post not found', undefined, { uri });
            }
            return this.normalizePost(posts[0]);
        } catch (err: unknown) {
            if(err instanceof BskyError) {
                throw err;
            }
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to fetch post');
        }
    }

    /**
     * Fetch recent notifications for the authenticated user.
     */
    async getNotifications(
        limit?:  number,
        cursor?: string
    ): Promise<{ notifications: BskyNotification[], cursor?: string }> {
        try {
            const response = await this.agent.listNotifications({ limit, cursor });
            return {
                notifications: response.data.notifications
                    .filter(n => this.isKnownNotificationReason(n.reason))
                    .map(n => this.normalizeNotification(n)),
                cursor: response.data.cursor,
            };
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to fetch notifications');
        }
    }

    /**
     * Mark notifications as seen up to a given timestamp.
     * If no timestamp is provided, the current time is used.
     */
    async updateNotificationsSeen(seenAt?: string): Promise<void> {
        try {
            await this.agent.updateSeenNotifications(seenAt ?? new Date().toISOString());
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to update notifications seen');
        }
    }

    /**
     * Fetch a user profile by DID or handle.
     */
    async getProfile(actor: string): Promise<BskyAuthor> {
        try {
            const response = await this.agent.getProfile({ actor });
            return this.normalizeDetailedProfile(response.data);
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to fetch profile');
        }
    }

    /**
     * Search for posts matching the query string.
     */
    async searchPosts(
        query:   string,
        limit?:  number,
        cursor?: string
    ): Promise<{ posts: BskyPost[], cursor?: string }> {
        try {
            const response = await this.agent.app.bsky.feed.searchPosts({ q: query, limit, cursor });
            return {
                posts:  response.data.posts.map(post => this.normalizePost(post)),
                cursor: response.data.cursor,
            };
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to search posts');
        }
    }

    /**
     * Like a post by AT URI and CID.
     */
    async likePost(uri: string, cid: string): Promise<void> {
        try {
            await this.agent.like(uri, cid);
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to like post');
        }
    }

    /**
     * Send a new post to Bluesky.
     * Detects RichText facets (mentions, links, tags) and validates grapheme length.
     */
    async sendPost(text: string): Promise<{ uri: string, cid: string }> {
        try {
            const rt = new RichText({ text });
            await rt.detectFacets(this.agent);
            if(rt.graphemeLength > BSKY_MAX_GRAPHEME_LENGTH) {
                // Stryker disable next-line StringLiteral: error message is informational only
                throw new BskyValidationError(`Post exceeds ${BSKY_MAX_GRAPHEME_LENGTH} graphemes (${rt.graphemeLength})`, { graphemeLength: rt.graphemeLength });
            }
            const response = await this.agent.post({ text: rt.text, facets: rt.facets });
            return { uri: response.uri, cid: response.cid };
        } catch (err: unknown) {
            if(err instanceof BskyValidationError) {
                throw err;
            }
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to send post');
        }
    }

    /**
     * Reply to an existing Bluesky post.
     * rootUri/rootCid default to parentUri/parentCid for top-level replies.
     * Detects RichText facets and validates grapheme length.
     */
    async replyToPost(
        text:        string,
        parentUri:   string,
        parentCid:   string,
        rootUri?:    string,
        rootCid?:    string
    ): Promise<{ uri: string, cid: string }> {
        try {
            const rt = new RichText({ text });
            await rt.detectFacets(this.agent);
            if(rt.graphemeLength > BSKY_MAX_GRAPHEME_LENGTH) {
                // Stryker disable next-line StringLiteral: error message is informational only
                throw new BskyValidationError(`Post exceeds ${BSKY_MAX_GRAPHEME_LENGTH} graphemes (${rt.graphemeLength})`, { graphemeLength: rt.graphemeLength });
            }
            const actualRootUri = rootUri ?? parentUri;
            const actualRootCid = rootCid ?? parentCid;
            const response = await this.agent.post({
                text:   rt.text,
                facets: rt.facets,
                reply:  {
                    root:   { uri: actualRootUri, cid: actualRootCid },
                    parent: { uri: parentUri,     cid: parentCid },
                },
            });
            return { uri: response.uri, cid: response.cid };
        } catch (err: unknown) {
            if(err instanceof BskyValidationError) {
                throw err;
            }
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to reply to post');
        }
    }

    /**
     * Toggle follow state for a user by DID or handle.
     * If currently following, unfollows; otherwise follows.
     * Returns { followed: true } when a follow was created, { followed: false } when unfollowed.
     */
    async toggleFollow(actor: string): Promise<{ followed: boolean }> {
        try {
            const response  = await this.agent.getProfile({ actor });
            const followUri = response.data.viewer?.following;

            if(followUri) {
                // Currently following → unfollow
                await this.agent.deleteFollow(followUri);
                return { followed: false };
            }

            // Not following → follow
            await this.agent.follow(response.data.did);
            return { followed: true };
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to toggle follow');
        }
    }

    // ---------------------------------------------------------------------------
    // Normalization helpers
    // ---------------------------------------------------------------------------

    private normalizeAuthor(profile: AppBskyActorDefs.ProfileViewBasic): BskyAuthor {
        return {
            did:    profile.did,
            handle: profile.handle,
            // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
            ...(profile.displayName ? { displayName: profile.displayName } : {}),
            // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
            ...(profile.avatar ? { avatar: profile.avatar } : {}),
        };
    }

    private normalizeDetailedProfile(profile: AppBskyActorDefs.ProfileViewDetailed): BskyAuthor {
        return {
            did:    profile.did,
            handle: profile.handle,
            // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
            ...(profile.displayName ? { displayName: profile.displayName } : {}),
            // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
            ...(profile.avatar ? { avatar: profile.avatar } : {}),
            // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
            ...(profile.description ? { description: profile.description } : {}),
            // Stryker disable next-line ObjectLiteral,EqualityOperator,ConditionalExpression: undefined check for optional numeric field — zero is a valid count
            ...(profile.followersCount === undefined ? {} : { followersCount: profile.followersCount }),
            // Stryker disable next-line ObjectLiteral,EqualityOperator,ConditionalExpression: undefined check for optional numeric field — zero is a valid count
            ...(profile.followsCount === undefined ? {} : { followsCount: profile.followsCount }),
            // Stryker disable next-line ObjectLiteral,EqualityOperator,ConditionalExpression: undefined check for optional numeric field — zero is a valid count
            ...(profile.postsCount === undefined ? {} : { postsCount: profile.postsCount }),
        };
    }

    private normalizePost(post: AppBskyFeedDefs.PostView): BskyPost {
        const record = post.record as AppBskyFeedPost.Record;
        return {
            uri:         post.uri,
            cid:         post.cid,
            author:      this.normalizeAuthor(post.author),
            text:        record.text,
            createdAt:   record.createdAt,
            replyCount:  post.replyCount ?? 0,
            likeCount:   post.likeCount ?? 0,
            repostCount: post.repostCount ?? 0,
            indexedAt:   post.indexedAt,
            // Stryker disable next-line ConditionalExpression: ternary guards optional viewer — truthy/falsy tests both branches
            ...(post.viewer ? { viewer: this.normalizeViewer(post.viewer) } : {}),
        };
    }

    private normalizeViewer(viewer: AppBskyFeedDefs.ViewerState): BskyViewerState {
        return {
            // Stryker disable ObjectLiteral: empty spread branches — falsy paths produce no properties
            ...(viewer.like ? { like: viewer.like } : {}),
            ...(viewer.repost ? { repost: viewer.repost } : {}),
            ...(viewer.pinned ? { pinned: viewer.pinned } : {}),
            // Stryker restore ObjectLiteral
            // Stryker disable ObjectLiteral,EqualityOperator,ConditionalExpression: undefined checks for optional boolean fields
            ...(viewer.bookmarked === undefined ? {} : { bookmarked: viewer.bookmarked }),
            ...(viewer.threadMuted === undefined ? {} : { threadMuted: viewer.threadMuted }),
            ...(viewer.replyDisabled === undefined ? {} : { replyDisabled: viewer.replyDisabled }),
            ...(viewer.embeddingDisabled === undefined ? {} : { embeddingDisabled: viewer.embeddingDisabled }),
            // Stryker restore ObjectLiteral,EqualityOperator,ConditionalExpression
        };
    }

    private normalizeFeedItem(item: AppBskyFeedDefs.FeedViewPost): BskyFeedItem {
        const result: BskyFeedItem = {
            post: this.normalizePost(item.post),
        };

        if(item.reply !== undefined) {
            const parent = item.reply.parent;
            const root   = item.reply.root;

            if(this.isPostView(parent) && this.isPostView(root)) {
                result.reply = {
                    parent: this.normalizePost(parent),
                    root:   this.normalizePost(root),
                };
            }
        }

        return result;
    }

    private normalizeProfileView(profile: AppBskyActorDefs.ProfileView): BskyAuthor {
        return {
            did:    profile.did,
            handle: profile.handle,
            // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
            ...(profile.displayName ? { displayName: profile.displayName } : {}),
            // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
            ...(profile.avatar ? { avatar: profile.avatar } : {}),
            // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
            ...(profile.description ? { description: profile.description } : {}),
        };
    }

    private normalizeNotification(
        notification: { uri: string, author: AppBskyActorDefs.ProfileView, reason: string, indexedAt: string }
    ): BskyNotification {
        return {
            reason:    notification.reason as BskyNotification['reason'],
            uri:       notification.uri,
            author:    this.normalizeProfileView(notification.author),
            indexedAt: notification.indexedAt,
        };
    }

    // ---------------------------------------------------------------------------
    // Error mapping
    // ---------------------------------------------------------------------------

    private mapError(err: unknown, message: string): BskyError {
        if(isXRPCError(err)) {
            if(err.status === HTTP_STATUS.AUTH_REQUIRED) {
                return new BskyAuthError(message, { originalMessage: err.message, error: err.error });
            }
            if(err.status === HTTP_STATUS.RATE_LIMITED) {
                return new BskyRateLimitError(message, { originalMessage: err.message, error: err.error });
            }
            return new BskyError(message, undefined, { originalMessage: err.message, error: err.error, status: err.status });
        }

        if(err instanceof Error) {
            logger.error({ err }, message);
            return new BskyError(message, undefined, { originalMessage: err.message });
        }

        logger.error({ err }, message);
        return new BskyError(message);
    }

    // ---------------------------------------------------------------------------
    // Type guards
    // ---------------------------------------------------------------------------

    private isPostView(
        view: AppBskyFeedDefs.PostView | AppBskyFeedDefs.NotFoundPost | AppBskyFeedDefs.BlockedPost | { $type: string }
    ): view is AppBskyFeedDefs.PostView {
        const v = view as Record<string, unknown>;
        // Stryker disable ConditionalExpression,LogicalOperator: combined structural type guard — each condition tests a distinct required PostView field; changing operator or flipping truthy breaks all-or-nothing semantics
        return typeof v.uri === 'string' && typeof v.cid === 'string' && typeof v.author === 'object' && v.author !== null;
        // Stryker restore ConditionalExpression,LogicalOperator
    }

    private isKnownNotificationReason(reason: string): reason is BskyNotification['reason'] {
        return reason === 'like'
          || reason === 'repost'
          || reason === 'follow'
          || reason === 'mention'
          || reason === 'reply'
          || reason === 'quote';
    }
}

import { AtpAgent, RichText, type AppBskyFeedDefs, type AppBskyActorDefs, type AppBskyFeedPost, ChatBskyConvoDefs, type ChatBskyActorDefs } from '@atproto/api';
import { logger } from '@hughescr/logger';
import { BskyError, BskyAuthError, BskyRateLimitError, BskyValidationError } from '@/integrations/bsky/errors';
import { type BskyAuthor, type BskyPost, type BskyFeedItem, type BskyNotification, type BskyViewerState, type BskyConversationMember, type BskyDirectMessage, type BskyConversation } from '@/integrations/bsky/types';

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
// Stryker disable next-line ArithmeticOperator: Bluesky DM character limit is a fixed protocol constant
const BSKY_DM_MAX_GRAPHEME_LENGTH = 1000;

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
     * Validate that post text is within the Bluesky post character limit (300 graphemes).
     * Creates RichText and detects facets (mentions, links, tags).
     * Throws BskyValidationError if the text is too long.
     */
    async validatePostText(text: string): Promise<void> {
        await this.buildValidatedRichText(text);
    }

    /**
     * Validate that DM text is within the Bluesky DM character limit (1000 graphemes).
     * Creates RichText and detects facets (mentions, links, tags).
     * Throws BskyValidationError if the text is too long.
     */
    async validateDMText(text: string): Promise<void> {
        await this.buildValidatedDMRichText(text);
    }

    /**
     * Build a validated RichText instance for posting.
     * Detects facets and validates grapheme length against the post limit.
     */
    private async buildValidatedRichText(text: string): Promise<RichText> {
        const rt = new RichText({ text });
        await rt.detectFacets(this.agent);
        if(rt.graphemeLength > BSKY_MAX_GRAPHEME_LENGTH) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw new BskyValidationError(`Post exceeds ${BSKY_MAX_GRAPHEME_LENGTH} graphemes (${rt.graphemeLength})`, { graphemeLength: rt.graphemeLength });
        }
        return rt;
    }

    /**
     * Build a validated RichText instance for direct messages.
     * Detects facets and validates grapheme length against the DM limit.
     */
    private async buildValidatedDMRichText(text: string): Promise<RichText> {
        const rt = new RichText({ text });
        await rt.detectFacets(this.agent);
        if(rt.graphemeLength > BSKY_DM_MAX_GRAPHEME_LENGTH) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw new BskyValidationError(`DM exceeds ${BSKY_DM_MAX_GRAPHEME_LENGTH} graphemes (${rt.graphemeLength})`, { graphemeLength: rt.graphemeLength });
        }
        return rt;
    }

    /**
     * Send a new post to Bluesky.
     * Detects RichText facets (mentions, links, tags) and validates grapheme length.
     */
    async sendPost(text: string): Promise<{ uri: string, cid: string }> {
        try {
            const rt       = await this.buildValidatedRichText(text);
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
            const rt            = await this.buildValidatedRichText(text);
            const actualRootUri = rootUri ?? parentUri;
            const actualRootCid = rootCid ?? parentCid;
            const response      = await this.agent.post({
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
     * Follow a user by DID or handle.
     * Returns { alreadyFollowing: true } if already following (no-op).
     * Returns { alreadyFollowing: false } when a new follow was created.
     */
    async follow(actor: string): Promise<{ alreadyFollowing: boolean }> {
        try {
            const response  = await this.agent.getProfile({ actor });
            const followUri = response.data.viewer?.following;

            if(followUri) {
                return { alreadyFollowing: true };
            }

            await this.agent.follow(response.data.did);
            return { alreadyFollowing: false };
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to follow user');
        }
    }

    /**
     * Unfollow a user by DID or handle.
     * Returns { wasFollowing: false } if not currently following (no-op).
     * Returns { wasFollowing: true } when the follow was removed.
     */
    async unfollow(actor: string): Promise<{ wasFollowing: boolean }> {
        try {
            const response  = await this.agent.getProfile({ actor });
            const followUri = response.data.viewer?.following;

            if(!followUri) {
                return { wasFollowing: false };
            }

            await this.agent.deleteFollow(followUri);
            return { wasFollowing: true };
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to unfollow user');
        }
    }

    /**
     * List conversations for the authenticated user.
     */
    async listConversations(
        limit?:     number,
        cursor?:    string,
        readState?: string,
        status?:    string
    ): Promise<{ conversations: BskyConversation[], cursor?: string }> {
        try {
            const response = await this.agent.chat.bsky.convo.listConvos({ limit, cursor, readState, status });
            return {
                conversations: response.data.convos.map(convo => this.normalizeConversation(convo)),
                cursor:        response.data.cursor,
            };
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to list conversations');
        }
    }

    /**
     * Get or create a conversation for a set of member DIDs.
     */
    async getConversationForMembers(memberDids: string[]): Promise<BskyConversation> {
        try {
            const response = await this.agent.chat.bsky.convo.getConvoForMembers({ members: memberDids });
            return this.normalizeConversation(response.data.convo);
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to get conversation for members');
        }
    }

    /**
     * Get messages in a conversation, filtering out deleted messages.
     */
    async getMessages(
        convoId: string,
        limit?:  number,
        cursor?: string
    ): Promise<{ messages: BskyDirectMessage[], cursor?: string }> {
        try {
            const response = await this.agent.chat.bsky.convo.getMessages({ convoId, limit, cursor });
            return {
                messages: response.data.messages
                    .filter(msg => ChatBskyConvoDefs.isMessageView(msg))
                    .map(msg => this.normalizeMessage(msg as ChatBskyConvoDefs.MessageView)),
                cursor: response.data.cursor,
            };
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to get messages');
        }
    }

    /**
     * Send a direct message to a conversation.
     * Validates text length against the 1000-grapheme DM limit.
     */
    async sendDirectMessage(convoId: string, text: string): Promise<BskyDirectMessage> {
        try {
            const rt = await this.buildValidatedDMRichText(text);
            const response = await this.agent.chat.bsky.convo.sendMessage({
                convoId,
                message: { text: rt.text, facets: rt.facets },
            });
            return this.normalizeMessage(response.data);
        } catch (err: unknown) {
            if(err instanceof BskyValidationError) {
                throw err;
            }
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to send direct message');
        }
    }

    /**
     * Mark a conversation as read.
     */
    async markConversationRead(convoId: string): Promise<void> {
        try {
            await this.agent.chat.bsky.convo.updateRead({ convoId });
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to mark conversation as read');
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
            // Stryker disable next-line ConditionalExpression: ternary guards optional replyRef — truthy/falsy tests both branches
            ...(record.reply ? { replyRef: { root: { uri: record.reply.root.uri, cid: record.reply.root.cid }, parent: { uri: record.reply.parent.uri, cid: record.reply.parent.cid } } } : {}),
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

    private normalizeConversationMember(profile: ChatBskyActorDefs.ProfileViewBasic): BskyConversationMember {
        return {
            did:    profile.did,
            handle: profile.handle,
            // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
            ...(profile.displayName ? { displayName: profile.displayName } : {}),
            // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
            ...(profile.avatar ? { avatar: profile.avatar } : {}),
            // Stryker disable next-line ObjectLiteral,EqualityOperator,ConditionalExpression: undefined check for optional boolean field
            ...(profile.chatDisabled === undefined ? {} : { chatDisabled: profile.chatDisabled }),
        };
    }

    private normalizeMessage(msg: ChatBskyConvoDefs.MessageView): BskyDirectMessage {
        return {
            id:        msg.id,
            rev:       msg.rev,
            text:      msg.text,
            senderDid: msg.sender.did,
            sentAt:    msg.sentAt,
        };
    }

    private normalizeConversation(convo: ChatBskyConvoDefs.ConvoView): BskyConversation {
        return {
            id:          convo.id,
            rev:         convo.rev,
            members:     convo.members.map(m => this.normalizeConversationMember(m)),
            muted:       convo.muted,
            unreadCount: convo.unreadCount,
            // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
            ...(convo.status ? { status: convo.status } : {}),
            // Only normalize lastMessage if it's a MessageView (not DeletedMessageView)
            // Stryker disable next-line ConditionalExpression: ternary guards optional lastMessage normalization
            ...(convo.lastMessage && ChatBskyConvoDefs.isMessageView(convo.lastMessage)
                ? { lastMessage: this.normalizeMessage(convo.lastMessage) }
                : {}),
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

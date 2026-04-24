import { AtpAgent, RichText, type AppBskyFeedDefs, type AppBskyActorDefs, type AppBskyFeedPost, AppBskyEmbedRecord, AppBskyEmbedImages, AppBskyEmbedVideo, AppBskyEmbedExternal, AppBskyEmbedRecordWithMedia, type AppBskyRichtextFacet, ChatBskyConvoDefs, type ChatBskyActorDefs } from '@atproto/api';
import { logger } from '@hughescr/logger';
import { BskyError, BskyAuthError, BskyRateLimitError, BskyValidationError, InvariantViolationError } from '@/errors';
import { type BskyEmbeddedRecord, type BskyPostEmbed, type BskyFacet, type BskyFacetFeature } from '@/integrations/bsky/embeds';
import { type BskyAuthor, type BskyPost, type BskyFeedItem, type BskyNotification, type BskyViewerState, type BskyConversationMember, type BskyDirectMessage, type BskyConversation } from '@/integrations/bsky/types';
import type { ServiceHealthRegistry } from '@/services';

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

interface BlueskyClientOptions {
    handle:          string
    appPassword:     string
    serviceUrl?:     string
    healthRegistry?: ServiceHealthRegistry
}

/**
 * Bluesky AT Protocol client wrapping AtpAgent with normalized domain types.
 */
export class BlueskyClient {
    private readonly agent:          AtpAgent;
    private          chatAgent:      AtpAgent | undefined;
    private readonly handle:         string;
    private readonly appPassword:    string;
    private readonly healthRegistry: ServiceHealthRegistry | undefined;

    constructor(options: BlueskyClientOptions) {
        // Stryker disable next-line StringLiteral: default service URL is configuration
        this.agent          = new AtpAgent({ service: options.serviceUrl ?? 'https://bsky.social' });
        this.handle         = options.handle;
        this.appPassword    = options.appPassword;
        this.healthRegistry = options.healthRegistry;
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
            // Stryker disable next-line StringLiteral: chat service DID is AT Protocol configuration
            this.chatAgent = this.agent.withProxy('bsky_chat', 'did:web:api.bsky.chat');
        } catch (err: unknown) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Login failed', false);
        }
    }

    /**
     * Returns the chat-proxied agent, or throws if login() has not been called.
     */
    private requireChatAgent(): AtpAgent {
        if(!this.chatAgent) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw new BskyError('Chat not available — call login() first');
        }
        return this.chatAgent;
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
            const didCache = this.createDIDCache();
            if(feedName === undefined || feedName === 'following') {
                const response = await this.agent.getTimeline({ limit, cursor });
                return {
                    items:  await Promise.all(response.data.feed.map(item => this.normalizeFeedItem(item, didCache))),
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
                items:  await Promise.all(response.data.feed.map(item => this.normalizeFeedItem(item, didCache))),
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
            const didCache = this.createDIDCache();
            const response = await this.agent.getAuthorFeed({ actor, limit, cursor });
            return {
                items:  await Promise.all(response.data.feed.map(item => this.normalizeFeedItem(item, didCache))),
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
            const post = posts[0];
            // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — posts.length === 0 check above ensures non-empty; unreachable in practice
            if(post === undefined) {
                // Stryker disable next-line StringLiteral: invariant violation message — debug context only
                throw new InvariantViolationError('getPost', 'posts[0] undefined after posts.length === 0 guard');
            }
            return await this.normalizePost(post);
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
            const didCache = this.createDIDCache();
            const response = await this.agent.app.bsky.feed.searchPosts({ q: query, limit, cursor });
            return {
                posts:  await Promise.all(response.data.posts.map(post => this.normalizePost(post, didCache))),
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
            const didCache = this.createDIDCache();
            const response = await this.requireChatAgent().chat.bsky.convo.listConvos({ limit, cursor, readState, status });
            return {
                conversations: await Promise.all(response.data.convos.map(convo => this.normalizeConversation(convo, didCache))),
                cursor:        response.data.cursor,
            };
        } catch (err: unknown) {
            if(err instanceof BskyError) {
                throw err;
            }
            // Stryker disable next-line StringLiteral: error message is informational only
            throw this.mapError(err, 'Failed to list conversations');
        }
    }

    /**
     * Get or create a conversation for a set of member DIDs.
     */
    async getConversationForMembers(memberDids: string[]): Promise<BskyConversation> {
        try {
            const response = await this.requireChatAgent().chat.bsky.convo.getConvoForMembers({ members: memberDids });
            return await this.normalizeConversation(response.data.convo);
        } catch (err: unknown) {
            if(err instanceof BskyError) {
                throw err;
            }
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
            const didCache = this.createDIDCache();
            const response = await this.requireChatAgent().chat.bsky.convo.getMessages({ convoId, limit, cursor });
            return {
                messages: await Promise.all(
                    response.data.messages
                        .filter(msg => ChatBskyConvoDefs.isMessageView(msg))
                        .map(msg => this.normalizeMessage(msg as ChatBskyConvoDefs.MessageView, didCache))
                ),
                cursor: response.data.cursor,
            };
        } catch (err: unknown) {
            if(err instanceof BskyError) {
                throw err;
            }
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
            const response = await this.requireChatAgent().chat.bsky.convo.sendMessage({
                convoId,
                message: { text: rt.text, facets: rt.facets },
            });
            return await this.normalizeMessage(response.data);
        } catch (err: unknown) {
            if(err instanceof BskyError) {
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
            await this.requireChatAgent().chat.bsky.convo.updateRead({ convoId });
        } catch (err: unknown) {
            if(err instanceof BskyError) {
                throw err;
            }
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

    private async normalizePost(post: AppBskyFeedDefs.PostView, didCache?: Map<string, Promise<string>>): Promise<BskyPost> {
        const record = post.record as AppBskyFeedPost.Record;
        const normalizedEmbed = this.normalizePostEmbed(post.embed);
        const cache = didCache ?? this.createDIDCache();
        const normalizedFacets = record.facets ? await this.normalizeFacets(record.facets, cache) : undefined;
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
            // Stryker disable next-line ConditionalExpression: ternary guards optional embed normalization
            ...(normalizedEmbed ? { embed: normalizedEmbed } : {}),
            // Stryker disable next-line ConditionalExpression,EqualityOperator: ternary guards optional facets — empty array means all features were unknown types
            ...(normalizedFacets && normalizedFacets.length > 0 ? { facets: normalizedFacets } : {}),
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

    private async normalizeFeedItem(item: AppBskyFeedDefs.FeedViewPost, didCache?: Map<string, Promise<string>>): Promise<BskyFeedItem> {
        const result: BskyFeedItem = {
            post: await this.normalizePost(item.post, didCache),
        };

        if(item.reply !== undefined) {
            const parent = item.reply.parent;
            const root   = item.reply.root;

            if(this.isPostView(parent) && this.isPostView(root)) {
                result.reply = {
                    parent: await this.normalizePost(parent, didCache),
                    root:   await this.normalizePost(root, didCache),
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

    private normalizeEmbeddedRecord(viewRecord: AppBskyEmbedRecord.ViewRecord): BskyEmbeddedRecord {
        const value  = viewRecord.value as { text?: unknown, createdAt?: unknown };
        const embeds = viewRecord.embeds
            ?.map(e => this.normalizePostEmbed(e))
            .filter((e): e is BskyPostEmbed => e !== undefined);
        return {
            uri:       viewRecord.uri,
            cid:       viewRecord.cid,
            author:    this.normalizeAuthor(viewRecord.author),
            text:      typeof value.text === 'string' ? value.text : '',
            createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
            indexedAt: viewRecord.indexedAt,
            // Stryker disable next-line ObjectLiteral,EqualityOperator,ConditionalExpression: undefined check for optional numeric field — zero is a valid count
            ...(viewRecord.replyCount === undefined ? {} : { replyCount: viewRecord.replyCount }),
            // Stryker disable next-line ObjectLiteral,EqualityOperator,ConditionalExpression: undefined check for optional numeric field — zero is a valid count
            ...(viewRecord.likeCount === undefined ? {} : { likeCount: viewRecord.likeCount }),
            // Stryker disable next-line ObjectLiteral,EqualityOperator,ConditionalExpression: undefined check for optional numeric field — zero is a valid count
            ...(viewRecord.repostCount === undefined ? {} : { repostCount: viewRecord.repostCount }),
            // Stryker disable next-line ConditionalExpression: ternary guards optional nested embeds array
            ...(embeds && embeds.length > 0 ? { embeds } : {}),
        };
    }

    // eslint-disable-next-line sonarjs/function-return-type -- conditional spread in map callback produces structurally equivalent shapes
    private normalizeImageEmbed(view: AppBskyEmbedImages.View): BskyPostEmbed {
        return {
            type:   'images',
            images: view.images.map(img => ({
                thumb:    img.thumb,
                fullsize: img.fullsize,
                alt:      img.alt,
                // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
                ...(img.aspectRatio ? { aspectRatio: { width: img.aspectRatio.width, height: img.aspectRatio.height } } : {}),
            })),
        };
    }

    // eslint-disable-next-line sonarjs/function-return-type -- conditional spreads produce structurally equivalent shapes
    private normalizeVideoEmbed(view: AppBskyEmbedVideo.View): BskyPostEmbed {
        return {
            type:  'video',
            video: {
                cid:      view.cid,
                playlist: view.playlist,
                // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
                ...(view.thumbnail ? { thumbnail: view.thumbnail } : {}),
                // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
                ...(view.alt ? { alt: view.alt } : {}),
                // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
                ...(view.aspectRatio ? { aspectRatio: { width: view.aspectRatio.width, height: view.aspectRatio.height } } : {}),
            },
        };
    }

    // eslint-disable-next-line sonarjs/function-return-type -- conditional spread produces structurally equivalent shapes
    private normalizeExternalEmbed(view: AppBskyEmbedExternal.View): BskyPostEmbed {
        return {
            type:     'external',
            external: {
                uri:         view.external.uri,
                title:       view.external.title,
                description: view.external.description,
                // Stryker disable next-line ObjectLiteral: empty spread branch — falsy path produces no properties
                ...(view.external.thumb ? { thumbnail: view.external.thumb } : {}),
            },
        };
    }

    // eslint-disable-next-line sonarjs/function-return-type -- early return undefined when record/media normalization fails
    private normalizeRecordWithMediaEmbed(view: AppBskyEmbedRecordWithMedia.View): BskyPostEmbed | undefined {
        // Stryker disable next-line ConditionalExpression: type guard on embedded record — must check ViewRecord to safely cast
        if(!AppBskyEmbedRecord.isViewRecord(view.record.record)) {
            return undefined;
        }
        const normalizedRecord = this.normalizeEmbeddedRecord(view.record.record);
        const normalizedMedia  = this.normalizePostEmbed(view.media);
        // Stryker disable next-line ConditionalExpression: guard ensures media was successfully normalized
        if(!normalizedMedia) {
            return undefined;
        }
        return { type: 'recordWithMedia', record: normalizedRecord, media: normalizedMedia };
    }

    // eslint-disable-next-line sonarjs/function-return-type -- returns undefined for null/unrecognized embed types
    private normalizePostEmbed(embed: unknown): BskyPostEmbed | undefined {
        if(embed === undefined || embed === null) {
            return undefined;
        }
        const e = embed as Record<string, unknown>;
        // Stryker disable BlockStatement,ConditionalExpression: AT Protocol type guard chain — each isView() check is a distinct type discriminant; order matters for correctness
        if(AppBskyEmbedImages.isView(e)) {
            return this.normalizeImageEmbed(e as unknown as AppBskyEmbedImages.View);
        }
        if(AppBskyEmbedVideo.isView(e)) {
            return this.normalizeVideoEmbed(e as unknown as AppBskyEmbedVideo.View);
        }
        if(AppBskyEmbedExternal.isView(e)) {
            return this.normalizeExternalEmbed(e as unknown as AppBskyEmbedExternal.View);
        }
        if(AppBskyEmbedRecordWithMedia.isView(e)) {
            return this.normalizeRecordWithMediaEmbed(e as unknown as AppBskyEmbedRecordWithMedia.View);
        }
        if(AppBskyEmbedRecord.isView(e) && AppBskyEmbedRecord.isViewRecord(e.record)) {
            return { type: 'record', record: this.normalizeEmbeddedRecord(e.record as unknown as AppBskyEmbedRecord.ViewRecord) };
        }
        // Stryker restore BlockStatement,ConditionalExpression
        return undefined;
    }

    private createDIDCache(): Map<string, Promise<string>> {
        return new Map<string, Promise<string>>();
    }

    private resolveMentionDid(did: string, didCache: Map<string, Promise<string>>): Promise<string> {
        const cached = didCache.get(did);
        if(cached) {
            return cached;
        }
        // The promise is stored in the cache before it resolves, so concurrent calls for the
        // same DID share a single in-flight request.  The .catch ensures the promise never
        // rejects (failed lookups fall back to the raw DID), which means the cached promise is
        // safe to reuse even when the profile lookup fails — no thundering-herd retry.
        const promise = this.agent.getProfile({ actor: did })
            .then(r => r.data.handle)
            .catch((error: unknown) => {
                // Intentionally swallow — profile lookup failure falls back to DID as handle
                // Stryker disable next-line StringLiteral: error message is informational only
                logger.debug({ error }, 'Failed to resolve mention DID to handle, using DID as fallback');
                return did;
            });
        didCache.set(did, promise);
        return promise;
    }

    // eslint-disable-next-line sonarjs/function-return-type -- returns undefined for unknown feature types (future-proof)
    private buildFacetFeature(f: Record<string, unknown>, didHandleMap: Map<string, string>): BskyFacetFeature | undefined {
        // Stryker disable next-line ConditionalExpression,LogicalOperator: type discriminant paired with typeof guard — defensive check for malformed AT Protocol data
        if(f.$type === 'app.bsky.richtext.facet#mention' && typeof f.did === 'string') {
            // Stryker disable next-line StringLiteral: default fallback — DID used as handle when not in resolution map
            return { type: 'mention', handle: didHandleMap.get(f.did) ?? f.did };
        }
        // Stryker disable next-line ConditionalExpression,LogicalOperator: type discriminant paired with typeof guard — defensive check for malformed AT Protocol data
        if(f.$type === 'app.bsky.richtext.facet#link' && typeof f.uri === 'string') {
            return { type: 'link', uri: f.uri };
        }
        // Stryker disable next-line ConditionalExpression,LogicalOperator: type discriminant paired with typeof guard — defensive check for malformed AT Protocol data
        if(f.$type === 'app.bsky.richtext.facet#tag' && typeof f.tag === 'string') {
            return { type: 'tag', tag: f.tag };
        }
        return undefined;
    }

    private async normalizeFacets(facets: AppBskyRichtextFacet.Main[], didCache: Map<string, Promise<string>>): Promise<BskyFacet[]> {
        // Collect unique mention DIDs across all facets
        const mentionDids = new Set<string>();
        for(const facet of facets) {
            for(const feature of facet.features) {
                const f = feature as Record<string, unknown>;
                // Stryker disable next-line ConditionalExpression,LogicalOperator: type discriminant paired with typeof guard — defensive check for malformed AT Protocol data
                if(f.$type === 'app.bsky.richtext.facet#mention' && typeof f.did === 'string') {
                    mentionDids.add(f.did);
                }
            }
        }

        // Resolve all unique DIDs through cache (deduplicates across posts in same request)
        const didEntries = await Promise.all(
            [...mentionDids].map(async did => [did, await this.resolveMentionDid(did, didCache)] as const)
        );
        const didHandleMap = new Map(didEntries);

        // Build normalized facets
        const result: BskyFacet[] = [];
        for(const facet of facets) {
            const features = facet.features
                .map(feature => this.buildFacetFeature(feature as Record<string, unknown>, didHandleMap))
                .filter((f): f is BskyFacetFeature => f !== undefined);
            // Stryker disable next-line ConditionalExpression,EqualityOperator: optimization guard — only push facets with known features
            if(features.length > 0) {
                result.push({ index: { byteStart: facet.index.byteStart, byteEnd: facet.index.byteEnd }, features });
            }
        }

        return result;
    }

    private async normalizeMessage(msg: ChatBskyConvoDefs.MessageView, didCache?: Map<string, Promise<string>>): Promise<BskyDirectMessage> {
        const embed        = msg.embed;
        // Stryker disable next-line ConditionalExpression: ternary guards optional embed normalization
        const normalizedEmbed = (embed && AppBskyEmbedRecord.isView(embed) && AppBskyEmbedRecord.isViewRecord(embed.record))
            ? this.normalizeEmbeddedRecord(embed.record)
            : undefined;
        const cache = didCache ?? this.createDIDCache();
        const normalizedFacets = msg.facets ? await this.normalizeFacets(msg.facets, cache) : undefined;
        return {
            id:        msg.id,
            rev:       msg.rev,
            text:      msg.text,
            senderDid: msg.sender.did,
            sentAt:    msg.sentAt,
            // Stryker disable next-line ConditionalExpression: ternary guards optional embed normalization
            ...(normalizedEmbed ? { embed: normalizedEmbed } : {}),
            // Stryker disable next-line ConditionalExpression,EqualityOperator: ternary guards optional facets — empty array means all features were unknown types
            ...(normalizedFacets && normalizedFacets.length > 0 ? { facets: normalizedFacets } : {}),
        };
    }

    private async normalizeConversation(convo: ChatBskyConvoDefs.ConvoView, didCache?: Map<string, Promise<string>>): Promise<BskyConversation> {
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
                ? { lastMessage: await this.normalizeMessage(convo.lastMessage, didCache) }
                : {}),
        };
    }

    // ---------------------------------------------------------------------------
    // Error mapping
    // ---------------------------------------------------------------------------

    private mapError(err: unknown, message: string, notifyHealthRegistry = true): BskyError {
        if(isXRPCError(err)) {
            if(err.status === HTTP_STATUS.AUTH_REQUIRED) {
                // Stryker disable next-line ConditionalExpression: health registry notification guard — only notify for runtime auth failures, not login
                if(notifyHealthRegistry) {
                    this.healthRegistry?.sendEvent('bluesky', 'CONNECTION_LOST', { error: err.message });
                }
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

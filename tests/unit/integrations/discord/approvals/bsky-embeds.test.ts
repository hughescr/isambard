import { describe, test, expect } from 'bun:test';
import type { APIButtonComponentWithCustomId } from 'discord.js';
import { createAtUri, createCid } from '@/integrations/bsky';
import {
    buildBskyApprovalEmbed,
    type BskyDmApprovalEmbedParams,
    type BskyReplyApprovalEmbedParams
} from '@/integrations/discord/approvals/bsky-embeds';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<BskyReplyApprovalEmbedParams> = {}): BskyReplyApprovalEmbedParams {
    return {
        type:         'reply',
        text:         'Hello @user.bsky.social, great post!',
        targetHandle: 'user.bsky.social',
        reply:        { parent: { uri: createAtUri('at://did:plc:abc123/app.bsky.feed.post/xyz456'), cid: createCid('bafyreiabc123') } },
        ...overrides,
    };
}

function makeDMParams(overrides: Partial<BskyDmApprovalEmbedParams> = {}): BskyDmApprovalEmbedParams {
    return {
        type:             'dm',
        text:             'Hello, want to collaborate?',
        recipientHandles: ['alice.bsky.social'],
        convoId:          'convo-abc123',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// buildBskyApprovalEmbed — reply type
// ---------------------------------------------------------------------------

describe('buildBskyApprovalEmbed', () => {
    describe('type: reply', () => {
        test('returns embed and actionRow', () => {
            const result = buildBskyApprovalEmbed(makeParams());
            expect(result.embed).toBeDefined();
            expect(result.actionRow).toBeDefined();
        });

        test('embed has correct title', () => {
            const result = buildBskyApprovalEmbed(makeParams());
            expect(result.embed.toJSON().title).toBe('Bluesky Post Approval Required');
        });

        test('embed has Bluesky blue color (0x0085FF)', () => {
            const result = buildBskyApprovalEmbed(makeParams());
            expect(result.embed.toJSON().color).toBe(0x00_85_FF);
        });

        test('embed description contains post text', () => {
            const params = makeParams({ text: 'My reply text here' });
            const result = buildBskyApprovalEmbed(params);
            expect(result.embed.toJSON().description).toBe('My reply text here');
        });

        test('embed does not truncate long post text (Bluesky max 300 graphemes fits in Discord)', () => {
            const longText = 'A'.repeat(400);
            const result   = buildBskyApprovalEmbed(makeParams({ text: longText }));
            expect(result.embed.toJSON().description).toBe(longText);
        });

        test('embed does not truncate short post text', () => {
            const shortText = 'Short reply.';
            const result    = buildBskyApprovalEmbed(makeParams({ text: shortText }));
            expect(result.embed.toJSON().description).toBe(shortText);
        });

        test('embed includes Replying to field', () => {
            const params = makeParams({ targetHandle: 'someone.bsky.social' });
            const result = buildBskyApprovalEmbed(params);
            const field  = result.embed.toJSON().fields?.find(f => f.name === 'Replying to');
            expect(field?.value).toBe('someone.bsky.social');
            expect(field?.inline).toBe(true);
        });

        test('embed includes Parent URI field', () => {
            const params = makeParams({ reply: { parent: { uri: createAtUri('at://did:plc:test/app.bsky.feed.post/111'), cid: createCid('bafyreiabc123') } } });
            const result = buildBskyApprovalEmbed(params);
            const field  = result.embed.toJSON().fields?.find(f => f.name === 'Parent URI');
            expect(field?.value).toBe('at://did:plc:test/app.bsky.feed.post/111');
            expect(field?.inline).toBe(true);
        });

        test('embed includes Parent CID field', () => {
            const params = makeParams({ reply: { parent: { uri: createAtUri('at://did:plc:abc123/app.bsky.feed.post/xyz456'), cid: createCid('bafyreidxyz') } } });
            const result = buildBskyApprovalEmbed(params);
            const field  = result.embed.toJSON().fields?.find(f => f.name === 'Parent CID');
            expect(field?.value).toBe('bafyreidxyz');
            expect(field?.inline).toBe(true);
        });

        test('reply.parent is required — a rejection embed always has a strong ref, so no empty-fallback case exists', () => {
            // Documents the deliberate type-level change: unlike the old flat parentUri?/parentCid?
            // fields (independently optional), reply.parent is now a required BskyStrongRef —
            // there is no "missing parent" state left to render an empty '' fallback for.
            const params = makeParams();
            expect(params.reply.parent.uri).toBe(createAtUri('at://did:plc:abc123/app.bsky.feed.post/xyz456'));
            expect(params.reply.parent.cid).toBe(createCid('bafyreiabc123'));
        });

        describe('without root', () => {
            test('omits Root URI field when root is not provided', () => {
                const result = buildBskyApprovalEmbed(makeParams());
                const field  = result.embed.toJSON().fields?.find(f => f.name === 'Root URI');
                expect(field).toBeUndefined();
            });

            test('omits Root CID field when root is not provided', () => {
                const result = buildBskyApprovalEmbed(makeParams());
                const field  = result.embed.toJSON().fields?.find(f => f.name === 'Root CID');
                expect(field).toBeUndefined();
            });
        });

        describe('with root', () => {
            test('includes Root URI field when root is provided', () => {
                const params = makeParams({
                    reply: {
                        parent: { uri: createAtUri('at://did:plc:abc123/app.bsky.feed.post/xyz456'), cid: createCid('bafyreiabc123') },
                        root:   { uri: createAtUri('at://did:plc:root/app.bsky.feed.post/root123'), cid: createCid('bafyreroot123') },
                    },
                });
                const result = buildBskyApprovalEmbed(params);
                const field  = result.embed.toJSON().fields?.find(f => f.name === 'Root URI');
                expect(field?.value).toBe('at://did:plc:root/app.bsky.feed.post/root123');
                expect(field?.inline).toBe(true);
            });

            test('includes Root CID field when root is provided', () => {
                const params = makeParams({
                    reply: {
                        parent: { uri: createAtUri('at://did:plc:abc123/app.bsky.feed.post/xyz456'), cid: createCid('bafyreiabc123') },
                        root:   { uri: createAtUri('at://did:plc:root/app.bsky.feed.post/root123'), cid: createCid('bafyreroot123') },
                    },
                });
                const result = buildBskyApprovalEmbed(params);
                const field  = result.embed.toJSON().fields?.find(f => f.name === 'Root CID');
                expect(field?.value).toBe('bafyreroot123');
                expect(field?.inline).toBe(true);
            });

            test('reply.root must be a full BskyStrongRef (uri+cid), not a bare uri', () => {
                const build = (): BskyReplyApprovalEmbedParams => makeParams({
                    reply: {
                        parent: { uri: createAtUri('at://did:plc:abc123/app.bsky.feed.post/xyz456'), cid: createCid('bafyreiabc123') },
                        // @ts-expect-error -- reply.root must be a full BskyStrongRef (uri+cid), not a bare uri
                        root:   { uri: 'at://did:plc:root/app.bsky.feed.post/root123' },
                    },
                });
                expect(build).toBeDefined();
            });
        });

        describe('with parentText', () => {
            test('includes Parent Post field when parentText is provided', () => {
                const params = makeParams({ parentText: 'Original post content here' });
                const result = buildBskyApprovalEmbed(params);
                const field  = result.embed.toJSON().fields?.find(f => f.name === 'Parent Post');
                expect(field?.value).toBe('Original post content here');
                expect(field?.inline).toBe(false);
            });

            test('truncates long parentText to 280 chars', () => {
                const longText = 'B'.repeat(400);
                const params   = makeParams({ parentText: longText });
                const result   = buildBskyApprovalEmbed(params);
                const field    = result.embed.toJSON().fields?.find(f => f.name === 'Parent Post');
                expect(field?.value.length).toBe(280);
                expect(field?.value).toEndWith('...');
            });

            test('omits Parent Post field when parentText is not provided', () => {
                const result = buildBskyApprovalEmbed(makeParams());
                const field  = result.embed.toJSON().fields?.find(f => f.name === 'Parent Post');
                expect(field).toBeUndefined();
            });
        });

        describe('action row buttons', () => {
            test('creates 3 buttons', () => {
                const result = buildBskyApprovalEmbed(makeParams());
                expect(result.actionRow.components).toHaveLength(3);
            });

            test('Approve button customId has bsky-send-approve prefix', () => {
                const result  = buildBskyApprovalEmbed(makeParams());
                const buttons = result.actionRow.toJSON().components as APIButtonComponentWithCustomId[];
                expect(buttons[0].custom_id).toMatch(/^bsky-send-approve:/);
            });

            test('Approve+Allowlist button customId has bsky-send-approveallowlist prefix', () => {
                const result  = buildBskyApprovalEmbed(makeParams());
                const buttons = result.actionRow.toJSON().components as APIButtonComponentWithCustomId[];
                expect(buttons[1].custom_id).toMatch(/^bsky-send-approveallowlist:/);
            });

            test('Reject button customId has bsky-send-reject prefix', () => {
                const result  = buildBskyApprovalEmbed(makeParams());
                const buttons = result.actionRow.toJSON().components as APIButtonComponentWithCustomId[];
                expect(buttons[2].custom_id).toMatch(/^bsky-send-reject:/);
            });

            test('all three buttons share the same UUID suffix', () => {
                const result  = buildBskyApprovalEmbed(makeParams());
                const buttons = result.actionRow.toJSON().components as APIButtonComponentWithCustomId[];
                const uuid0   = buttons[0].custom_id.split(':')[1];
                const uuid1   = buttons[1].custom_id.split(':')[1];
                const uuid2   = buttons[2].custom_id.split(':')[1];
                expect(uuid0).toBe(uuid1);
                expect(uuid1).toBe(uuid2);
            });

            test('buttons have correct labels', () => {
                const result  = buildBskyApprovalEmbed(makeParams());
                const buttons = result.actionRow.toJSON().components as APIButtonComponentWithCustomId[];
                expect(buttons[0].label).toBe('Approve');
                expect(buttons[1].label).toBe('Approve + Allowlist');
                expect(buttons[2].label).toBe('Reject');
            });

            test('two calls produce different UUIDs', () => {
                const result1 = buildBskyApprovalEmbed(makeParams());
                const result2 = buildBskyApprovalEmbed(makeParams());
                const buttons1 = result1.actionRow.toJSON().components as APIButtonComponentWithCustomId[];
                const buttons2 = result2.actionRow.toJSON().components as APIButtonComponentWithCustomId[];
                const uuid1    = buttons1[0].custom_id.split(':')[1];
                const uuid2    = buttons2[0].custom_id.split(':')[1];
                expect(uuid1).not.toBe(uuid2);
            });
        });
    });

    // ---------------------------------------------------------------------------
    // type: dm
    // ---------------------------------------------------------------------------

    describe('type: dm', () => {
        test('returns embed and actionRow', () => {
            const result = buildBskyApprovalEmbed(makeDMParams());
            expect(result.embed).toBeDefined();
            expect(result.actionRow).toBeDefined();
        });

        test('embed has title "Bluesky DM Approval Required"', () => {
            const result = buildBskyApprovalEmbed(makeDMParams());
            expect(result.embed.toJSON().title).toBe('Bluesky DM Approval Required');
        });

        test('embed has Bluesky blue color (0x0085FF)', () => {
            const result = buildBskyApprovalEmbed(makeDMParams());
            expect(result.embed.toJSON().color).toBe(0x00_85_FF);
        });

        test('embed description contains DM text', () => {
            const params = makeDMParams({ text: 'Hey, want to collaborate?' });
            const result = buildBskyApprovalEmbed(params);
            expect(result.embed.toJSON().description).toBe('Hey, want to collaborate?');
        });

        test('embed includes Recipients field with all handles as JSON array', () => {
            const params = makeDMParams({ recipientHandles: ['alice.bsky.social', 'bob.bsky.social'] });
            const result = buildBskyApprovalEmbed(params);
            const field  = result.embed.toJSON().fields?.find(f => f.name === 'Recipients');
            expect(field?.value).toBe('["alice.bsky.social","bob.bsky.social"]');
            expect(field?.inline).toBe(false);
        });

        test('embed includes Conversation ID field', () => {
            const params = makeDMParams({ convoId: 'convo-xyz789' });
            const result = buildBskyApprovalEmbed(params);
            const field  = result.embed.toJSON().fields?.find(f => f.name === 'Conversation ID');
            expect(field?.value).toBe('convo-xyz789');
            expect(field?.inline).toBe(true);
        });

        test('embed uses an empty Conversation ID when convoId is not provided', () => {
            const result = buildBskyApprovalEmbed(makeDMParams({ convoId: undefined }));
            const field  = result.embed.toJSON().fields?.find(f => f.name === 'Conversation ID');
            expect(field?.value).toBe('');
        });

        test.each([
            ['Parent URI'],
            ['Parent CID'],
            ['Replying to'],
        ])('embed does NOT include %s field', (fieldName) => {
            const result = buildBskyApprovalEmbed(makeDMParams());
            const field  = result.embed.toJSON().fields?.find(f => f.name === fieldName);
            expect(field).toBeUndefined();
        });

        describe('action row buttons', () => {
            test('creates 3 buttons', () => {
                const result = buildBskyApprovalEmbed(makeDMParams());
                expect(result.actionRow.components).toHaveLength(3);
            });

            test('Approve button customId has bsky-dm-approve prefix', () => {
                const result  = buildBskyApprovalEmbed(makeDMParams());
                const buttons = result.actionRow.toJSON().components as APIButtonComponentWithCustomId[];
                expect(buttons[0].custom_id).toMatch(/^bsky-dm-approve:/);
            });

            test('Approve+Allowlist button customId has bsky-dm-approveallowlist prefix', () => {
                const result  = buildBskyApprovalEmbed(makeDMParams());
                const buttons = result.actionRow.toJSON().components as APIButtonComponentWithCustomId[];
                expect(buttons[1].custom_id).toMatch(/^bsky-dm-approveallowlist:/);
            });

            test('Reject button customId has bsky-dm-reject prefix', () => {
                const result  = buildBskyApprovalEmbed(makeDMParams());
                const buttons = result.actionRow.toJSON().components as APIButtonComponentWithCustomId[];
                expect(buttons[2].custom_id).toMatch(/^bsky-dm-reject:/);
            });

            test('all three buttons share the same UUID suffix', () => {
                const result  = buildBskyApprovalEmbed(makeDMParams());
                const buttons = result.actionRow.toJSON().components as APIButtonComponentWithCustomId[];
                const uuid0   = buttons[0].custom_id.split(':')[1];
                const uuid1   = buttons[1].custom_id.split(':')[1];
                const uuid2   = buttons[2].custom_id.split(':')[1];
                expect(uuid0).toBe(uuid1);
                expect(uuid1).toBe(uuid2);
            });

            test('buttons have correct labels', () => {
                const result  = buildBskyApprovalEmbed(makeDMParams());
                const buttons = result.actionRow.toJSON().components as APIButtonComponentWithCustomId[];
                expect(buttons[0].label).toBe('Approve');
                expect(buttons[1].label).toBe('Approve + Allowlist');
                expect(buttons[2].label).toBe('Reject');
            });
        });
    });
});

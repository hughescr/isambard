import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { EmbedBuilder, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js';
import { mockLogger } from '../../../../setup';
import { DiscordOutboundApprovalInteractionHandler } from '@/integrations/discord/approvals/interaction-handler';

// ---------------------------------------------------------------------------
// Minimal concrete subclass — exercises the shared base-class behaviour
// directly, without any platform-specific routing logic getting in the way.
// ---------------------------------------------------------------------------

class TestOutboundApprovalHandler extends DiscordOutboundApprovalInteractionHandler<string> {
    readonly dispatchApprovedButtonImpl = mock(async (_prefix: string, _interaction: ButtonInteraction, _id: string): Promise<void> => { /* no-op by default */ });
    readonly performRejectionImpl       = mock(async (
        _prefix: string,
        _embed: { description?: string | null, fields?: { name: string, value: string }[] } | undefined,
        _reason: string,
        _interaction: ModalSubmitInteraction,
        _id: string
    ): Promise<void> => { /* no-op by default */ });

    protected isKnownButtonPrefix(prefix: string): boolean {
        return prefix === 'known-btn';
    }

    protected isRejectButtonPrefix(prefix: string): boolean {
        return prefix === 'known-reject';
    }

    protected isKnownModalPrefix(prefix: string): boolean {
        return prefix === 'known-modal';
    }

    protected parseId(raw: string): string | null {
        return raw === '' ? null : raw;
    }

    protected async dispatchApprovedButton(prefix: string, interaction: ButtonInteraction, id: string): Promise<void> {
        await this.dispatchApprovedButtonImpl(prefix, interaction, id);
    }

    protected async performRejection(
        prefix: string,
        embed: { description?: string | null, fields?: { name: string, value: string }[] } | undefined,
        reason: string,
        interaction: ModalSubmitInteraction,
        id: string
    ): Promise<void> {
        await this.performRejectionImpl(prefix, embed, reason, interaction, id);
    }

    protected rejectModalCustomId(buttonPrefix: string, rawId: string): string {
        return `${buttonPrefix}-reason:${rawId}`;
    }

    protected rejectModalTitle(_buttonPrefix: string): string {
        return 'Reject Title';
    }

    protected buildRejectionFailedLog(err: unknown, id: string): Record<string, unknown> {
        return { err, id };
    }

    // Test-only exposure of protected shared helpers.
    exposedBuildApprovedEmbed(title: string) {
        return this.buildApprovedEmbed(title);
    }

    exposedBuildRejectedEmbed(reason: string) {
        return this.buildRejectedEmbed(reason);
    }

    async exposedReplyWithApprovalError(interaction: ButtonInteraction, title: string): Promise<void> {
        await this.replyWithApprovalError(interaction, title);
    }
}

function makeHandler(): TestOutboundApprovalHandler {
    return new TestOutboundApprovalHandler();
}

function makeButtonInteraction(customId: string): {
    interaction: ButtonInteraction
    deferUpdate: ReturnType<typeof mock>
    editReply:   ReturnType<typeof mock>
    showModal:   ReturnType<typeof mock>
} {
    const deferUpdate = mock(async () => ({}));
    const editReply   = mock(async () => ({}));
    const showModal   = mock(async () => ({}));
    const interaction = {
        customId,
        deferUpdate,
        editReply,
        showModal,
    } as unknown as ButtonInteraction;
    return { interaction, deferUpdate, editReply, showModal };
}

function makeModalInteraction(customId: string): {
    interaction: ModalSubmitInteraction
    deferUpdate: ReturnType<typeof mock>
} {
    const deferUpdate = mock(async () => ({}));
    const interaction = {
        customId,
        deferUpdate,
        fields:  { getTextInputValue: mock(() => 'a reason') },
        message: { embeds: [] },
    } as unknown as ModalSubmitInteraction;
    return { interaction, deferUpdate };
}

describe('DiscordOutboundApprovalInteractionHandler', () => {
    beforeEach(() => {
        mockLogger.error.mockClear();
    });

    // -----------------------------------------------------------------------
    // Embed colour constants (GREEN / RED / AMBER) are a pure display-only
    // constant table: they don't drive any branching logic, so one pinning
    // test per constant (exact-value equality) is enough to kill every
    // NumberLiteralValue mutant on these literals. Change detector: an editor
    // changing GREEN/RED/AMBER must consciously update this test too.
    // -----------------------------------------------------------------------
    describe('embed colour constants (change detector — see src/services/outbound-approval-handler-base.ts GREEN/RED/AMBER)', () => {
        test('buildApprovedEmbed uses GREEN (0x00AA00)', () => {
            const handler = makeHandler();
            const embed   = handler.exposedBuildApprovedEmbed('Approved');
            expect(embed.data.color).toBe(0x00_AA_00);
        });

        test('buildRejectedEmbed uses RED (0xFF0000)', () => {
            const handler = makeHandler();
            const embed   = handler.exposedBuildRejectedEmbed('reason');
            expect(embed.data.color).toBe(0xFF_00_00);
        });

        test('replyWithApprovalError uses AMBER (0xFFAA00)', async () => {
            const handler = makeHandler();
            const { interaction, editReply } = makeButtonInteraction('known-btn:1');

            await handler.exposedReplyWithApprovalError(interaction, 'Missing embed');

            expect(editReply).toHaveBeenCalledTimes(1);
            const replyArg = editReply.mock.calls[0]?.[0] as { embeds: { data: { color?: number } }[] };
            expect(replyArg.embeds[0]?.data.color).toBe(0xFF_AA_00);
        });
    });

    describe('handleButton() error message', () => {
        test('replies with the exact fallback error text when the approved dispatch throws', async () => {
            const handler = makeHandler();
            handler.dispatchApprovedButtonImpl.mockImplementation(async () => {
                throw new Error('dispatch failed');
            });
            const { interaction, editReply } = makeButtonInteraction('known-btn:1');

            await handler.handleButton(interaction);

            expect(editReply).toHaveBeenCalledTimes(1);
            const replyArg = editReply.mock.calls[0]?.[0] as { content: string };
            // Exact match — a truncated/rewritten message must fail this test.
            expect(replyArg.content).toBe('An error occurred processing your request. Please try again.');
        });
    });

    describe('handleModalSubmit() customId parsing', () => {
        test('proceeds (does not short-circuit) when customId has more than two colon-separated parts', async () => {
            const handler = makeHandler();
            const { interaction, deferUpdate } = makeModalInteraction('known-modal:id1:extra-part');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).toHaveBeenCalledTimes(1);
            expect(handler.performRejectionImpl).toHaveBeenCalledTimes(1);
            const call = handler.performRejectionImpl.mock.calls[0] as unknown as [string, unknown, string, ModalSubmitInteraction, string];
            // rawId is parts[1] — the segment after the first colon.
            expect(call[4]).toBe('id1');
        });

        test('short-circuits when customId has fewer than two parts', async () => {
            const handler = makeHandler();
            const { interaction, deferUpdate } = makeModalInteraction('known-modal-no-colon');

            await handler.handleModalSubmit(interaction);

            expect(deferUpdate).not.toHaveBeenCalled();
            expect(handler.performRejectionImpl).not.toHaveBeenCalled();
        });
    });
});

// ---------------------------------------------------------------------------
// replyWithErrorEmbed() is private and reached only when rejection persistence
// throws, so it is exercised end-to-end through handleModalSubmit().
// ---------------------------------------------------------------------------
function makeFailingModalInteraction(message: unknown): {
    interaction: ModalSubmitInteraction
    editReply:   ReturnType<typeof mock>
} {
    const editReply   = mock(async () => ({}));
    const interaction = {
        customId:    'known-modal:1',
        deferUpdate: mock(async () => ({})),
        editReply,
        fields:      { getTextInputValue: mock(() => 'please reject this') },
        message,
    } as unknown as ModalSubmitInteraction;
    return { interaction, editReply };
}

describe('DiscordOutboundApprovalInteractionHandler.replyWithErrorEmbed()', () => {
    beforeEach(() => {
        mockLogger.error.mockClear();
    });

    function makeFailingHandler(): TestOutboundApprovalHandler {
        const handler = makeHandler();
        handler.performRejectionImpl.mockImplementation(async () => {
            throw new Error('persist failed');
        });
        return handler;
    }

    test('preserves the original embed and appends the amber retry error embed', async () => {
        const handler  = makeFailingHandler();
        const original = new EmbedBuilder().setDescription('original reason');
        const { interaction, editReply } = makeFailingModalInteraction({ embeds: [original], components: [] });

        await handler.handleModalSubmit(interaction);

        expect(editReply).toHaveBeenCalledTimes(1);
        const arg = editReply.mock.calls[0]?.[0] as { embeds: { data: { title?: string, description?: string, color?: number } }[] };
        expect(arg.embeds).toHaveLength(2);
        expect(arg.embeds[0]?.data.description).toBe('original reason');
        // Exact text — a truncated or rewritten message must fail this test.
        expect(arg.embeds[1]?.data.title).toBe('Rejection failed — please retry');
        expect(arg.embeds[1]?.data.description).toBe('Could not save rejection to backend.');
        expect(arg.embeds[1]?.data.color).toBe(0xFF_AA_00);
    });

    test('sends an explicit empty components array and no preserved embed when the message is absent', async () => {
        const handler = makeFailingHandler();
        const { interaction, editReply } = makeFailingModalInteraction(null);

        await handler.handleModalSubmit(interaction);

        expect(editReply).toHaveBeenCalledTimes(1);
        const arg = editReply.mock.calls[0]?.[0] as { components: unknown, embeds: unknown[] };
        expect(arg.embeds).toHaveLength(1);
        // [] rather than undefined: the edit payload must clear components, not omit the key.
        expect(arg.components).toEqual([]);
    });
});

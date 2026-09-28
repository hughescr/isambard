import { describe, test, expect } from 'bun:test';
import { ButtonStyle, ComponentType, type APIButtonComponentWithCustomId, type APIEmbed } from 'discord.js';
import {
    buildDraftGoneEmbed,
    buildEmailApprovalCard,
    currentCardDraftUid,
    DRAFT_GONE_GREY,
    type EmailApprovalCard
} from '@/integrations/discord/approvals/email-approval-card';
import type { DraftSummary } from '@/integrations/email';

function summary(overrides: Partial<DraftSummary> = {}): DraftSummary {
    return {
        from:        { address: 'izzy@example.com', name: 'Izzy' },
        to:          [{ address: 'a@example.com' }],
        cc:          [],
        bcc:         [],
        subject:     'Hello',
        snippet:     'The body',
        attachments: [],
        ...overrides,
    };
}

function embedOf(card: EmailApprovalCard): APIEmbed {
    return card.embeds[0].toJSON();
}

function buttonsOf(card: EmailApprovalCard): APIButtonComponentWithCustomId[] {
    return card.components.flatMap(row => row.toJSON().components) as APIButtonComponentWithCustomId[];
}

function fieldValue(embed: APIEmbed, name: string): string | undefined {
    return embed.fields?.find(field => field.name === name)?.value;
}

function embedLength(embed: APIEmbed): number {
    return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
}

/** Addresses of `length` characters each. */
function addresses(count: number, length = 40): { address: string }[] {
    return Array.from({ length: count }, (_, i) => ({ address: `${String(i).padStart(length - 12, 'x')}@example.com` }));
}

describe('buildEmailApprovalCard — pending', () => {
    test('shows From, every recipient list with its count, Subject, the snippet and the draft reference, in order', () => {
        const embed = embedOf(buildEmailApprovalCard({
            uid:     42,
            edits:   0,
            state:   'pending',
            summary: summary({
                to:  [{ address: 'a@example.com' }, { address: 'b@example.com', name: 'Bee' }],
                cc:  [{ address: 'c@example.com' }],
                bcc: [{ address: 'd@example.com' }],
            }),
        }));

        expect(embed.title).toBe('Outbound Email Approval Required');
        expect(embed.color).toBe(0x00_99_FF);
        expect(embed.description).toBe('The body');
        expect(embed.fields).toEqual([
            { name: 'From', value: 'Izzy <izzy@example.com>' },
            { name: 'To (2)', value: 'a@example.com, Bee <b@example.com>' },
            { name: 'Cc (1)', value: 'c@example.com' },
            { name: 'Bcc (1)', value: 'd@example.com' },
            { name: 'Subject', value: 'Hello' },
            { name: 'Draft', value: 'Drafts:42' },
        ]);
    });

    test('shows placeholders for no From, no To, no subject and an empty body, and omits empty Cc and Bcc', () => {
        const embed = embedOf(buildEmailApprovalCard({ uid: 7, edits: 0, state: 'pending', summary: summary({ from: undefined, to: [], subject: '', snippet: '' }) }));

        expect(embed.description).toBe('(empty body)');
        expect(embed.fields).toEqual([
            { name: 'From', value: '(unknown)' },
            { name: 'To (0)', value: '(none)' },
            { name: 'Subject', value: '(no subject)' },
            { name: 'Draft', value: 'Drafts:7' },
        ]);
    });

    test('escapes markdown in every draft-derived value', () => {
        const embed = embedOf(buildEmailApprovalCard({
            uid:     1,
            edits:   0,
            state:   'pending',
            summary: summary({
                from:        { address: 'first_last@example.com', name: '*Boss*' },
                to:          [{ address: 'a_b@example.com' }],
                subject:     '**urgent**',
                snippet:     '`code` _x_',
                attachments: [{ filename: '__init__.py', contentType: 'text/x-python', sizeBytes: 10 }],
            }),
        }));

        expect(embed.description).toBe('\\`code\\` \\_x\\_');
        expect(fieldValue(embed, 'From')).toBe(String.raw`\*Boss\* <first\_last@example.com>`);
        expect(fieldValue(embed, 'To (1)')).toBe(String.raw`a\_b@example.com`);
        expect(fieldValue(embed, 'Subject')).toBe(String.raw`\*\*urgent\*\*`);
        const escapedName = String.raw`\_\_init\_\_.py`;
        expect(fieldValue(embed, 'Attachments (1)')).toBe(`${escapedName} — text/x-python, 10 B`);
    });

    test('cuts a subject longer than a field allows', () => {
        const embed = embedOf(buildEmailApprovalCard({ uid: 1, edits: 0, state: 'pending', summary: summary({ subject: 's'.repeat(2000) }) }));

        expect(fieldValue(embed, 'Subject')).toBe(`${'s'.repeat(1021)}...`);
    });

    test('marks an edited card in its title', () => {
        expect(embedOf(buildEmailApprovalCard({ uid: 1, edits: 2, state: 'pending', summary: summary() })).title).toBe('Outbound Email Approval Required · Edited (2)');
        expect(embedOf(buildEmailApprovalCard({ uid: 1, edits: 1, state: 'pending', summary: summary() })).title).toBe('Outbound Email Approval Required · Edited (1)');
    });

    test('lists every attachment with its name, type and size', () => {
        const embed = embedOf(buildEmailApprovalCard({
            uid:     1,
            edits:   0,
            state:   'pending',
            summary: summary({
                attachments: [
                    { filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 12_595 },
                    { filename: 'b.txt', contentType: 'text/plain', sizeBytes: 5 },
                ],
            }),
        }));

        expect(embed.fields?.map(field => field.name)).toEqual(['From', 'To (1)', 'Subject', 'Attachments (2)', 'Draft']);
        expect(fieldValue(embed, 'Attachments (2)')).toBe('a.pdf — application/pdf, 12.3 KB\nb.txt — text/plain, 5 B');
    });

    test('cuts a long attachment list with an exact count of the rest', () => {
        const attachments = Array.from({ length: 40 }, (_, i) => ({ filename: `file-${String(i).padStart(2, '0')}.bin`, contentType: 'application/octet-stream', sizeBytes: 1024 }));
        const value = fieldValue(embedOf(buildEmailApprovalCard({ uid: 1, edits: 0, state: 'pending', summary: summary({ attachments }) })), 'Attachments (40)')!;

        const lines = value.split('\n');
        const shown = lines.length - 1;
        expect(value.length).toBeLessThanOrEqual(1024);
        expect(lines.at(-1)).toBe(`… and ${40 - shown} more (see preview)`);
        expect(lines[0]).toBe('file-00.bin — application/octet-stream, 1.0 KB');
        expect(lines[shown - 1]).toBe(`file-${String(shown - 1).padStart(2, '0')}.bin — application/octet-stream, 1.0 KB`);
        // One more line would not have fitted with its own suffix.
        const oneMore = [...lines.slice(0, shown), `file-${String(shown).padStart(2, '0')}.bin — application/octet-stream, 1.0 KB`, `… and ${40 - shown - 1} more (see preview)`].join('\n');
        expect(oneMore.length).toBeGreaterThan(1024);
    });

    test('shows only the count when even the first attachment line cannot fit', () => {
        const value = fieldValue(embedOf(buildEmailApprovalCard({
            uid:     1,
            edits:   0,
            state:   'pending',
            summary: summary({ attachments: [{ filename: 'n'.repeat(1100), contentType: 'x/y', sizeBytes: 1 }] }),
        })), 'Attachments (1)');

        expect(value).toBe('… and 1 more (see preview)');
    });

    test('keeps a last attachment line that exactly fills the field, and cuts one a character longer', () => {
        const valueFor = (filename: string): string | undefined => fieldValue(embedOf(buildEmailApprovalCard({
            uid:     1,
            edits:   0,
            state:   'pending',
            summary: summary({ attachments: [{ filename, contentType: 'x/y', sizeBytes: 1 }] }),
        })), 'Attachments (1)');

        expect(valueFor('n'.repeat(1013))).toBe(`${'n'.repeat(1013)} — x/y, 1 B`);
        expect(valueFor('n'.repeat(1013))?.length).toBe(1024);
        expect(valueFor('n'.repeat(1014))).toBe('… and 1 more (see preview)');
    });

    describe('cutting two attachment lines at the field boundary', () => {
        const valueFor = (first: string): string | undefined => fieldValue(embedOf(buildEmailApprovalCard({
            uid:     1,
            edits:   0,
            state:   'pending',
            summary: summary({ attachments: [{ filename: first, contentType: 'x/y', sizeBytes: 1 }, { filename: 'b', contentType: 'x/y', sizeBytes: 1 }] }),
        })), 'Attachments (2)');

        test('keeps a first line that exactly fills the field with its "1 more" note, and then the last line with no note', () => {
            // 997-character first line + "\n… and 1 more (see preview)" (27) = 1024; both lines together are 1010.
            expect(valueFor('n'.repeat(986))).toBe(`${'n'.repeat(986)} — x/y, 1 B\nb — x/y, 1 B`);
        });

        test('cuts before a first line that fits alone but not with its "1 more" note', () => {
            // 998-character first line + its 27-character note = 1025, although both lines together (1011) would fit.
            expect(valueFor('n'.repeat(987))).toBe('… and 2 more (see preview)');
        });
    });

    test('cuts a From longer than a field allows', () => {
        const embed = embedOf(buildEmailApprovalCard({ uid: 1, edits: 0, state: 'pending', summary: summary({ from: { address: 'a@example.com', name: 'n'.repeat(2000) } }) }));

        expect(fieldValue(embed, 'From')).toBe(`${'n'.repeat(1021)}...`);
    });

    test('shows a single address that exactly fills a field', () => {
        const address = `${'z'.repeat(1012)}@example.com`;
        const embed = embedOf(buildEmailApprovalCard({ uid: 1, edits: 0, state: 'pending', summary: summary({ to: [{ address }] }) }));

        expect(fieldValue(embed, 'To (1)')).toBe(address);
        expect(address).toHaveLength(1024);
    });

    test('splits a long recipient list at address boundaries into cont. fields, never truncating', () => {
        const to = addresses(60);
        const embed = embedOf(buildEmailApprovalCard({ uid: 1, edits: 0, state: 'pending', summary: summary({ to }) }));

        const toFields = embed.fields!.filter(field => field.name.startsWith('To (60)'));
        expect(toFields.map(field => field.name)).toEqual(['To (60)', 'To (60) (cont.)', 'To (60) (cont.)']);
        expect(toFields.every(field => field.value.length <= 1024)).toBe(true);
        expect(toFields.flatMap(field => field.value.split(', '))).toEqual(to.map(a => a.address));
        // The first chunk is as full as it can be.
        expect(`${toFields[0].value}, ${to[toFields[0].value.split(', ').length].address}`.length).toBeGreaterThan(1024);
    });

    test('keeps a list that exactly fills a field in one field', () => {
        // 25 addresses of 39 characters joined by ', ' = 25*39 + 24*2 = 1023; add one character to reach 1024.
        const to = [...addresses(24, 39), { address: `${'y'.repeat(28)}@example.com` }];
        const embed = embedOf(buildEmailApprovalCard({ uid: 1, edits: 0, state: 'pending', summary: summary({ to }) }));

        expect(fieldValue(embed, 'To (25)')?.length).toBe(1024);
        expect(fieldValue(embed, 'To (25) (cont.)')).toBeUndefined();
    });

    test('keeps the Approve, Approve + Allowlist and Reject buttons keyed to the uid', () => {
        const buttons = buttonsOf(buildEmailApprovalCard({ uid: 42, edits: 1, state: 'pending', summary: summary() }));

        expect(buttons.map(b => [b.custom_id, b.label, b.style])).toEqual([
            ['email-send-approve:42', 'Approve', ButtonStyle.Success],
            ['email-send-approveallowlist:42', 'Approve + Allowlist...', ButtonStyle.Primary],
            ['email-send-reject:42', 'Reject', ButtonStyle.Danger],
        ]);
    });

    test('adds an "Open full preview" link button after the decision buttons when given a preview URL', () => {
        const card = buildEmailApprovalCard({ uid: 42, edits: 0, state: 'pending', summary: summary(), previewUrl: 'https://mac.ts.net/d/42/tok' });
        const components = card.components.flatMap(row => row.toJSON().components);

        expect(components).toHaveLength(4);
        expect(components[3]).toEqual({ type: ComponentType.Button, style: ButtonStyle.Link, label: 'Open full preview', url: 'https://mac.ts.net/d/42/tok' });
    });

    test('keeps the preview link on a card whose recipients cannot fit, beside the lone Reject button', () => {
        const card = buildEmailApprovalCard({ uid: 9, edits: 0, state: 'pending', summary: summary({ to: addresses(160) }), previewUrl: 'https://mac.ts.net/d/9/tok' });
        const components = card.components.flatMap(row => row.toJSON().components);

        expect(components.map(c => ('custom_id' in c ? c.custom_id : (c as { url: string }).url))).toEqual(['email-send-reject:9', 'https://mac.ts.net/d/9/tok']);
    });

    test('has no link button without a preview URL', () => {
        const components = buildEmailApprovalCard({ uid: 42, edits: 0, state: 'pending', summary: summary() }).components.flatMap(row => row.toJSON().components);

        expect(components.every(c => 'custom_id' in c)).toBe(true);
    });

    test('drops the snippet and attachment lines first when the card would exceed Discord\'s size limit', () => {
        const to = addresses(136);
        const attachments = [{ filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1 }];
        const card = buildEmailApprovalCard({ uid: 1, edits: 0, state: 'pending', summary: summary({ to, attachments, snippet: 'x'.repeat(400) }) });
        const embed = embedOf(card);

        expect(embed.description).toBe('(body omitted to fit — see preview)');
        expect(fieldValue(embed, 'Attachments (1)')).toBe('(omitted to fit — see preview)');
        expect(embed.fields!.filter(field => field.name.startsWith('To (136)')).flatMap(field => field.value.split(', '))).toEqual(to.map(a => a.address));
        expect(embedLength(embed)).toBeLessThanOrEqual(6000);
        expect(buttonsOf(card)).toHaveLength(3);
    });

    test('keeps the snippet while the whole card is at most 6000 characters, and drops it one character later', () => {
        const to = addresses(131);
        const base = embedLength(embedOf(buildEmailApprovalCard({ uid: 1, edits: 0, state: 'pending', summary: summary({ to, snippet: '' }) }))) - '(empty body)'.length;
        const room = 6000 - base;
        expect(room).toBeGreaterThan(0);
        expect(room).toBeLessThan(400);

        const exact = embedOf(buildEmailApprovalCard({ uid: 1, edits: 0, state: 'pending', summary: summary({ to, snippet: 'x'.repeat(room) }) }));
        const over = embedOf(buildEmailApprovalCard({ uid: 1, edits: 0, state: 'pending', summary: summary({ to, snippet: 'x'.repeat(room + 1) }) }));

        expect(exact.description).toBe('x'.repeat(room));
        expect(embedLength(exact)).toBe(6000);
        expect(over.description).toBe('(body omitted to fit — see preview)');
    });

    test('shows counts, a warning and only Reject when the recipients cannot fit', () => {
        const to = addresses(160);
        const cc = [{ address: 'c@example.com' }];
        const card = buildEmailApprovalCard({ uid: 9, edits: 0, state: 'pending', summary: summary({ to, cc, attachments: [{ filename: 'a', contentType: 'b', sizeBytes: 1 }] }) });
        const embed = embedOf(card);

        expect(embed.description).toBe('Too many recipients to display — approve disabled');
        expect(embed.fields).toEqual([
            { name: 'From', value: 'Izzy <izzy@example.com>' },
            { name: 'To (160)', value: '(too many to display)' },
            { name: 'Cc (1)', value: '(too many to display)' },
            { name: 'Subject', value: 'Hello' },
            { name: 'Attachments (1)', value: '(omitted to fit — see preview)' },
            { name: 'Draft', value: 'Drafts:9' },
        ]);
        expect(buttonsOf(card).map(b => b.custom_id)).toEqual(['email-send-reject:9']);
    });

    test('shows counts when a single address is too long for a field', () => {
        const card = buildEmailApprovalCard({ uid: 9, edits: 0, state: 'pending', summary: summary({ to: [{ address: `${'z'.repeat(1100)}@example.com` }] }) });

        expect(fieldValue(embedOf(card), 'To (1)')).toBe('(too many to display)');
        expect(buttonsOf(card).map(b => b.custom_id)).toEqual(['email-send-reject:9']);
    });
});

describe('buildEmailApprovalCard — deleted', () => {
    test('is grey, titled as deleted, keeps the summary and has no buttons', () => {
        const card = buildEmailApprovalCard({ uid: 42, edits: 3, state: 'deleted', summary: summary() });
        const embed = embedOf(card);

        expect(embed.title).toBe('Draft deleted — nothing will be sent');
        expect(embed.color).toBe(DRAFT_GONE_GREY);
        expect(DRAFT_GONE_GREY).toBe(0x99_AA_B5);
        expect(embed.description).toBe('The body');
        expect(fieldValue(embed, 'Draft')).toBe('Drafts:42');
        expect(card.components).toEqual([]);
    });

    test('has no preview link even when given a preview URL', () => {
        expect(buildEmailApprovalCard({ uid: 42, edits: 0, state: 'deleted', summary: summary(), previewUrl: 'https://mac.ts.net/d/42/tok' }).components).toEqual([]);
    });

    test('shows the plain warning, no buttons, when the recipients cannot fit', () => {
        const card = buildEmailApprovalCard({ uid: 42, edits: 0, state: 'deleted', summary: summary({ to: addresses(160) }) });

        expect(embedOf(card).description).toBe('Too many recipients to display');
        expect(card.components).toEqual([]);
    });
});

describe('buildDraftGoneEmbed', () => {
    test('is a grey "no longer exists" embed', () => {
        expect(buildDraftGoneEmbed().toJSON()).toEqual({ title: 'Draft no longer exists — nothing was sent', color: 0x99_AA_B5 });
    });
});

describe('currentCardDraftUid', () => {
    function message(...customIds: (string | null)[]): { components: unknown[] } {
        return { components: [{ components: customIds.map(customId => ({ customId })) }] };
    }

    test('returns the uid the approval buttons agree on', () => {
        expect(currentCardDraftUid(message('email-send-approve:42', 'email-send-approveallowlist:42', 'email-send-reject:42'))).toBe(42);
    });

    test('reads the allowlist select menu, and ignores link buttons and foreign controls', () => {
        expect(currentCardDraftUid(message('email-allowlist-select:42', null, 'other-thing:7'))).toBe(42);
        expect(currentCardDraftUid({ components: [{ components: [{ customId: 'email-send-reject:42' }, { url: 'https://x' }, null, 'junk'] }, { type: 'text' }] })).toBe(42);
    });

    test('is undefined when the controls disagree', () => {
        expect(currentCardDraftUid(message('email-send-approve:42', 'email-send-reject:43'))).toBeUndefined();
    });

    test('is undefined when the card has no live controls', () => {
        expect(currentCardDraftUid({ components: [] })).toBeUndefined();
        expect(currentCardDraftUid(message('other-thing:42'))).toBeUndefined();
        expect(currentCardDraftUid(message('email-send-approve:abc'))).toBeUndefined();
        expect(currentCardDraftUid(message('email-send-approve'))).toBeUndefined();
    });

    test('reads the uid as decimal', () => {
        expect(currentCardDraftUid(message('email-send-approve:010'))).toBe(10);
        expect(currentCardDraftUid(message('email-send-approve:0x2A'))).toBe(0);
    });

    test('reads the controls of a card it built', () => {
        const card = buildEmailApprovalCard({ uid: 77, edits: 0, state: 'pending', summary: summary() });
        const rows = card.components.map(row => ({ components: row.toJSON().components.map(c => ({ customId: (c as APIButtonComponentWithCustomId).custom_id })) }));

        expect(currentCardDraftUid({ components: rows })).toBe(77);
    });
});

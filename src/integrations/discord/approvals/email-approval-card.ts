import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from 'discord.js';
import { truncate } from 'lodash-es';
import { BLUE } from '../colors';
import { EMAIL_ALLOWLIST_SELECT_PREFIX } from '@/config';
import { formatAttachmentSize, type DraftSummary } from '@/integrations/email';
import { encodeCustomId, parseCustomId } from '@/utils';

/** A deleted or vanished draft's card. */
export const DRAFT_GONE_GREY = 0x99_AA_B5;

const PENDING_TITLE = 'Outbound Email Approval Required';
const DELETED_TITLE = 'Draft deleted — nothing will be sent';
const GONE_TITLE = 'Draft no longer exists — nothing was sent';

/** Discord's limits: one field value, and the whole embed. (The 25-field cap never binds first: 20 full recipient fields already exceed 6000 characters.) */
const FIELD_VALUE_MAX = 1024;
const EMBED_TOTAL_MAX = 6000;

const OMITTED = '(omitted to fit — see preview)';
const BODY_OMITTED = '(body omitted to fit — see preview)';
const TOO_MANY = '(too many to display)';

/** The customId prefixes whose id is the draft uid a card's live controls act on. */
const DRAFT_CONTROL_PREFIXES: ReadonlySet<string> = new Set(['email-send-approve', 'email-send-approveallowlist', 'email-send-reject', EMAIL_ALLOWLIST_SELECT_PREFIX]);

export interface EmailApprovalCardInput {
    uid:         number
    summary:     DraftSummary
    /** How many times the draft has been edited under this card; shown when above 0. */
    edits:       number
    state:       'pending' | 'deleted'
    /** The draft's preview page (#158); a pending card links to it. */
    previewUrl?: string
}

export interface EmailApprovalCard {
    embeds:     EmbedBuilder[]
    components: ActionRowBuilder<ButtonBuilder>[]
}

interface Field {
    name:  string
    value: string
}

interface Address {
    address: string
    name?:   string
}

function formatAddress(address: Address): string {
    return escapeMarkdown(address.name ? `${address.name} <${address.address}>` : address.address);
}

/**
 * The fields listing one recipient list in full, split at address boundaries into `(cont.)`
 * fields; undefined when a single address cannot fit in a field. An empty list shows `(none)`
 * when `always`, and no field otherwise.
 */
function recipientFields(label: string, list: Address[], always: boolean): Field[] | undefined {
    const name = `${label} (${list.length})`;
    if(list.length === 0) {
        return always ? [{ name, value: '(none)' }] : [];
    }
    const chunks: string[] = [];
    let current = '';
    for(const text of list.map(address => formatAddress(address))) {
        if(text.length > FIELD_VALUE_MAX) {
            return undefined;
        }
        const joined = current === '' ? text : `${current}, ${text}`;
        if(joined.length > FIELD_VALUE_MAX) {
            chunks.push(current);
            current = text;
        } else {
            current = joined;
        }
    }
    chunks.push(current);
    return chunks.map((value, index) => ({ name: index === 0 ? name : `${name} (cont.)`, value }));
}

function more(count: number): string {
    return `… and ${count} more (see preview)`;
}

/** One line per attachment, cut to fit a field with an exact count of those left out. */
function attachmentLines(summary: DraftSummary): string {
    const lines = summary.attachments.map(a => `${escapeMarkdown(a.filename)} — ${escapeMarkdown(a.contentType)}, ${formatAttachmentSize(a.sizeBytes)}`);
    let value = '';
    for(const [index, line] of lines.entries()) {
        const next = value === '' ? line : `${value}\n${line}`;
        const rest = lines.length - index - 1;
        if((rest > 0 ? `${next}\n${more(rest)}` : next).length > FIELD_VALUE_MAX) {
            return value === '' ? more(lines.length) : `${value}\n${more(lines.length - index)}`;
        }
        value = next;
    }
    return value;
}

function pendingTitle(edits: number): string {
    return edits > 0 ? `${PENDING_TITLE} · Edited (${edits})` : PENDING_TITLE;
}

function embedLength(title: string, description: string, fields: Field[]): number {
    return fields.reduce((sum, field) => sum + field.name.length + field.value.length, title.length + description.length);
}

function approvalButtons(uid: number, rejectOnly: boolean, previewUrl: string | undefined): ActionRowBuilder<ButtonBuilder> {
    const id = String(uid);
    const reject = new ButtonBuilder()
        .setCustomId(encodeCustomId({ prefix: 'email-send-reject', id }))
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger);
    const decisions = rejectOnly
        ? [reject]
        : [
            new ButtonBuilder()
                .setCustomId(encodeCustomId({ prefix: 'email-send-approve', id }))
                .setLabel('Approve')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(encodeCustomId({ prefix: 'email-send-approveallowlist', id }))
                .setLabel('Approve + Allowlist...')
                .setStyle(ButtonStyle.Primary),
            reject,
        ];
    // A link button carries no customId, so it never counts as one of the card's live controls.
    const preview = previewUrl === undefined ? [] : [new ButtonBuilder().setLabel('Open full preview').setStyle(ButtonStyle.Link).setURL(previewUrl)];
    return new ActionRowBuilder<ButtonBuilder>().addComponents(...decisions, ...preview);
}

/**
 * The #admin approval card for an outbound draft (#158), built from the draft as WildDuck
 * stores it: From; To, Cc and Bcc in full with their counts; Subject; a body snippet; one line
 * per attachment; and the draft reference. Every draft-derived string is markdown-escaped.
 * Recipients are never truncated: when the card would exceed Discord's limits the snippet and
 * attachment lines go first, and if the recipients still do not fit the card shows only their
 * counts and a warning — and, while pending, only the Reject button. A pending card's buttons
 * act on `uid`, followed by an "Open full preview" link when `previewUrl` is given; a deleted
 * card has none.
 */
export function buildEmailApprovalCard(input: EmailApprovalCardInput): EmailApprovalCard {
    const { uid, summary, edits, state } = input;
    const pending = state === 'pending';
    const title = pending ? pendingTitle(edits) : DELETED_TITLE;
    const attachmentCount = summary.attachments.length;
    const recipientLists: [string, Address[], boolean][] = [['To', summary.to, true], ['Cc', summary.cc, false], ['Bcc', summary.bcc, false]];

    const fieldsWith = (recipients: Field[], attachments: string): Field[] => [
        { name: 'From', value: summary.from === undefined ? '(unknown)' : truncate(formatAddress(summary.from), { length: FIELD_VALUE_MAX }) },
        ...recipients,
        { name: 'Subject', value: summary.subject === '' ? '(no subject)' : truncate(escapeMarkdown(summary.subject), { length: FIELD_VALUE_MAX }) },
        ...(attachmentCount > 0 ? [{ name: `Attachments (${attachmentCount})`, value: attachments }] : []),
        { name: 'Draft', value: `Drafts:${uid}` },
    ];

    const listed = recipientLists.map(([label, list, always]) => recipientFields(label, list, always));
    const recipients = listed.every(fields => fields !== undefined) ? listed.flat() : undefined;
    const candidates: { description: string, fields: Field[] }[] = recipients === undefined
        ? []
        : [
            { description: summary.snippet === '' ? '(empty body)' : escapeMarkdown(summary.snippet), fields: fieldsWith(recipients, attachmentLines(summary)) },
            { description: BODY_OMITTED, fields: fieldsWith(recipients, OMITTED) },
        ];
    const fitting = candidates.find(candidate => embedLength(title, candidate.description, candidate.fields) <= EMBED_TOTAL_MAX);
    const overflow = fitting === undefined;
    const chosen = fitting ?? {
        description: pending ? 'Too many recipients to display — approve disabled' : 'Too many recipients to display',
        fields:      fieldsWith(
            recipientLists.filter(([, list, always]) => always || list.length > 0).map(([label, list]) => ({ name: `${label} (${list.length})`, value: TOO_MANY })),
            OMITTED
        ),
    };

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(pending ? BLUE : DRAFT_GONE_GREY)
        .setDescription(chosen.description)
        .addFields(chosen.fields);
    return { embeds: [embed], components: pending ? [approvalButtons(uid, overflow, input.previewUrl)] : [] };
}

/** The card an admin click leaves when the draft it acted on no longer exists. */
export function buildDraftGoneEmbed(): EmbedBuilder {
    return new EmbedBuilder().setTitle(GONE_TITLE).setColor(DRAFT_GONE_GREY);
}

/** Every customId on a message's components, however deeply nested. */
function customIdsOf(components: readonly unknown[]): string[] {
    return components.flatMap((component): string[] => {
        if(typeof component !== 'object' || component === null) {
            return [];
        }
        const { components: children, customId } = component as { components?: unknown, customId?: unknown };
        if(Array.isArray(children)) {
            return customIdsOf(children);
        }
        return typeof customId === 'string' ? [customId] : [];
    });
}

/**
 * The draft uid an approval card's live controls act on: the id every approve, allowlist and
 * reject control on it agrees on. Undefined when the card has no such controls (decided,
 * deleted, gone) or they disagree. A click is honoured only when its uid equals this, read fresh.
 */
export function currentCardDraftUid(message: { components: readonly unknown[] }): number | undefined {
    const uids = customIdsOf(message.components).flatMap((raw) => {
        const parsed = parseCustomId(raw);
        if(parsed === undefined || !DRAFT_CONTROL_PREFIXES.has(parsed.prefix)) {
            return [];
        }
        const uid = Number.parseInt(parsed.id, 10);
        return Number.isNaN(uid) ? [] : [uid];
    });
    const [first] = uids;
    return uids.every(uid => uid === first) ? first : undefined;
}

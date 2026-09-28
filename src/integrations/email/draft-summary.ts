import { convert } from 'html-to-text';
import type { WildDuckMessage } from './wildduck-client';

/** The longest body snippet an approval card shows, in code points (the ellipsis included). */
export const DRAFT_SNIPPET_MAX_CODE_POINTS = 400;

interface Address {
    address: string
    name?:   string
}

/** What an approval card shows about a stored draft (#158): its headers, a body snippet and its attachments. */
export interface DraftSummary {
    from?:       Address
    to:          Address[]
    cc:          Address[]
    bcc:         Address[]
    subject:     string
    /** Plain text, whitespace collapsed, at most {@link DRAFT_SNIPPET_MAX_CODE_POINTS} code points. */
    snippet:     string
    attachments: { filename: string, contentType: string, sizeBytes: number }[]
}

/** A byte count as B, KB, MB or GB (binary units, one decimal above bytes). */
export function formatAttachmentSize(bytes: number): string {
    if(bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while(value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

/** The body as plain text: the text part, or else the HTML parts converted (any wrapping is collapsed away with the rest of the whitespace). */
function bodyText(draft: WildDuckMessage): string {
    return draft.text ?? convert((draft.html ?? []).join('\n'));
}

function snippetOf(text: string): string {
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- the snippet limit is defined in code points, exactly what the spread yields
    const codePoints = [...text.replaceAll(/\s+/gu, ' ').trim()];
    return codePoints.length > DRAFT_SNIPPET_MAX_CODE_POINTS
        ? `${codePoints.slice(0, DRAFT_SNIPPET_MAX_CODE_POINTS - 1).join('')}…`
        : codePoints.join('');
}

/** Summarise a draft exactly as WildDuck stores it, for its approval card. */
export function buildDraftSummary(draft: WildDuckMessage): DraftSummary {
    return {
        from:        draft.from,
        to:          draft.to ?? [],
        cc:          draft.cc ?? [],
        bcc:         draft.bcc ?? [],
        subject:     draft.subject ?? '',
        snippet:     snippetOf(bodyText(draft)),
        attachments: (draft.attachments ?? []).map(attachment => ({
            filename:    attachment.filename,
            contentType: attachment.contentType,
            sizeBytes:   attachment.size ?? attachment.sizeKb * 1024,
        })),
    };
}

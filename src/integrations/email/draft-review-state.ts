import { EmailFolder } from '@/config';

export type DraftReviewState = 'rejected_by_admin';

export const DRAFT_STATE_FLAG = {
    rejected_by_admin: 'SendRejectedByAdmin',
} as const satisfies Record<DraftReviewState, string>;

interface DraftReviewStateReader {
    searchByKeyword: (mailboxPath: string, keyword: string) => Promise<number[]>
}

interface DraftReviewStateWriter {
    updateMessageFlags: (mailboxPath: string, uid: number, options: { addFlags?: string[] }) => Promise<void>
}

export async function searchDraftsByReviewState(
    client: DraftReviewStateReader,
    state: DraftReviewState
): Promise<number[]> {
    return client.searchByKeyword(EmailFolder.Drafts, DRAFT_STATE_FLAG[state]);
}

export async function markDraftReviewState(
    client: DraftReviewStateWriter,
    uid: number,
    state: DraftReviewState
): Promise<void> {
    await client.updateMessageFlags(EmailFolder.Drafts, uid, { addFlags: [DRAFT_STATE_FLAG[state]] });
}

import { describe, expect, mock, test } from 'bun:test';
import { EmailFolder } from '@/config';
import { DRAFT_STATE_FLAG, markDraftReviewState, searchDraftsByReviewState } from '@/integrations/email/draft-review-state';

describe('draft review state', () => {
    test('keeps the persisted admin-rejection keyword byte-identical', () => {
        expect(DRAFT_STATE_FLAG).toEqual({ rejected_by_admin: 'SendRejectedByAdmin' });
    });

    test('searches Drafts once with the mapped review-state keyword and returns UIDs', async () => {
        const searchByKeyword = mock(async () => [41, 42]);
        const result = await searchDraftsByReviewState({ searchByKeyword }, 'rejected_by_admin');

        expect(result).toEqual([41, 42]);
        expect(searchByKeyword).toHaveBeenCalledTimes(1);
        expect(searchByKeyword).toHaveBeenCalledWith(EmailFolder.Drafts, DRAFT_STATE_FLAG.rejected_by_admin);
    });

    test('marks one Drafts UID with the mapped review-state keyword', async () => {
        const updateMessageFlags = mock(async () => { /* intentionally empty */ });
        await markDraftReviewState({ updateMessageFlags }, 42, 'rejected_by_admin');

        expect(updateMessageFlags).toHaveBeenCalledTimes(1);
        expect(updateMessageFlags).toHaveBeenCalledWith(
            EmailFolder.Drafts,
            42,
            { addFlags: [DRAFT_STATE_FLAG.rejected_by_admin] }
        );
    });
});

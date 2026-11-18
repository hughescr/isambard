import { describe, test, expect } from 'bun:test';
import { EmailFolder, READABLE_EMAIL_FOLDERS } from '@/config';

describe('READABLE_EMAIL_FOLDERS', () => {
    test('is exactly CleanInbox, Archive, Drafts and Sent Mail, in that order', () => {
        expect(READABLE_EMAIL_FOLDERS).toEqual([EmailFolder.CleanInbox, EmailFolder.Archive, EmailFolder.Drafts, EmailFolder.Sent]);
    });

    test('names no restricted mailbox', () => {
        for(const restricted of [EmailFolder.Inbox, EmailFolder.Quarantine, EmailFolder.Review, EmailFolder.Junk, EmailFolder.Trash]) {
            expect(READABLE_EMAIL_FOLDERS).not.toContain(restricted);
        }
    });
});

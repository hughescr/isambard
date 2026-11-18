// Email folder enum (WildDuck top-level folders, '/' separator)
// eslint-disable-next-line @typescript-eslint/no-redeclare -- intentional const+type enum pattern
export const EmailFolder = {
    Inbox:      'INBOX',
    CleanInbox: 'CleanInbox',
    Drafts:     'Drafts',
    Quarantine: 'Quarantine',
    Review:     'Review',
    Junk:       'Junk',
    Trash:      'Trash',
    Archive:    'Archive',
    Sent:       'Sent Mail',
} as const;
export type EmailFolder = typeof EmailFolder[keyof typeof EmailFolder];

/**
 * The mailboxes Izzy may read, in the order a search of all of them goes through them. The one
 * definition of that set: the email tools (getEmailContent, searchEmail, getEmailThread) and the
 * email history context both take it from here. Every other mailbox (INBOX, Quarantine, Review,
 * Junk, Trash) needs admin review.
 */
export const READABLE_EMAIL_FOLDERS = [EmailFolder.CleanInbox, EmailFolder.Archive, EmailFolder.Drafts, EmailFolder.Sent] as const;

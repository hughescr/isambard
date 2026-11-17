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

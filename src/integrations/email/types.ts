import { z } from 'zod';

// Email folder enum (WildDuck top-level folders, '/' separator)
// Stryker disable next-line all: Enum values are configuration
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
// eslint-disable-next-line @typescript-eslint/no-redeclare -- intentional const+type enum pattern
export type EmailFolder = typeof EmailFolder[keyof typeof EmailFolder];

// Classifier verdict
// Stryker disable next-line all: Enum values are configuration
export const ClassifierVerdictType = {
    Safe:      'safe',
    Spam:      'spam',
    Uncertain: 'uncertain',
    Unsafe:    'unsafe',
} as const;
// eslint-disable-next-line @typescript-eslint/no-redeclare -- intentional const+type enum pattern
export type ClassifierVerdictType = typeof ClassifierVerdictType[keyof typeof ClassifierVerdictType];

export const classifierVerdictSchema = z.object({
    verdict:    z.enum(['safe', 'spam', 'uncertain', 'unsafe']),
    confidence: z.number().min(0).max(1),
    reason:     z.string(),
    category:   z.string().optional(),
});
export type ClassifierVerdict = z.infer<typeof classifierVerdictSchema>;

// Email identity mode for From header
// Stryker disable next-line all: Enum values are configuration
export const EmailIdentity = {
    Formal:   'formal',
    Informal: 'informal',
} as const;
// eslint-disable-next-line @typescript-eslint/no-redeclare -- intentional const+type enum pattern
export type EmailIdentity = typeof EmailIdentity[keyof typeof EmailIdentity];

// Fetched email attachment data
export interface AttachmentData {
    /** Original filename from Content-Disposition */
    filename:    string
    /** MIME content type */
    contentType: string
    /** Raw attachment bytes */
    data:        Buffer
}

// Email metadata (from WildDuck API)
export interface EmailMetadata {
    /** Message UID */
    uid:                  number
    /** Message-ID header */
    messageId:            string
    /** From header (parsed) */
    from:                 EmailAddress
    /** To header (parsed) */
    to:                   EmailAddress[]
    /** CC header (parsed, may be empty) */
    cc:                   EmailAddress[]
    /** Subject */
    subject:              string
    /** Date header */
    date:                 Date
    /** Plain text body (truncated at maxBodySizeBytes) */
    bodyText:             string
    /** Whether message has attachments */
    hasAttachments:       boolean
    /** Selected headers map */
    headers:              EmailHeaders
    /** WildDuck pre-parsed email verification results */
    verificationResults?: VerificationResults
    /** Fetched attachment data (present when fetched via fetchMessage) */
    attachments:          AttachmentData[]
}

// Parsed email address
export interface EmailAddress {
    name?:   string
    address: string
}

// Selected headers we expose
export interface EmailHeaders {
    messageId?:             string
    inReplyTo?:             string
    replyTo?:               string
    authenticationResults?: string
    xRspamdReport?:         string
    xRspamdScore?:          string
}

/** WildDuck pre-parsed email verification results */
export interface VerificationResults {
    /** Domain that passed SPF, or false/undefined if SPF did not pass */
    spf?:  string | false
    /** Domain that passed DKIM, or false/undefined if DKIM did not pass */
    dkim?: string | false
}

// Auth check result
export interface AuthCheckResult {
    spfPass:  boolean
    dkimPass: boolean
}

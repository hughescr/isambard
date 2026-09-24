import { z } from 'zod';

// Classifier verdict
export const ClassifierVerdictType = {
    Safe:      'safe',
    Spam:      'spam',
    Uncertain: 'uncertain',
    Unsafe:    'unsafe',
} as const;
// eslint-disable-next-line @typescript-eslint/no-redeclare -- intentional const+type enum pattern
export type ClassifierVerdictType = typeof ClassifierVerdictType[keyof typeof ClassifierVerdictType];

export const UNSAFE_CATEGORIES = ['phishing', 'malware', 'social_engineering', 'prompt_injection', 'scam'] as const;
export const SPAM_CATEGORIES = ['marketing', 'newsletter', 'bulk', 'automated'] as const;

const classifierVerdictFields = {
    confidence: z.number().min(0).max(1),
    reason:     z.string(),
};
// eslint-disable-next-line unicorn/prefer-top-level-await -- Zod's synchronous .catch() parser fallback is not a promise chain.
const spamCategorySchema = z.enum(SPAM_CATEGORIES).optional().catch(undefined);
// eslint-disable-next-line unicorn/prefer-top-level-await -- Zod's synchronous .catch() parser fallback is not a promise chain.
const unsafeCategorySchema = z.enum(UNSAFE_CATEGORIES).optional().catch(undefined);

export const classifierVerdictSchema = z.discriminatedUnion('verdict', [
    z.object({ verdict: z.literal(ClassifierVerdictType.Safe), ...classifierVerdictFields }),
    z.object({ verdict: z.literal(ClassifierVerdictType.Spam), ...classifierVerdictFields, category: spamCategorySchema }),
    z.object({ verdict: z.literal(ClassifierVerdictType.Uncertain), ...classifierVerdictFields }),
    z.object({ verdict: z.literal(ClassifierVerdictType.Unsafe), ...classifierVerdictFields, category: unsafeCategorySchema }),
]);
export type ClassifierVerdict = z.infer<typeof classifierVerdictSchema>;

/** Sender profile selecting the From address for email tools. */
export const emailSenderProfileSchema = z.enum(['formal', 'informal']);
export type EmailSenderProfile = z.infer<typeof emailSenderProfileSchema>;

/** A WildDuck mailbox-folder and positive numeric message UID. */
export interface MailboxMessageRef {
    folder: string
    uid:    number
}

/** Parses a formatted WildDuck `Folder:uid` message reference. */
export function parseMailboxMessageRef(raw: string): MailboxMessageRef | undefined {
    const delimiter = raw.lastIndexOf(':');
    if(delimiter <= 0) {
        return undefined;
    }

    // `delimiter` is a real, positive index in `raw` here (the `<= 0` guard above rejected both "no
    // colon" and "colon at index 0"), so `folder` is always at least one character: an `!folder` check
    // here would be dead code, and — worse — would silently stand in for the guard above if that
    // boundary were ever weakened, masking the bug instead of catching it.
    const folder = raw.slice(0, delimiter);
    const uid    = Number(raw.slice(delimiter + 1));
    if(/[\r\n]/.test(folder) || !Number.isSafeInteger(uid) || uid <= 0) {
        return undefined;
    }

    return { folder, uid };
}

/** Formats a mailbox message reference for WildDuck's string wire format. */
export function formatMailboxMessageRef(ref: MailboxMessageRef): string {
    return `${ref.folder}:${ref.uid}`;
}

/** Decodes a valid formatted WildDuck mailbox message reference into its parts. */
export const mailboxMessageRefSchema = z.string().transform((raw, context): MailboxMessageRef => {
    const reference = parseMailboxMessageRef(raw);
    if(reference) {
        return reference;
    }
    context.addIssue({ code: 'custom', message: 'Must be in Folder:UID format with a positive safe integer UID' });
    return z.NEVER;
});

/** Decodes a Drafts-only formatted mailbox message reference. */
export const draftsMailboxMessageRefSchema = mailboxMessageRefSchema.refine(
    reference => reference.folder === 'Drafts',
    'Must be in Drafts:UID format (e.g., Drafts:42)'
);

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

/** A search-result address that has a display name but no usable email address. */
export interface NameOnlyEmailAddress {
    name:    string
    address: null
}

/** An address returned by a WildDuck search, including partial address data. */
export type SearchEmailAddress = EmailAddress | NameOnlyEmailAddress | null;

/** Formats an address for human-readable display without producing an outbound address. */
export function formatAddressForDisplay(address: SearchEmailAddress): string {
    if(address === null) {
        return '(no address)';
    }
    if(address.address === null) {
        return `${address.name} (no address)`;
    }
    return address.name ? `${address.name} <${address.address}>` : address.address;
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

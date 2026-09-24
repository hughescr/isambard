export { EmailFolder } from '@/config';
export {
    ClassifierVerdictType,
    SPAM_CATEGORIES,
    UNSAFE_CATEGORIES,
    classifierVerdictSchema,
    draftsMailboxMessageRefSchema,
    emailSenderProfileSchema,
    formatAddressForDisplay,
    formatMailboxMessageRef,
    mailboxMessageRefSchema,
    parseMailboxMessageRef
} from './types';
export type {
    ClassifierVerdict,
    AttachmentData,
    EmailMetadata,
    EmailAddress,
    NameOnlyEmailAddress,
    SearchEmailAddress,
    EmailHeaders,
    VerificationResults,
    AuthCheckResult,
    EmailSenderProfile,
    MailboxMessageRef
} from './types';
export { checkVerificationResults } from './auth-checker';
export { CLASSIFIER_SYSTEM_PROMPT } from './classifier-prompt';
export { EmailClassifier } from './classifier';
export { EmailProcessor } from './email-processor';
export type { ProcessEmailCallbacks } from './email-processor';
export { WildDuckListener } from './wildduck-listener';
export type { WildDuckListenerConfig } from './wildduck-listener';
export { WildDuckClient } from './wildduck-client';
export type { WildDuckAttachment, WildDuckAttachmentMeta } from './wildduck-client';
export { EmailOutboundApprovals, emailSendParamsSchema } from './outbound-approvals';
export { checkEmailSendDelivery } from './delivery-check';
export type { EmailOutboundApprovalsDeps, EmailApprovalRoute } from './outbound-approvals';
export { EmailHistoryProvider } from './history-provider';
export { DRAFT_STATE_FLAG, searchDraftsByReviewState, markDraftReviewState } from './draft-review-state';
export type { DraftReviewState } from './draft-review-state';

export { EmailFolder } from '@/config';
export {
    ClassifierVerdictType,
    SPAM_CATEGORIES,
    UNSAFE_CATEGORIES,
    classifierVerdictSchema,
    draftsMailboxMessageRefSchema,
    emailSenderProfileSchema,
    formatMailboxMessageRef,
    mailboxMessageRefSchema,
    parseMailboxMessageRef
} from './types';
export type {
    ClassifierVerdict,
    AttachmentData,
    EmailMetadata,
    EmailAddress,
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
export {
    buildReviewEmbed,
    buildUnsafeAlert,
    buildRestrictedAccessEmbed,
    buildOutboundApprovalEmbed
} from './review-embed-builder';
export { ReviewHandler } from './review-handler';
export { WildDuckClient } from './wildduck-client';
export type { WildDuckAttachment, WildDuckAttachmentMeta } from './wildduck-client';
export { EmailOutboundApprovalHandler } from './outbound-approval-handler';
export type { EmailOutboundApprovalHandlerDeps } from './outbound-approval-handler';
export { EmailHistoryProvider } from './history-provider';
export { DRAFT_STATE_FLAG, searchDraftsByReviewState, markDraftReviewState } from './draft-review-state';
export type { DraftReviewState } from './draft-review-state';

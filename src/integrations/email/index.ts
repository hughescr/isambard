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
export type { AttachmentStream, WildDuckAttachment, WildDuckAttachmentMeta, WildDuckMessage, WildDuckMessageAttachment, WildDuckUploadPayload } from './wildduck-client';
export { createBoundedRunner, startDraftPreview, TAILSCALE_COMMAND_TIMEOUT_MS } from './preview';
export type { DraftPreview, PreviewServe, PreviewUrlFor, StartDraftPreviewDeps } from './preview';
export { amendedDraftMeta, draftLockKey, hasDecisionMarker, mergeDraftMeta, newPreviewToken, previewTokenMatches, readDraftApprovalMeta } from './draft-approval-meta';
export type { DraftApprovalCardLink, DraftApprovalMarker, DraftApprovalMeta, DraftLocks } from './draft-approval-meta';
export { buildDraftSummary, DRAFT_SNIPPET_MAX_CODE_POINTS, formatAttachmentSize } from './draft-summary';
export type { DraftSummary } from './draft-summary';
export { EmailOutboundApprovals, emailSendParamsSchema } from './outbound-approvals';
export { checkEmailSendDelivery } from './delivery-check';
export type {
    EmailOutboundApprovalsDeps,
    EmailApprovalRoute,
    EmailDecisionRefusal,
    EmailDecisionRefusalReason,
    ApproveSendResult,
    RejectSendResult,
    AllowlistCandidatesResult
} from './outbound-approvals';
export { EmailHistoryProvider } from './history-provider';
export { DRAFT_STATE_FLAG, searchDraftsByReviewState, markDraftReviewState } from './draft-review-state';
export type { DraftReviewState } from './draft-review-state';

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
export { WildDuckClient, isWildDuckAttachmentId } from './wildduck-client';
export type { AttachmentStream, WildDuckAttachment, WildDuckAttachmentMeta, WildDuckMessage, WildDuckMessageAttachment, WildDuckSearchParams, WildDuckSearchRow, WildDuckThreadingHeader, WildDuckUploadPayload } from './wildduck-client';
export { createBoundedRunner, startDraftPreview, TAILSCALE_COMMAND_TIMEOUT_MS } from './preview';
export type { DraftPreview, PreviewServe, PreviewUrlFor, StartDraftPreviewDeps } from './preview';
export { amendedDraftMeta, draftLockKey, hasDecisionMarker, htmlMarker, mergeDraftMeta, newPreviewToken, previewTokenMatches, readDraftApprovalMeta, readDraftHtmlPart, readDraftSendMeta } from './draft-approval-meta';
export type { DraftApprovalCardLink, DraftApprovalMarker, DraftApprovalMeta, DraftHtmlPart, DraftHtmlState, DraftLocks, DraftSendMeta } from './draft-approval-meta';
export { composeEmailBody } from './markdown-body';
export type { ComposedEmailBody, EmailBodyFormat, MarkdownBodyProblem } from './markdown-body';
export { buildDraftSummary, DRAFT_SNIPPET_MAX_CODE_POINTS, formatAttachmentSize } from './draft-summary';
export type { DraftSummary } from './draft-summary';
export { EmailOutboundApprovals, emailSendParamsSchema } from './outbound-approvals';
export { checkEmailSendDelivery } from './delivery-check';
export { submitApprovedDraft } from './approved-send';
export type {
    EmailOutboundApprovalsDeps,
    EmailApprovalRoute,
    EmailDecisionRefusal,
    EmailDecisionRefusalReason,
    ApproveSendResult,
    RejectSendResult,
    AllowlistCandidatesResult,
    CardTarget,
    ReconcileCardLinkResult
} from './outbound-approvals';
export { EmailHistoryProvider } from './history-provider';
export { DRAFT_STATE_FLAG, searchDraftsByReviewState, markDraftReviewState } from './draft-review-state';
export type { DraftReviewState } from './draft-review-state';

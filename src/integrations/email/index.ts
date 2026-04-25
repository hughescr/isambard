export {
    EmailFolder,
    ClassifierVerdictType,
    classifierVerdictSchema,
    EmailIdentity
} from './types';
export type {
    ClassifierVerdict,
    AttachmentData,
    EmailMetadata,
    EmailAddress,
    EmailHeaders,
    VerificationResults,
    AuthCheckResult
} from './types';
export { checkVerificationResults } from './auth-checker';
export { CLASSIFIER_SYSTEM_PROMPT } from './classifier-prompt';
export { EmailClassifier } from './classifier';
export { EmailProcessor } from './email-processor';
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
export { OutboundApprovalHandler } from './outbound-approval-handler';
export type { OutboundApprovalHandlerDeps } from './outbound-approval-handler';
export { EmailHistoryProvider } from './history-provider';

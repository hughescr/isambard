import { logger } from '@hughescr/logger';
import { checkVerificationResults } from '@/integrations/email/auth-checker';
import type { EmailClassifier } from '@/integrations/email/classifier';
import { EmailProcessingError } from '@/integrations/email/errors';
import { EmailFolder, type EmailMetadata, type ClassifierVerdict  } from '@/integrations/email/types';
import type { WildDuckClient } from '@/integrations/email/wildduck-client';
import type { PersonAllowlist } from '@/storage';

interface EmailProcessorDeps {
    allowlist:      PersonAllowlist
    classifier:     EmailClassifier
    wildDuckClient: WildDuckClient
}

interface ProcessEmailCallbacks {
    /** Called when an email is classified as 'safe' but sender is not on allowlist — used for Discord admin notification */
    onSafe?:       (email: EmailMetadata, verdict: ClassifierVerdict) => Promise<void>
    /** Called when an email is classified as 'uncertain' — used for Discord review embed */
    onReview?:     (email: EmailMetadata, verdict: ClassifierVerdict) => Promise<void>
    /** Called when an email is classified as 'unsafe' — used for Discord alert to Craig */
    onUnsafe?:     (email: EmailMetadata, verdict: ClassifierVerdict) => Promise<void>
    /** Called when an allowlisted sender's email fails auth — used for Discord admin warning */
    onAuthFailed?: (email: EmailMetadata) => Promise<void>
}

interface ProcessingResult {
    verdict:           ClassifierVerdict | null
    destinationFolder: string
    allowlistBypassed: boolean
}

export class EmailProcessor {
    private readonly allowlist:      PersonAllowlist;
    private readonly classifier:     EmailClassifier;
    private readonly wildDuckClient: WildDuckClient;
    private readonly callbacks:      ProcessEmailCallbacks;

    constructor(deps: EmailProcessorDeps, callbacks: ProcessEmailCallbacks = {}) {
        this.allowlist      = deps.allowlist;
        this.classifier     = deps.classifier;
        this.wildDuckClient = deps.wildDuckClient;
        this.callbacks      = callbacks;
    }

    /**
     * Process a single email from INBOX:
     * 1. Allowlist + auth bypass check
     * 2. If not bypassed: classifier
     * 3. Route based on verdict
     * Returns the processing result (verdict, destination folder, whether allowlist bypassed)
     */
    async processEmail(email: EmailMetadata): Promise<ProcessingResult> {
        const senderAllowed = this.allowlist.isAllowed('email', email.from.address);

        if(senderAllowed) {
            const auth = checkVerificationResults(email.verificationResults, email.from.address);
            if(auth.spfPass || auth.dkimPass) {
                return this.routeAllowlistBypass(email);
            }
            if(this.callbacks.onAuthFailed) {
                await this.callbacks.onAuthFailed(email);
            }
        }

        return this.routeViaClassifier(email, senderAllowed);
    }

    private async routeAllowlistBypass(email: EmailMetadata): Promise<ProcessingResult> {
        // Stryker disable BlockStatement — WildDuck HTTP API call; catch re-throws as typed EmailProcessingError
        try {
            await this.wildDuckClient.moveMessage(EmailFolder.Inbox, email.uid, EmailFolder.CleanInbox);
        } catch (err) {
            // Stryker disable StringLiteral,ObjectLiteral: Error message content is not behavior-affecting
            throw new EmailProcessingError(
                `Failed to move allowlist-bypassed email (uid=${email.uid}): ${err instanceof Error ? err.message : String(err)}`,
                { uid: email.uid, from: email.from.address }
            );
            // Stryker restore StringLiteral,ObjectLiteral
        }
        // Stryker restore BlockStatement
        // Stryker disable ObjectLiteral,StringLiteral,BooleanLiteral: Log message content is not behavior-affecting
        logger.info({
            uid:               email.uid,
            from:              email.from.address,
            subject:           email.subject,
            destination:       EmailFolder.CleanInbox,
            allowlistBypassed: true,
            msg:               'Email routed (allowlist bypass)',
        });
        // Stryker restore ObjectLiteral,StringLiteral,BooleanLiteral
        return {
            verdict:           null,
            destinationFolder: EmailFolder.CleanInbox,
            allowlistBypassed: true,
        };
    }

    private async routeViaClassifier(email: EmailMetadata, senderAllowed: boolean): Promise<ProcessingResult> {
        let verdict: ClassifierVerdict;
        // Stryker disable BlockStatement — external classifier call; catch re-throws as typed EmailProcessingError
        try {
            verdict = await this.classifier.classify(email);
        } catch (err) {
            // Stryker disable StringLiteral,ObjectLiteral: Error message content is not behavior-affecting
            throw new EmailProcessingError(
                `Classification failed (uid=${email.uid}): ${err instanceof Error ? err.message : String(err)}`,
                { uid: email.uid, from: email.from.address }
            );
            // Stryker restore StringLiteral,ObjectLiteral
        }
        // Stryker restore BlockStatement

        const destination = this.verdictToFolder(verdict.verdict);

        // Stryker disable BlockStatement — WildDuck HTTP API call; catch re-throws as typed EmailProcessingError
        try {
            await this.wildDuckClient.moveMessage(EmailFolder.Inbox, email.uid, destination);
        } catch (err) {
            // Stryker disable StringLiteral,ObjectLiteral: Error message content is not behavior-affecting
            throw new EmailProcessingError(
                `Failed to move email (uid=${email.uid}, destination=${destination}): ${err instanceof Error ? err.message : String(err)}`,
                { uid: email.uid, from: email.from.address, destination }
            );
            // Stryker restore StringLiteral,ObjectLiteral
        }
        // Stryker restore BlockStatement

        await this.invokeCallback(email, verdict, senderAllowed);

        // Stryker disable ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        logger.info({
            uid:        email.uid,
            from:       email.from.address,
            subject:    email.subject,
            verdict:    verdict.verdict,
            confidence: verdict.confidence,
            destination,
            msg:        'Email routed',
        });
        // Stryker restore ObjectLiteral,StringLiteral

        return {
            verdict,
            destinationFolder: destination,
            allowlistBypassed: false,
        };
    }

    private verdictToFolder(verdict: ClassifierVerdict['verdict']): string {
        switch(verdict) {
            case 'safe': {      return EmailFolder.CleanInbox;
            }
            case 'spam': {      return EmailFolder.Junk;
            }
            case 'uncertain': { return EmailFolder.Review;
            }
            case 'unsafe': {    return EmailFolder.Quarantine;
            }
        }
    }

    // onSafe is suppressed for allowlisted senders — onAuthFailed already handles that case.
    // onReview/onUnsafe still fire regardless: admin must know about suspicious emails even from known senders.
    private async invokeCallback(email: EmailMetadata, verdict: ClassifierVerdict, senderAllowed: boolean): Promise<void> {
        if(verdict.verdict === 'safe' && !senderAllowed && this.callbacks.onSafe) {
            await this.callbacks.onSafe(email, verdict);
        } else if(verdict.verdict === 'uncertain' && this.callbacks.onReview) {
            await this.callbacks.onReview(email, verdict);
        } else if(verdict.verdict === 'unsafe' && this.callbacks.onUnsafe) {
            await this.callbacks.onUnsafe(email, verdict);
        }
    }
}

import _ from 'lodash';
import { logger } from '@hughescr/logger';
import { checkAuthentication } from '@/integrations/email/auth-checker';
import { EmailFolder } from '@/integrations/email/types';
import type { EmailMetadata, ClassifierVerdict } from '@/integrations/email/types';
import type { EmailAllowlist } from '@/integrations/email/allowlist';
import type { EmailClassifier } from '@/integrations/email/classifier';
import type { EmailCounterStore } from '@/integrations/email/email-counters';
import type { ImapConnection } from '@/integrations/email/imap-connection';
import { EmailProcessingError } from '@/integrations/email/errors';

export interface EmailProcessorDeps {
    allowlist:  EmailAllowlist
    classifier: EmailClassifier
    counters:   EmailCounterStore
    imap:       ImapConnection
}

export interface ProcessEmailCallbacks {
    /** Called when an email is classified as 'safe' but sender is not on allowlist — used for Discord admin notification */
    onSafe?:   (email: EmailMetadata, verdict: ClassifierVerdict) => Promise<void>
    /** Called when an email is classified as 'uncertain' — used for Discord review embed */
    onReview?: (email: EmailMetadata, verdict: ClassifierVerdict) => Promise<void>
    /** Called when an email is classified as 'unsafe' — used for Discord alert to Craig */
    onUnsafe?: (email: EmailMetadata, verdict: ClassifierVerdict) => Promise<void>
}

export interface ProcessingResult {
    verdict:           ClassifierVerdict | null
    destinationFolder: string
    allowlistBypassed: boolean
}

export class EmailProcessor {
    private readonly allowlist:  EmailAllowlist;
    private readonly classifier: EmailClassifier;
    private readonly counters:   EmailCounterStore;
    private readonly imap:       ImapConnection;
    private readonly callbacks:  ProcessEmailCallbacks;

    constructor(deps: EmailProcessorDeps, callbacks: ProcessEmailCallbacks = {}) {
        this.allowlist  = deps.allowlist;
        this.classifier = deps.classifier;
        this.counters   = deps.counters;
        this.imap       = deps.imap;
        this.callbacks  = callbacks;
    }

    /**
     * Process a single email from INBOX:
     * 1. Allowlist + auth bypass check
     * 2. If not bypassed: classifier
     * 3. Route based on verdict
     * Returns the processing result (verdict, destination folder, whether allowlist bypassed)
     */
    async processEmail(email: EmailMetadata): Promise<ProcessingResult> {
        const senderAllowed = this.allowlist.isAllowed(email.from.address);

        if(senderAllowed) {
            const auth = checkAuthentication(email.headers.authenticationResults, email.from.address);
            if(auth.spfPass || auth.dkimPass) {
                return this.routeAllowlistBypass(email);
            }
        }

        return this.routeViaClassifier(email);
    }

    private async routeAllowlistBypass(email: EmailMetadata): Promise<ProcessingResult> {
        // Stryker disable BlockStatement
        try {
            await this.imap.moveMessage(email.uid, EmailFolder.Inbox, EmailFolder.CleanInbox);
        } catch (err) {
            // Stryker disable StringLiteral,ObjectLiteral: Error message content is not behavior-affecting
            throw new EmailProcessingError(
                `Failed to move allowlist-bypassed email (uid=${email.uid}): ${_.isError(err) ? err.message : String(err)}`,
                { uid: email.uid, from: email.from.address }
            );
            // Stryker enable StringLiteral,ObjectLiteral
        }
        // Stryker restore BlockStatement
        // Stryker disable BlockStatement: try-catch wraps counter sync — best-effort, email routed regardless
        try {
            // Stryker disable next-line StringLiteral: EmailFolder.CleanInbox is configuration constant
            const { total, unread } = await this.imap.getMailboxCounts(EmailFolder.CleanInbox);
            await this.counters.reset(total, unread);
        } catch (countErr) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            logger.warn({ error: _.isError(countErr) ? countErr.message : String(countErr), msg: 'Failed to sync counters after inbox delivery' });
        }
        // Stryker disable ObjectLiteral,StringLiteral,BooleanLiteral: Log message content is not behavior-affecting
        logger.info({
            uid:               email.uid,
            from:              email.from.address,
            subject:           email.subject,
            destination:       EmailFolder.CleanInbox,
            allowlistBypassed: true,
            msg:               'Email routed (allowlist bypass)',
        });
        // Stryker enable ObjectLiteral,StringLiteral,BooleanLiteral
        return {
            verdict:           null,
            destinationFolder: EmailFolder.CleanInbox,
            allowlistBypassed: true,
        };
    }

    private async routeViaClassifier(email: EmailMetadata): Promise<ProcessingResult> {
        let verdict: ClassifierVerdict;
        // Stryker disable BlockStatement
        try {
            verdict = await this.classifier.classify(email);
        } catch (err) {
            // Stryker disable next-line StringLiteral,ObjectLiteral: Error message content is not behavior-affecting
            throw new EmailProcessingError(
                `Classification failed (uid=${email.uid}): ${_.isError(err) ? err.message : String(err)}`,
                { uid: email.uid, from: email.from.address }
            );
        }
        // Stryker restore BlockStatement

        const destination = this.verdictToFolder(verdict.verdict);

        // Stryker disable BlockStatement
        try {
            await this.imap.moveMessage(email.uid, EmailFolder.Inbox, destination);
        } catch (err) {
            // Stryker disable next-line StringLiteral,ObjectLiteral: Error message content is not behavior-affecting
            throw new EmailProcessingError(
                `Failed to move email (uid=${email.uid}, destination=${destination}): ${_.isError(err) ? err.message : String(err)}`,
                { uid: email.uid, from: email.from.address, destination }
            );
        }
        // Stryker restore BlockStatement

        if(destination === EmailFolder.CleanInbox) {
            // Stryker disable BlockStatement: try-catch wraps counter sync — best-effort, email routed regardless
            try {
                // Stryker disable next-line StringLiteral: EmailFolder.CleanInbox is configuration constant
                const { total, unread } = await this.imap.getMailboxCounts(EmailFolder.CleanInbox);
                await this.counters.reset(total, unread);
            } catch (countErr) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
                logger.warn({ error: _.isError(countErr) ? countErr.message : String(countErr), msg: 'Failed to sync counters after inbox delivery' });
            }
        }

        await this.invokeCallback(email, verdict);

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
        // Stryker enable ObjectLiteral,StringLiteral

        return {
            verdict,
            destinationFolder: destination,
            allowlistBypassed: false,
        };
    }

    private verdictToFolder(verdict: ClassifierVerdict['verdict']): string {
        switch(verdict) {
            case 'safe':      return EmailFolder.CleanInbox;
            case 'spam':      return EmailFolder.Junk;
            case 'uncertain': return EmailFolder.Review;
            case 'unsafe':    return EmailFolder.Quarantine;
        }
    }

    private async invokeCallback(email: EmailMetadata, verdict: ClassifierVerdict): Promise<void> {
        if(verdict.verdict === 'safe' && this.callbacks.onSafe) {
            await this.callbacks.onSafe(email, verdict);
        } else if(verdict.verdict === 'uncertain' && this.callbacks.onReview) {
            await this.callbacks.onReview(email, verdict);
        } else if(verdict.verdict === 'unsafe' && this.callbacks.onUnsafe) {
            await this.callbacks.onUnsafe(email, verdict);
        }
    }
}

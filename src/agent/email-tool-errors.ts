import { randomBytes } from 'node:crypto';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mcpErrorResult } from './mcp-helpers';
import { EmailProcessingError, WildDuckAuthError, WildDuckError, type WildDuckErrorKind } from '@/errors';

/**
 * What went wrong in an email tool, as Izzy is told it: no answer in time (`timeout`), no such
 * mailbox, message or attachment (`not_found`), a 4xx refusal (`refused`), a 5xx, network or
 * unrecognised failure (`unavailable`), a refused login (`auth`), or a request refused before it
 * reached WildDuck (`invalid_request`).
 */
export type EmailToolErrorCode = 'timeout' | 'not_found' | 'refused' | 'unavailable' | 'auth' | 'invalid_request';

/**
 * One fixed sentence per code: what happened and what to do next. WildDuck's own text is
 * untrusted and unbounded, so none of it ever reaches a tool result.
 */
export const EMAIL_TOOL_ERROR_SENTENCES: Readonly<Record<EmailToolErrorCode, string>> = {
    timeout:         'The mail server did not answer in time, so it is not known whether this took effect. Check the current state (search or list again) before trying again.',
    not_found:       'The mailbox, message or attachment was not found; it may have been moved or deleted. Search or list again for its current reference.',
    refused:         'The mail server refused this request, so it did not take effect. Do not repeat it unchanged; if it should have worked, tell the admin.',
    unavailable:     'The mail service is unavailable or failed while handling this, so it is not known whether a change took effect. Check the current state before trying again later; if it keeps failing, tell the admin.',
    auth:            'The mail server refused the mail account\'s login. Do not retry; tell the admin, who has to fix the account\'s credentials.',
    invalid_request: 'The request was refused before it reached the mail server: a mailbox or attachment reference in it is not one the mail server can have. Check the reference and try again.',
};

/** The most characters of a failure's own text the log keeps (the tool result carries none of it). */
export const EMAIL_ERROR_LOG_DETAIL_MAX_CHARS = 500;

/** A classified failure and the reference that ties its tool text to its log line. */
export interface EmailToolFailure {
    code:      EmailToolErrorCode
    reference: string
}

/** A WildDuck HTTP status as a code: 404 not found, 408 timeout, any other 4xx refused, anything else unavailable. */
function codeForStatus(status: number): EmailToolErrorCode {
    if(status === 404) {
        return 'not_found';
    }
    if(status === 408) {
        return 'timeout';
    }
    return status >= 400 && status <= 499 ? 'refused' : 'unavailable';
}

/** A status-less WildDuckError's kind as a code: `invalid_request` and `timeout` are their own; any other kind, or none, is unavailable. */
function codeForKind(kind: WildDuckErrorKind | undefined): EmailToolErrorCode {
    return kind === 'invalid_request' || kind === 'timeout' ? kind : 'unavailable';
}

/**
 * Classifies a failure from its type and a WildDuckError's structured context (its status, else
 * its kind), never from its message: a refused login is `auth`, a request deadline
 * (`TimeoutError`) is `timeout`, and anything unrecognised is `unavailable`.
 */
export function classifyEmailToolError(error: unknown): EmailToolErrorCode {
    if(error instanceof WildDuckAuthError) {
        return 'auth';
    }
    if(error instanceof WildDuckError) {
        const status = error.context?.status;
        return status === undefined ? codeForKind(error.context?.kind) : codeForStatus(status);
    }
    return error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unavailable';
}

/** A short random reference (eight hex digits) shared by a failure's tool text and its log line. */
export function newErrorReference(): string {
    return randomBytes(4).toString('hex');
}

/** `text` cut to {@link EMAIL_ERROR_LOG_DETAIL_MAX_CHARS}, ending with an ellipsis when cut. */
function boundedDetail(text: string): string {
    return text.length > EMAIL_ERROR_LOG_DETAIL_MAX_CHARS ? `${text.slice(0, EMAIL_ERROR_LOG_DETAIL_MAX_CHARS)}…` : text;
}

/**
 * Classifies a failure and logs it — the tool, code and reference, a WildDuckError's status and
 * kind when it has them, the error's name and its text (bounded) — and returns the code and the
 * reference for the tool text. The log line never carries request headers or the access token.
 */
export function recordEmailToolFailure(toolName: string, error: unknown, newReference: () => string = newErrorReference): EmailToolFailure {
    const failure: EmailToolFailure = { code: classifyEmailToolError(error), reference: newReference() };
    const context = error instanceof WildDuckError ? error.context : undefined;
    logger.warn({
        tool:      toolName,
        code:      failure.code,
        reference: failure.reference,
        ...(context?.status === undefined ? {} : { status: context.status }),
        ...(context?.kind === undefined ? {} : { kind: context.kind }),
        error:     error instanceof Error ? error.name : typeof error,
        detail:    boundedDetail(error instanceof Error ? error.message : String(error)),
        msg:       'Email tool failed',
    });
    return failure;
}

/** A classified failure as Izzy reads it: the tool, the code, the code's fixed sentence and the reference. */
export function emailToolErrorText(toolName: string, failure: EmailToolFailure): string {
    return `${toolName} failed (${failure.code}): ${EMAIL_TOOL_ERROR_SENTENCES[failure.code]} Reference: ${failure.reference}.`;
}

/**
 * Wraps an email tool handler: a thrown failure is logged and returned as its classified tool
 * text ({@link emailToolErrorText}). An EmailProcessingError is Isambard's own text about the
 * request (a missing attachment file, say), so it is returned as `Error: <message>` unchanged.
 */
export function withEmailToolErrorHandling<T>(
    toolName: string,
    handler: (args: T) => Promise<CallToolResult>,
    newReference: () => string = newErrorReference
): (args: T) => Promise<CallToolResult> {
    return async (args: T) => {
        try {
            return await handler(args);
        } catch (error) {
            if(error instanceof EmailProcessingError) {
                logger.warn({ tool: toolName, error: error.message, msg: 'Email tool failed' });
                return mcpErrorResult(error);
            }
            const failure = recordEmailToolFailure(toolName, error, newReference);
            return { content: [{ type: 'text' as const, text: emailToolErrorText(toolName, failure) }], isError: true };
        }
    };
}

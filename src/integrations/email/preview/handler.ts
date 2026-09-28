import { logger } from '@hughescr/logger';
import { hasDecisionMarker, previewTokenMatches, readDraftApprovalMeta } from '../draft-approval-meta';
import type { WildDuckClient, WildDuckMessage } from '../wildduck-client';
import { renderPreviewPage } from './render';
import { EmailFolder } from '@/config';

/**
 * `/d/<uid>/<token>` (the page), `…/body` (the HTML body) or `…/a/<attachment id>`. The token is
 * exactly 43 base64url characters, so anything else is refused before WildDuck is read.
 */
const PREVIEW_PATH = /^\/d\/(\d{1,10})\/([\w-]{43})(\/body|\/a\/(ATT\d{1,6}))?$/u;

/** An attachment's declared type is passed through only when it is a bare `type/subtype`. */
const MIME_TYPE = /^[\w.+-]+\/[\w.+-]+$/u;

const PAGE_CSP = 'default-src \'none\'; style-src \'unsafe-inline\'; frame-src \'self\'; img-src \'none\'; base-uri \'none\'; form-action \'none\'; frame-ancestors \'none\'';
/** `sandbox` gives the HTML body an opaque origin with no script, even when opened directly. */
const BODY_CSP = 'sandbox; default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; frame-ancestors \'self\'';

const NOT_FOUND = 'Not found.';
const MAIL_SERVER_ERROR = 'Could not read the draft from the mail server.';

/** Headers on every preview response. */
const COMMON_HEADERS: Readonly<Record<string, string>> = {
    'Cache-Control':          'no-store',
    'Referrer-Policy':        'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options':        'SAMEORIGIN',
};

export interface DraftPreviewHandlerDeps {
    wildDuckClient: Pick<WildDuckClient, 'getMessage' | 'openAttachmentStream'>
    /** How long after the draft's Date its preview link works. */
    ttlMs:          number
    /** When set, only these `Tailscale-User-Login` values (lower-cased) are admitted. */
    allowedLogins?: readonly string[]
    now:            () => number
}

function respond(status: number, body: BodyInit | null, headers: Record<string, string>): Response {
    return new Response(body, { status, headers: { ...COMMON_HEADERS, ...headers } });
}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
    return respond(status, message, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * A `Content-Disposition: attachment` value naming `filename` both as ASCII (non-ASCII and control
 * characters replaced with `_`) and as RFC 5987 UTF-8. CR, LF, quotes and backslashes are stripped first; an empty
 * name becomes `attachment`.
 */
export function attachmentContentDisposition(filename: string): string {
    const cleaned = filename.replaceAll(/[\r\n"\\]/gu, '');
    const name = cleaned === '' ? 'attachment' : cleaned;
    const ascii = name.replaceAll(/[\P{ASCII}\p{Cc}]/gu, '_');
    const encoded = encodeURIComponent(name).replaceAll(/['()*]/gu, char => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Whether the draft's link has outlived the TTL; an unreadable Date counts as expired, and so
 * does a missing one ("undefined" and "null" never parse).
 */
function expired(draft: WildDuckMessage, ttlMs: number, now: number): boolean {
    const dated = Date.parse(String(draft.date));
    return Number.isNaN(dated) || dated + ttlMs < now;
}

/**
 * The draft preview request handler (#158). It only reads: every request fetches the draft live
 * from WildDuck, so nothing is stored and a restart changes nothing. Checks, in order: GET only
 * (405); the optional Tailscale login allowlist (403); the path (404); the draft read (502 when
 * WildDuck fails); a missing, non-draft or superseded draft, or a token that does not match in
 * constant time (one identical 404); a decision marker (410); the TTL (410). Then the page, the
 * HTML body or an attachment stream. Logs carry the uid and status, never the token.
 */
export function createDraftPreviewHandler(deps: DraftPreviewHandlerDeps): (request: Request) => Promise<Response> {
    const { wildDuckClient, ttlMs, allowedLogins, now } = deps;

    async function route(request: Request, uid: number, token: string, subpath: string | undefined, attachmentId: string | undefined): Promise<Response> {
        let draft: WildDuckMessage | null;
        try {
            draft = await wildDuckClient.getMessage(EmailFolder.Drafts, uid, request.signal);
        } catch (err: unknown) {
            logger.warn({ uid, status: 502, error: errorText(err), msg: 'Draft preview could not read the draft' });
            return text(502, MAIL_SERVER_ERROR);
        }
        const meta = readDraftApprovalMeta(draft?.metaData);
        if(draft?.draft !== true || meta.supersededBy !== undefined || !previewTokenMatches(meta.previewToken, token)) {
            return text(404, NOT_FOUND);
        }
        if(hasDecisionMarker(meta)) {
            return text(410, 'This draft has been approved or rejected.');
        }
        if(expired(draft, ttlMs, now())) {
            return text(410, 'Preview link expired.');
        }

        if(subpath === undefined) {
            return respond(200, renderPreviewPage(draft, token), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP });
        }
        if(attachmentId === undefined) {
            const html = (draft.html ?? []).join('\n');
            return html.trim() === ''
                ? text(404, NOT_FOUND)
                : respond(200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': BODY_CSP });
        }
        return attachment(request, uid, draft, attachmentId);
    }

    async function attachment(request: Request, uid: number, draft: WildDuckMessage, attachmentId: string): Promise<Response> {
        const declared = (draft.attachments ?? []).find(candidate => candidate.id === attachmentId);
        if(declared === undefined) {
            return text(404, NOT_FOUND);
        }
        let stream: Awaited<ReturnType<typeof wildDuckClient.openAttachmentStream>>;
        try {
            stream = await wildDuckClient.openAttachmentStream(EmailFolder.Drafts, uid, attachmentId, request.signal);
        } catch (err: unknown) {
            logger.warn({ uid, status: 502, error: errorText(err), msg: 'Draft preview could not read the attachment' });
            return text(502, MAIL_SERVER_ERROR);
        }
        if(stream === null) {
            return text(404, NOT_FOUND);
        }
        return respond(200, stream.body, {
            'Content-Type':            MIME_TYPE.test(declared.contentType) ? declared.contentType : 'application/octet-stream',
            'Content-Disposition':     attachmentContentDisposition(declared.filename),
            'Content-Security-Policy': 'sandbox',
            ...(stream.contentLength === undefined ? {} : { 'Content-Length': String(stream.contentLength) }),
        });
    }

    return async (request: Request): Promise<Response> => {
        if(request.method !== 'GET') {
            return text(405, 'Method not allowed.', { Allow: 'GET' });
        }
        const login = request.headers.get('Tailscale-User-Login');
        if(allowedLogins !== undefined && (login === null || !allowedLogins.includes(login.toLowerCase()))) {
            return text(403, 'Forbidden.');
        }
        const match = PREVIEW_PATH.exec(new URL(request.url).pathname);
        if(match === null) {
            return text(404, NOT_FOUND);
        }
        const [, uidText, token, subpath, attachmentId] = match;
        const uid = Number(uidText);
        // The pattern's token group is not optional, so it is always present on a match.
        const response = await route(request, uid, token!, subpath, attachmentId);
        logger.info({ uid, status: response.status, msg: 'Draft preview request' });
        return response;
    };
}

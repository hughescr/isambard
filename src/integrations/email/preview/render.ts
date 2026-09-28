import { formatAttachmentSize } from '../draft-summary';
import type { WildDuckMessage } from '../wildduck-client';

/** Text made safe to place in HTML content or a quoted attribute (`&` first, so no escape is escaped twice). */
export function escapeHtml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

interface Address {
    address: string
    name?:   string
}

const NONE = '(none)';

function formatAddress(address: Address | undefined): string {
    if(address === undefined) {
        return '';
    }
    return address.name ? `${address.name} <${address.address}>` : address.address;
}

function formatAddresses(list: Address[] | undefined): string {
    return (list ?? []).map(address => formatAddress(address)).join(', ');
}

function orNone(value: string | null | undefined): string {
    return value ? escapeHtml(value) : NONE;
}

const STYLE = `body{font:15px/1.45 system-ui,sans-serif;margin:16px;max-width:960px;color:#1d1d1f;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e8e8ea;background:#1c1c1e}th{color:#aaa}}
h1{font-size:1.3em}h2{font-size:1.1em;margin-top:1.6em}
table{border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:3px 10px 3px 0;overflow-wrap:anywhere}
th{color:#555;font-weight:600;white-space:nowrap}
pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;border:1px solid #8884;border-radius:6px}
iframe{width:100%;height:70vh;border:1px solid #8884;border-radius:6px;background:#fff}
.none{color:#888}`;

/**
 * The draft preview page (#158): every header, the full plain-text body, the HTML body framed from
 * its own sandboxed URL (`<token>/body`), and the attachments with download links. Every value is
 * HTML-escaped; links are relative to the page (`/d/<uid>/<token>`), so they work behind any path
 * prefix `tailscale serve` adds. The page itself embeds no draft HTML.
 */
export function renderPreviewPage(draft: WildDuckMessage, token: string): string {
    const headers: [string, string][] = [
        ['From', orNone(formatAddress(draft.from))],
        ['To', orNone(formatAddresses(draft.to))],
        ['Cc', orNone(formatAddresses(draft.cc))],
        ['Bcc', orNone(formatAddresses(draft.bcc))],
        ['Reply-To', orNone(formatAddress(draft.replyTo))],
        ['Subject', orNone(draft.subject)],
        ['Date', orNone(draft.date)],
        ['Message-ID', orNone(draft.messageId)],
        ['Draft', `Drafts:${draft.id}`],
    ];
    const base = escapeHtml(token);
    const hasHtml = (draft.html ?? []).join('').trim() !== '';
    const attachments = draft.attachments ?? [];

    const text = draft.text === undefined
        ? '<p class="none">(no plain-text part)</p>'
        : `<pre>${escapeHtml(draft.text)}</pre>`;
    const html = hasHtml
        ? `<iframe sandbox src="${base}/body" title="HTML body"></iframe>`
        : '<p class="none">(no HTML part)</p>';
    const attachmentRows = attachments.map((attachment) => {
        const link = `<a href="${base}/a/${escapeHtml(attachment.id)}" download>${escapeHtml(attachment.filename)}</a>`;
        const size = formatAttachmentSize(attachment.size ?? attachment.sizeKb * 1024);
        return `<tr><td>${link}</td><td>${escapeHtml(attachment.contentType)}</td><td>${size}</td></tr>`;
    });
    const attachmentList = attachments.length === 0
        ? '<p class="none">No attachments.</p>'
        : `<table class="attachments">\n${attachmentRows.join('\n')}\n</table>`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Draft preview: ${orNone(draft.subject)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Draft preview</h1>
<table class="headers">
${headers.map(([name, value]) => `<tr><th>${name}</th><td>${value}</td></tr>`).join('\n')}
</table>
<h2>Text</h2>
${text}
<h2>HTML</h2>
${html}
<h2>Attachments (${attachments.length})</h2>
${attachmentList}
</body>
</html>
`;
}

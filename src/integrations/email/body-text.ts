import { compile, type SelectorDefinition } from 'html-to-text';

/** A table cell is a block of its own, one line from its neighbours. */
const TABLE_CELL = { leadingLineBreaks: 1, trailingLineBreaks: 1 };

/** html-to-text upper-cases headings by default; each level keeps the case it was written in. */
const HEADINGS: SelectorDefinition[] = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(selector => ({ selector, format: 'heading', options: { uppercase: false } }));

/**
 * HTML as Izzy reads it: no wrapping; a link as `label [url]`, or its URL once when that is its
 * label (a `mailto:` link shows its address, without the `mailto:`), and no URL for a `cid:` or `#`
 * link; images dropped (alt text too, so a tracking pixel leaves nothing); headings in their own
 * case; table rows as blocks and cells one per line, never padded into columns. An element with the
 * `hidden` attribute or an inline `display:none` style is dropped; text hidden any other way
 * (a stylesheet, zero size, white on white) is kept.
 */
const htmlToText = compile({
    wordwrap:  false,
    selectors: [
        { selector: 'a', format: 'anchor', options: { hideLinkHrefIfSameAsText: true } },
        { selector: 'a[href^="cid:" i]', format: 'anchor', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
        ...HEADINGS,
        { selector: '[hidden]', format: 'skip' },
        { selector: '[style*="display:none" i]', format: 'skip' },
        { selector: '[style*="display: none" i]', format: 'skip' },
        { selector: 'tr', format: 'block' },
        { selector: 'th', format: 'block', options: TABLE_CELL },
        { selector: 'td', format: 'block', options: TABLE_CELL },
    ],
});

/** A message's body as text: cut to the size limit, and the whole text too when it was cut. */
export interface MessageBody {
    /** The body, cut to the size limit with a last line saying so when it was longer. */
    bodyText:      string
    /** The whole body text, uncut; present only when `bodyText` was cut. */
    fullBodyText?: string
}

/**
 * `body` cut to at most `maxBytes` bytes of UTF-8, backing up to a whole character, with a last
 * line saying how many bytes of how many are shown, and the whole `body` beside it; a body within
 * the limit is returned as it is, with no full text.
 */
function truncateBody(body: string, maxBytes: number): MessageBody {
    const bytes = Buffer.from(body, 'utf8');
    if(bytes.length <= maxBytes) {
        return { bodyText: body };
    }
    let end = maxBytes;
    // A Buffer created from UTF-8 text cannot start with a continuation byte, so this stops at byte zero at the latest.
    // eslint-disable-next-line no-bitwise -- UTF-8 continuation-byte mask (0xC0/0x80), not integer math
    while((bytes[end]! & 0xC0) === 0x80) {
        end--;
    }
    // Stryker disable next-line llm: Buffer.slice is the deprecated alias of subarray; both return the same view.
    return { bodyText: `${bytes.subarray(0, end).toString('utf8')}\n[body truncated: showing the first ${end} of ${bytes.length} bytes]`, fullBodyText: body };
}

/**
 * A message's body as text, from its plain-text part and its HTML parts (WildDuck returns one
 * string per HTML part): the HTML parts joined and converted ({@link htmlToText}) when they yield
 * anything but whitespace, else the text part unchanged; then cut to `maxBytes` ({@link truncateBody}),
 * keeping the whole text when it is cut.
 */
export function messageBody(text: string | undefined, html: string[] | undefined, maxBytes: number): MessageBody {
    const fromHtml = html === undefined ? '' : htmlToText(html.join('\n'));
    return truncateBody(fromHtml.trim() === '' ? text ?? '' : fromHtml, maxBytes);
}

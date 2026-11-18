import MarkdownItConstructor, { type Env, type MarkdownIt, type Token as MarkdownToken } from 'markdown-it';
import { formatAttachmentSize } from './draft-summary';

/**
 * An outbound email body written in markdown, rendered from ONE markdown-it parse into a plain-text
 * part and a conservative HTML fragment in a single walk of its tokens. Every piece of visible text
 * goes to both parts at once, and a link's URL is always shown in the text, so every visible word
 * and every URL of the HTML is also in the text — the part the admin's approval card shows.
 *
 * Only composition constructs are recognised: ATX headings, emphasis and strong, links (inline,
 * reference, `<…>` autolinks and bare http(s)/mailto URLs), images, ordered, bullet and nested
 * lists, block quotes, code spans, fenced and indented code, tables, line breaks, rules and
 * entities. Raw HTML is literal text in both parts (`html: false`, and the HTML rules are never
 * enabled). Only absolute http(s) URLs with a host and no user, and `mailto:` one plain address,
 * become `<a>` elements; any other link renders as text showing its label and destination, and
 * every image as a link or text in the same way. The HTML has no scripts, no
 * external resources and no attributes but `style`, `href` and an ordered list's `start`.
 */

/** How a body is written: plain text sent as it is, or markdown rendered into text and HTML. */
export type EmailBodyFormat = 'text' | 'markdown';

/** An outbound body as uploaded: its text part, and its HTML part when it has one. */
export interface ComposedEmailBody {
    text:  string
    html?: string
}

/** Why a markdown body cannot be used; nothing is uploaded. */
export interface MarkdownBodyProblem {
    problem: string
}

/** The byte limits on a markdown body (UTF-8): its source, and each rendered part. */
export interface MarkdownLimits {
    sourceBytes: number
    textBytes:   number
    htmlBytes:   number
}

/**
 * 64 KB of markdown; 90 KB of rendered text and 500 KB of rendered HTML, under the 100 KB of text
 * and 640 KB of HTML WildDuck's message GET returns, so an amend that keeps the body carries all of it.
 */
export const MARKDOWN_LIMITS: MarkdownLimits = { sourceBytes: 64 * 1024, textBytes: 90 * 1024, htmlBytes: 500 * 1024 };

/** The deepest markdown-it block level allowed: about 19 nested quotes, or 9 nested lists. */
const MAX_NESTING = 20;

const NESTING_PROBLEM = 'the markdown body nests lists or block quotes too deeply';

/** What a parse records: whether it reached {@link MAX_NESTING}. */
type RenderEnv = Env & { tooDeep?: boolean };

function createMarkdown(): MarkdownIt {
    // The `zero` preset sets `html: false` and enables no rule but paragraphs and text, so the
    // HTML rules stay off; every line break renders as a break (the walk below, not `breaks`).
    const md = new MarkdownItConstructor('zero', { linkify: true, maxNesting: MAX_NESTING });
    md.enable([
        'heading', 'list', 'blockquote', 'code', 'fence', 'table', 'hr', 'reference',
        'newline', 'escape', 'backticks', 'emphasis', 'link', 'image', 'autolink', 'entity',
        'linkify',
    ]);
    // Link only explicit http:, https: and mailto: URLs: no bare domains or emails, no ftp: or //.
    md.linkify.set({ fuzzyLink: false, fuzzyEmail: false }).add('ftp:', null).add('//', null);
    // markdown-it silently drops whatever is nested deeper than maxNesting; record it instead, so
    // the body is refused rather than sent without it. Skipping to the end of the range is what
    // markdown-it itself does there, so the enclosing rule still terminates.
    const tokenize = md.block.tokenize.bind(md.block);
    md.block.tokenize = (state, startLine, endLine) => {
        if(state.level >= MAX_NESTING) {
            (state.env as RenderEnv).tooDeep = true;
            state.line = endLine;
            return;
        }
        tokenize(state, startLine, endLine);
    };
    return md;
}

const markdown = createMarkdown();

// Inline styles only (mail clients strip stylesheets), and none on ordinary text, so the reader's
// own font, size, colour and dark mode apply.
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const FAINT = 'rgba(127,127,127,0.15)';
const RULE = '#d0d7de';
const STYLE = {
    paragraph: 'margin:0 0 1em',
    list:      'margin:0 0 1em;padding-left:2em',
    item:      'margin:0 0 .25em',
    // A quote is a styled <div>: some clients (Spark) take the first <blockquote> for a quoted reply and hide the rest.
    quote:     'margin:0 0 1em .8ex;border-left:2px solid #c0c0c0;padding-left:1ex',
    pre:       `margin:0 0 1em;padding:12px;border-radius:6px;background:${FAINT};font-family:${MONO};font-size:.9em;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word`,
    // Gmail gives a bare <code> inside <pre> its own smaller monospace size; inherit the pre's instead.
    preCode:   'font-family:inherit;font-size:1em',
    code:      `font-family:${MONO};font-size:.9em;background:${FAINT};padding:.1em .35em;border-radius:4px`,
    hr:        `border:0;border-top:1px solid ${RULE};margin:1em 0`,
    table:     'border-collapse:collapse;width:auto;margin:0 0 1em',
    th:        'padding:6px 12px;font-weight:bold;vertical-align:bottom;border-bottom:2px solid #8c959f',
    td:        `padding:6px 12px;vertical-align:top;border-bottom:1px solid ${RULE}`,
};

/** h1 to h3 sizes; deeper headings are the body size. */
const HEADING_SIZES = ['1.4em', '1.2em', '1.1em'];

/** The text underline of an h1 and an h2; deeper headings have none. */
const UNDERLINES = ['=', '-'];

const HR_TEXT = '-'.repeat(40);

/** The longest destination, in characters, that can become a link; a longer one is plain text. */
const MAX_LINK_DESTINATION = 2048;

/** A `mailto:` link's only form: one plain address, with no query, no second recipient and no percent encoding. */
const MAILTO_ADDRESS = /^mailto:[\w.+-]+@[\da-z-]+(?:\.[\da-z-]+)+$/iu;

/** How a web link's destination must start: the scheme and then `//`, in any case. */
const WEB_SCHEME = /^https?:\/\//iu;

/**
 * Whether a destination can become an `<a>`: at most {@link MAX_LINK_DESTINATION} characters, and
 * either `mailto:` and one plain address, or an absolute http: or https: URL written with `//`, so
 * with a host (WHATWG refuses an http(s) URL without one), and with no user or password before it
 * (`https://bank.example@evil.example` goes to evil.example). Anything else — `https:report`,
 * `//host`, a backslash for a slash — would resolve against the reader's page, or hide where it
 * goes, so it is shown as text instead.
 */
function isLinkDestination(href: string): boolean {
    if(href.length > MAX_LINK_DESTINATION) {
        return false;
    }
    if(MAILTO_ADDRESS.test(href)) {
        return true;
    }
    const url = URL.parse(href);
    return url !== null && WEB_SCHEME.test(href) && url.username === '' && url.password === '';
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };

function escapeHtml(value: string): string {
    return value.replaceAll(/[&<>"']/gu, char => ESCAPES[char]!);
}

/** One piece of the body in both parts. */
interface Rendered {
    text: string
    html: string
}

function append(target: Rendered, piece: Rendered): void {
    target.text += piece.text;
    target.html += piece.html;
}

/**
 * Running lower bounds, in UTF-16 code units, of the text and HTML the walk has already committed
 * to the finished body. A string never has more UTF-16 code units than UTF-8 bytes, so a bound past
 * a byte limit proves that finished part would be past it too: the walk stops there, building
 * nothing more, and the exact UTF-8 checks on the finished parts decide every body it walks to the
 * end. The HTML bound starts at -1 for the newline trimmed from the end of the finished HTML.
 */
interface Budget {
    readonly limits: MarkdownLimits
    text:            number
    html:            number
}

function spend(budget: Budget, text: number, html: number): void {
    budget.text += text;
    budget.html += html;
}

/** A piece, spent in full. */
function spent(budget: Budget, piece: Rendered): Rendered {
    spend(budget, piece.text.length, piece.html.length);
    return piece;
}

/** The part whose limit the output has certainly passed, if either: the text first. */
function passed(budget: Budget): 'text' | 'html' | undefined {
    if(budget.text > budget.limits.textBytes) {
        return 'text';
    }
    return budget.html > budget.limits.htmlBytes ? 'html' : undefined;
}

/**
 * A link (or an image) in both parts, and `added`: how much text it shows beyond its label (all
 * of it, when the label is blank). The text shows the label and then the destination in brackets,
 * exactly as the HTML's `href` carries it, unless the label is exactly the destination, or is the
 * address of a `mailto:` + that address; a blank label is the destination. The HTML is an `<a>`
 * only for a link destination ({@link isLinkDestination}) outside another link; otherwise it is
 * the same label and bracketed destination as plain text.
 */
function renderLink(href: string, label: Rendered, linkable: boolean): Rendered & { added: number } {
    const blank = label.text.trim() === '';
    const shown = blank ? { text: href, html: escapeHtml(href) } : label;
    const once = shown.text === href || (href === `mailto:${shown.text}` && MAILTO_ADDRESS.test(href));
    const suffix = once ? '' : ` [${href}]`;
    const text = `${shown.text}${suffix}`;
    const added = blank ? text.length : suffix.length;
    return linkable && isLinkDestination(href)
        ? { text, html: `<a href="${escapeHtml(href)}">${shown.html}</a>`, added }
        : { text, html: `${shown.html}${escapeHtml(suffix)}`, added };
}

/**
 * An inline token's children in both parts: text, code spans, breaks, emphasis, links and images;
 * in an image's alt text (`inAlt`), whose HTML is only its escaped text, code spans are plain.
 * Spends every piece that shows text as it goes — a piece that shows text is in the finished body
 * however it is nested, since only a blank label is dropped (for its destination) — and stops at
 * the first token that passes a limit.
 */
function renderInline(tokens: readonly MarkdownToken[], budget: Budget, inAlt = false): Rendered {
    /** The link being rendered: what came before it, and its URL. */
    let open: { outer: Rendered, href: string } | undefined;
    let out: Rendered = { text: '', html: '' };
    const emit = (piece: Rendered): void => {
        append(out, piece);
        if(piece.text.trim() !== '') {
            spend(budget, piece.text.length, piece.html.length);
        }
    };
    // A link's HTML has at least as many code units beyond its label as its text does.
    const emitLink = (href: string, label: Rendered, linkable: boolean): void => {
        const { text, html, added } = renderLink(href, label, linkable);
        append(out, { text, html });
        spend(budget, added, added);
    };
    for(const token of tokens) {
        switch(token.type) {
            case 'text': {
                emit({ text: token.content, html: escapeHtml(token.content) });
                break;
            }
            case 'code_inline': {
                const code = escapeHtml(token.content);
                emit({ text: token.content, html: inAlt ? code : `<code style="${STYLE.code}">${code}</code>` });
                break;
            }
            case 'softbreak':
            case 'hardbreak': {
                append(out, { text: '\n', html: '<br>\n' });
                break;
            }
            case 'link_open': {
                open = { outer: out, href: String(token.attrGet('href')) };
                out = { text: '', html: '' };
                break;
            }
            case 'link_close': {
                // markdown-it never nests a link in a link, so the label is everything since its link_open.
                const link = open!;
                const label = out;
                open = undefined;
                out = link.outer;
                emitLink(link.href, label, true);
                break;
            }
            case 'image': {
                const alt = renderInline(token.children!, budget, true).text;
                emitLink(String(token.attrGet('src')), { text: alt, html: escapeHtml(alt) }, open === undefined);
                break;
            }
            default: {
                // em and strong: markup only.
                out.html += `<${token.nesting === -1 ? '/' : ''}${token.tag}>`;
            }
        }
        if(passed(budget) !== undefined) {
            break;
        }
    }
    return out;
}

/** Each line of `body` after a prefix: `first` on the first line, `rest` on the others; a blank line gets the prefix without its trailing spaces. */
function prefixLines(body: string, first: string, rest: string): string {
    return body.split('\n').map((line, index) => {
        const prefix = index === 0 ? first : rest;
        return line === '' ? prefix.trimEnd() : `${prefix}${line}`;
    }).join('\n');
}

function joinWith(separator: string): (blocks: string[]) => string {
    return blocks => blocks.join(separator);
}

/**
 * The text of a paragraph, heading or table cell: markdown-it gives each exactly one inline run,
 * so its blocks are that one string (an array of one string converts to that string).
 */
const inlineRun: (blocks: string[]) => string = String;

/** A list's items in the text: each under its marker, with its other lines indented to match. */
function listItems(marker: (index: number) => string): (items: string[]) => string {
    return items => items.map((item, index) => {
        const mark = marker(index);
        return prefixLines(item, mark, ' '.repeat(mark.length));
    }).join('\n');
}

/** A heading in the text: h1 and h2 underlined, one mark per code point. */
function headingText(level: number): (blocks: string[]) => string {
    return (blocks) => {
        const title = inlineRun(blocks);
        const mark = UNDERLINES[level - 1];
        return mark === undefined ? title : `${title}\n${Array.from(title, () => mark).join('')}`;
    };
}

/** What an opening token contributes: its HTML open and close tags, and how its children's text blocks become its own text. */
interface Opening {
    open:   string
    close:  string
    finish: (blocks: string[]) => string
}

function opening(token: MarkdownToken): Opening {
    switch(token.type) {
        case 'paragraph_open': {
            return { open: `<p style="${STYLE.paragraph}">`, close: '</p>\n', finish: inlineRun };
        }
        case 'heading_open': {
            const level = Number(token.tag.slice(1));
            return { open: `<${token.tag} style="font-size:${HEADING_SIZES[level - 1] ?? '1em'};font-weight:bold;margin:1em 0 .4em;line-height:1.25">`, close: `</${token.tag}>\n`, finish: headingText(level) };
        }
        case 'blockquote_open': {
            return { open: `<div style="${STYLE.quote}">\n`, close: '</div>\n', finish: blocks => prefixLines(blocks.join('\n\n'), '> ', '> ') };
        }
        case 'bullet_list_open': {
            return { open: `<ul style="${STYLE.list}">\n`, close: '</ul>\n', finish: listItems(() => '- ') };
        }
        case 'ordered_list_open': {
            const start = Number(token.attrGet('start') ?? 1);
            return { open: `<ol start="${start}" style="${STYLE.list}">\n`, close: '</ol>\n', finish: listItems(index => `${start + index}. `) };
        }
        case 'list_item_open': {
            return { open: `<li style="${STYLE.item}">`, close: '</li>\n', finish: joinWith('\n') };
        }
        case 'table_open': {
            return { open: `<table style="${STYLE.table}">\n`, close: '</table>\n', finish: joinWith('\n') };
        }
        case 'tr_open': {
            return { open: '<tr>\n', close: '</tr>\n', finish: joinWith(' | ') };
        }
        case 'th_open':
        case 'td_open': {
            const align = String(token.attrGet('style') ?? 'text-align:left');
            return { open: `<${token.tag} style="${align};${token.tag === 'th' ? STYLE.th : STYLE.td}">`, close: `</${token.tag}>\n`, finish: inlineRun };
        }
        default: {
            // thead and tbody: rows only.
            return { open: '', close: '', finish: joinWith('\n') };
        }
    }
}

/** A token with no children in the block stream: an inline run, a rule, or a code block; spent as it is rendered. */
function leaf(token: MarkdownToken, budget: Budget): Rendered {
    switch(token.type) {
        case 'inline': {
            return renderInline(token.children!, budget);
        }
        case 'hr': {
            return spent(budget, { text: HR_TEXT, html: `<hr style="${STYLE.hr}">\n` });
        }
        default: {
            // fence and code_block: verbatim, without trailing blank lines.
            const code = token.content.trimEnd();
            return spent(budget, { text: code, html: `<pre style="${STYLE.pre}"><code style="${STYLE.preCode}">${escapeHtml(code)}</code></pre>\n` });
        }
    }
}

/** A container being rendered: its children's text blocks so far and their total length, how they become its own text, and its HTML close tag. */
interface Frame {
    blocks: string[]
    length: number
    finish: (blocks: string[]) => string
    close:  string
}

/**
 * The whole token stream in both parts: the top-level blocks separated by blank lines in the
 * text. A tight list's hidden paragraphs add no HTML tags. Every HTML tag, and the text a
 * container adds around its children (markers, `> ` prefixes, separators), is spent as it is
 * made; the walk stops at the first token that passes a limit, with that part.
 */
function renderTokens(tokens: readonly MarkdownToken[], budget: Budget): Rendered | 'text' | 'html' {
    const html: string[] = [];
    const root: string[] = [];
    /** The open containers, innermost last. */
    const frames: Frame[] = [];
    const pushText = (text: string): void => {
        const innermost = frames.at(-1);
        if(innermost === undefined) {
            root.push(text);
            return;
        }
        innermost.blocks.push(text);
        innermost.length += text.length;
    };
    const pushHtml = (tag: string): void => {
        html.push(tag);
        spend(budget, 0, tag.length);
    };
    for(const token of tokens) {
        if(token.nesting === 1) {
            const { open, close, finish } = opening(token);
            pushHtml(token.hidden ? '' : open);
            frames.push({ blocks: [], length: 0, finish, close: token.hidden ? '' : close });
        } else if(token.nesting === -1) {
            const frame = frames.pop()!;
            const text = frame.finish(frame.blocks);
            spend(budget, text.length - frame.length, frame.close.length);
            pushText(text);
            html.push(frame.close);
        } else {
            const piece = leaf(token, budget);
            pushText(piece.text);
            html.push(piece.html);
        }
        const over = passed(budget);
        if(over !== undefined) {
            return over;
        }
    }
    return { text: root.join('\n\n'), html: html.join('').trimEnd() };
}

/** The refusal for each rendered part over its limit. */
const SIZE_PROBLEMS: Readonly<Record<'text' | 'html', (limits: MarkdownLimits) => string>> = {
    text: limits => `the markdown body's plain-text version would be larger than ${formatAttachmentSize(limits.textBytes)}`,
    html: limits => `the markdown body's HTML version would be larger than ${formatAttachmentSize(limits.htmlBytes)}`,
};

function sizeProblem(part: 'text' | 'html', limits: MarkdownLimits): MarkdownBodyProblem {
    return { problem: SIZE_PROBLEMS[part](limits) };
}

/**
 * Render a markdown body into its text and HTML parts from one parse. Refused — nothing to upload
 * — when the markdown is over `limits.sourceBytes` (checked before parsing), nests lists or quotes
 * deeper than markdown-it's nesting limit, or renders more than `limits.textBytes` of text or
 * `limits.htmlBytes` of HTML — found while rendering, so a body far over a limit (a long reference
 * link repeated, say) is refused without being built.
 */
export function renderMarkdownBody(source: string, limits: MarkdownLimits = MARKDOWN_LIMITS): Required<ComposedEmailBody> | MarkdownBodyProblem {
    if(Buffer.byteLength(source, 'utf8') > limits.sourceBytes) {
        return { problem: `the markdown body is larger than ${formatAttachmentSize(limits.sourceBytes)}` };
    }
    const env: RenderEnv = {};
    const rendered = renderTokens(markdown.parse(source, env), { limits, text: 0, html: -1 });
    if(env.tooDeep === true) {
        return { problem: NESTING_PROBLEM };
    }
    if(typeof rendered === 'string') {
        return sizeProblem(rendered, limits);
    }
    if(Buffer.byteLength(rendered.text, 'utf8') > limits.textBytes) {
        return sizeProblem('text', limits);
    }
    if(Buffer.byteLength(rendered.html, 'utf8') > limits.htmlBytes) {
        return sizeProblem('html', limits);
    }
    return rendered;
}

/**
 * An outbound body as uploaded. A plain-text body (`format` `'text'` or omitted) is exactly the
 * body, with no HTML. A markdown body is its rendered text and HTML ({@link renderMarkdownBody}),
 * or text only when it renders no HTML, or the renderer's refusal.
 */
export function composeEmailBody(body: string, format: EmailBodyFormat | undefined): ComposedEmailBody | MarkdownBodyProblem {
    if(format !== 'markdown') {
        return { text: body };
    }
    const rendered = renderMarkdownBody(body);
    if('problem' in rendered) {
        return rendered;
    }
    return rendered.html === '' ? { text: rendered.text } : rendered;
}

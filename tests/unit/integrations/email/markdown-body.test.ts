import { afterEach, describe, expect, jest, spyOn, test } from 'bun:test';
import { DomUtils, parseDocument } from 'htmlparser2';
import MarkdownItConstructor, { type MarkdownIt, type Token } from 'markdown-it';
import {
    composeEmailBody,
    MARKDOWN_LIMITS,
    renderMarkdownBody,
    type MarkdownLimits
} from '../../../../src/integrations/email/markdown-body';

// The inline styles the renderer emits, written out in full so every style string is pinned.
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const P = '<p style="margin:0 0 1em">';
const UL = '<ul style="margin:0 0 1em;padding-left:2em">';
const LI = '<li style="margin:0 0 .25em">';
const QUOTE = '<div style="margin:0 0 1em .8ex;border-left:2px solid #c0c0c0;padding-left:1ex">';
const CODE = `<code style="font-family:${MONO};font-size:.9em;background:rgba(127,127,127,0.15);padding:.1em .35em;border-radius:4px">`;
const PRE = `<pre style="margin:0 0 1em;padding:12px;border-radius:6px;background:rgba(127,127,127,0.15);font-family:${MONO};font-size:.9em;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word"><code style="font-family:inherit;font-size:1em">`;
const HR = '<hr style="border:0;border-top:1px solid #d0d7de;margin:1em 0">';
const TABLE = '<table style="border-collapse:collapse;width:auto;margin:0 0 1em">';
const TH = 'padding:6px 12px;font-weight:bold;vertical-align:bottom;border-bottom:2px solid #8c959f';
const TD = 'padding:6px 12px;vertical-align:top;border-bottom:1px solid #d0d7de';
const HEADING = (size: string): string => `style="font-size:${size};font-weight:bold;margin:1em 0 .4em;line-height:1.25"`;
const HR_TEXT = '-'.repeat(40);

/** The rendered parts, failing the test when the renderer refused. */
function render(markdown: string, limits?: MarkdownLimits): { text: string, html: string } {
    const out = renderMarkdownBody(markdown, limits);
    if('problem' in out) {
        throw new TypeError(`refused: ${out.problem}`);
    }
    return out;
}

const text = (markdown: string): string => render(markdown).text;
const html = (markdown: string): string => render(markdown).html;

/** Letter-and-digit words, in order. */
function words(value: string): string[] {
    return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * The words of the HTML's visible text that the text part does not show, in order: each HTML word
 * must appear in the text part after the one before it. Empty when the text shows them all.
 */
function wordsMissingFromText(rendered: { text: string, html: string }): string[] {
    const textWords = words(rendered.text);
    let from = 0;
    return words(DomUtils.textContent(parseDocument(rendered.html))).filter((word) => {
        const found = textWords.indexOf(word, from);
        if(found === -1) {
            return true;
        }
        from = found + 1;
        return false;
    });
}

/**
 * What the text part must show for each link in the HTML: its label and its `href` verbatim, in
 * brackets, or the label alone when it is exactly the `href`, or the address of a `mailto:` + that
 * label.
 */
function linkTargets(rendered: string): string[] {
    return DomUtils.findAll(element => element.name === 'a', parseDocument(rendered).children).map((element) => {
        const href = String(element.attribs.href);
        const label = DomUtils.textContent(element);
        return label === href || (href === `mailto:${label}` && /^[\w.+-]+@[\w.-]+$/u.test(label)) ? label : `${label} [${href}]`;
    });
}

/** The tokens a render's walk took, and how many the parse made (inline children included). */
interface Walk {
    out:     ReturnType<typeof renderMarkdownBody>
    visited: number
    total:   number
}

const parse = MarkdownItConstructor.prototype.parse;

/** Render with every token array the parse makes counting the tokens the walk takes from it. */
function walk(markdown: string, limits: MarkdownLimits): Walk {
    const counts = { visited: 0, total: 0 };
    const counting = (tokens: Token[]): Token[] => {
        for(const token of tokens) {
            counts.total += 1;
            if(token.children !== null) {
                counting(token.children);
            }
        }
        Object.defineProperty(tokens, Symbol.iterator, {
            value: function* visit(): Generator<Token> {
                for(const token of tokens.values()) {
                    counts.visited += 1;
                    yield token;
                }
            },
        });
        return tokens;
    };
    spyOn(MarkdownItConstructor.prototype, 'parse').mockImplementation(function counted(this: MarkdownIt, source, env) {
        return counting(parse.call(this, source, env));
    });
    return { out: renderMarkdownBody(markdown, limits), ...counts };
}

/** Every element name and attribute name in the HTML. */
function markup(rendered: string): { elements: Set<string>, attributes: Set<string> } {
    const elements = DomUtils.findAll(() => true, parseDocument(rendered).children);
    return { elements: new Set(elements.map(element => element.name)), attributes: new Set(elements.flatMap(element => Object.keys(element.attribs))) };
}

describe('renderMarkdownBody', () => {
    describe('paragraphs, emphasis and breaks', () => {
        test('emphasis and strong drop their markers from the text and become <em> and <strong>', () => {
            expect(render('Hi **bold** and *it*, __b2__ _i2_.')).toEqual({
                text: 'Hi bold and it, b2 i2.',
                html: `${P}Hi <strong>bold</strong> and <em>it</em>, <strong>b2</strong> <em>i2</em>.</p>`,
            });
        });

        test('a single newline is a line break and a blank line starts a new paragraph', () => {
            expect(render('Thanks,\nCraig\n\nPS: more')).toEqual({
                text: 'Thanks,\nCraig\n\nPS: more',
                html: `${P}Thanks,<br>\nCraig</p>\n${P}PS: more</p>`,
            });
        });

        test('a hard break (two trailing spaces) is a line break too', () => {
            expect(render('line  \nbreak')).toEqual({ text: 'line\nbreak', html: `${P}line<br>\nbreak</p>` });
        });

        test('CRLF and CR line endings become LF', () => {
            expect(render('a\r\nb\r\n\r\nc\rd')).toEqual({ text: 'a\nb\n\nc\nd', html: `${P}a<br>\nb</p>\n${P}c<br>\nd</p>` });
        });

        test('entities decode once in the text and are escaped once in the HTML', () => {
            expect(render('Tom &amp; Jerry &lt;3 &copy; "q" it\'s &#x41; &amp;amp; &bogus;')).toEqual({
                text: 'Tom & Jerry <3 © "q" it\'s A &amp; &bogus;',
                html: `${P}Tom &amp; Jerry &lt;3 © &quot;q&quot; it&#39;s A &amp;amp; &amp;bogus;</p>`,
            });
        });

        test('strikethrough is not a construct: tildes stay literal', () => {
            expect(render('~~gone~~')).toEqual({ text: '~~gone~~', html: `${P}~~gone~~</p>` });
        });

        test('empty or whitespace-only markdown, or only link definitions, renders to nothing', () => {
            expect(render('')).toEqual({ text: '', html: '' });
            expect(render('  \n\n \n')).toEqual({ text: '', html: '' });
            expect(render('[a]: https://example.com')).toEqual({ text: '', html: '' });
        });

        test('the same input twice gives the same output', () => {
            const sample = '# T\n\n- a\n- b\n\n| x |\n|---|\n| y |';
            expect(render(sample)).toEqual(render(sample));
        });
    });

    describe('headings', () => {
        test('levels 1 to 3 get modest sizes and the rest the body size; h1 and h2 are underlined in the text', () => {
            expect(render('# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six')).toEqual({
                text: 'One\n===\n\nTwo\n---\n\nThree\n\nFour\n\nSix',
                html: [
                    `<h1 ${HEADING('1.4em')}>One</h1>`,
                    `<h2 ${HEADING('1.2em')}>Two</h2>`,
                    `<h3 ${HEADING('1.1em')}>Three</h3>`,
                    `<h4 ${HEADING('1em')}>Four</h4>`,
                    `<h6 ${HEADING('1em')}>Six</h6>`,
                ].join('\n'),
            });
        });

        test('an underline is one mark per code point of the heading', () => {
            expect(text('# 🎉 Hi')).toBe('🎉 Hi\n====');
            expect(text('## Ünï')).toBe('Ünï\n---');
        });

        test('a heading keeps its inline formatting in the HTML only', () => {
            expect(render('# A *b* `c`')).toEqual({ text: 'A b c\n=====', html: `<h1 ${HEADING('1.4em')}>A <em>b</em> ${CODE}c</code></h1>` });
        });

        test('a setext underline is not a heading: "--" under a sign-off stays literal and "---" is a rule', () => {
            expect(text('Regards\n--\nIzzy')).toBe('Regards\n--\nIzzy');
            expect(render('Title\n===')).toEqual({ text: 'Title\n===', html: `${P}Title<br>\n===</p>` });
            expect(render('Title\n---')).toEqual({ text: `Title\n\n${HR_TEXT}`, html: `${P}Title</p>\n${HR}` });
        });
    });

    describe('lists', () => {
        test('bullet, ordered and nested lists keep their structure and markers', () => {
            expect(render('- a\n- b\n  - c\n\n1. x\n2. y')).toEqual({
                text: '- a\n- b\n  - c\n\n1. x\n2. y',
                html: [
                    UL,
                    `${LI}a</li>`,
                    `${LI}b${UL}`,
                    `${LI}c</li>`,
                    '</ul>',
                    '</li>',
                    '</ul>',
                    '<ol start="1" style="margin:0 0 1em;padding-left:2em">',
                    `${LI}x</li>`,
                    `${LI}y</li>`,
                    '</ol>',
                ].join('\n'),
            });
        });

        test('an ordered list keeps its start number and counts on from it', () => {
            expect(render('3. a\n7. b')).toEqual({
                text: '3. a\n4. b',
                html: `<ol start="3" style="margin:0 0 1em;padding-left:2em">\n${LI}a</li>\n${LI}b</li>\n</ol>`,
            });
        });

        test('a continuation line is indented under the item text, by the width of its marker', () => {
            expect(text('10. a\n    b\n- c\n  d')).toBe('10. a\n    b\n\n- c\n  d');
        });

        test('a loose list wraps each item in a paragraph in the HTML; the text is the same as a tight one', () => {
            expect(render('- a\n\n- b')).toEqual({
                text: '- a\n- b',
                html: `${UL}\n${LI}${P}a</p>\n</li>\n${LI}${P}b</p>\n</li>\n</ul>`,
            });
        });

        test('a code block in a list item is indented with it; its blank line stays empty', () => {
            expect(text('- item\n\n  ```\n  x\n\n  y\n  ```')).toBe('- item\n  x\n\n  y');
        });
    });

    describe('block quotes', () => {
        test('quotes are styled divs in the HTML and "> " lines in the text, and nest', () => {
            expect(render('> outer\n>\n> > inner')).toEqual({
                text: '> outer\n>\n> > inner',
                html: `${QUOTE}\n${P}outer</p>\n${QUOTE}\n${P}inner</p>\n</div>\n</div>`,
            });
        });

        test('content after a quote keeps its place', () => {
            expect(text('> q\n\nafter')).toBe('> q\n\nafter');
        });
    });

    describe('code', () => {
        test('a code span is monospace in the HTML and plain in the text', () => {
            expect(render('Run `a < b` now')).toEqual({ text: 'Run a < b now', html: `${P}Run ${CODE}a &lt; b</code> now</p>` });
        });

        test('a fenced block ignores its language, keeps its content verbatim and drops trailing blank lines', () => {
            expect(render('```js\nconst a = 1 < 2;\n  indented\n\n\n```')).toEqual({
                text: 'const a = 1 < 2;\n  indented',
                html: `${PRE}const a = 1 &lt; 2;\n  indented</code></pre>`,
            });
        });

        test('a fenced block keeps its leading spaces', () => {
            expect(text('```\n  a  b\n```')).toBe('  a  b');
        });

        test('an indented block is code too', () => {
            expect(render('    indented\n    code')).toEqual({ text: 'indented\ncode', html: `${PRE}indented\ncode</code></pre>` });
        });
    });

    describe('tables', () => {
        test('a table is rows of " | "-separated cells in the text and a ruled table honouring alignment in the HTML', () => {
            expect(render('| Name | Qty | Note |\n|:-----|----:|:----:|\n| apple | 1 | x |\n| melon | 22 | |')).toEqual({
                text: 'Name | Qty | Note\napple | 1 | x\nmelon | 22 | ',
                html: [
                    TABLE,
                    '<tr>',
                    `<th style="text-align:left;${TH}">Name</th>`,
                    `<th style="text-align:right;${TH}">Qty</th>`,
                    `<th style="text-align:center;${TH}">Note</th>`,
                    '</tr>',
                    '<tr>',
                    `<td style="text-align:left;${TD}">apple</td>`,
                    `<td style="text-align:right;${TD}">1</td>`,
                    `<td style="text-align:center;${TD}">x</td>`,
                    '</tr>',
                    '<tr>',
                    `<td style="text-align:left;${TD}">melon</td>`,
                    `<td style="text-align:right;${TD}">22</td>`,
                    `<td style="text-align:center;${TD}"></td>`,
                    '</tr>',
                    '</table>',
                ].join('\n'),
            });
        });

        test('an unaligned column is left-aligned, and a header-only table is just its header row', () => {
            expect(render('| a | b |\n|---|---|')).toEqual({
                text: 'a | b',
                html: `${TABLE}\n<tr>\n<th style="text-align:left;${TH}">a</th>\n<th style="text-align:left;${TH}">b</th>\n</tr>\n</table>`,
            });
        });

        test('cell text cannot break out of its cell or the table', () => {
            const out = render('| a |\n|---|\n| </td></table><script>alert(1)</script> |');
            expect(out.text).toBe('a\n</td></table><script>alert(1)</script>');
            expect(out.html).toContain(`<td style="text-align:left;${TD}">&lt;/td&gt;&lt;/table&gt;&lt;script&gt;alert(1)&lt;/script&gt;</td>`);
            expect(markup(out.html).elements).toEqual(new Set(['table', 'tr', 'th', 'td']));
        });
    });

    describe('rules', () => {
        test('a horizontal rule is a light line in the HTML and a row of dashes in the text', () => {
            expect(render('a\n\n---\n\nb')).toEqual({ text: `a\n\n${HR_TEXT}\n\nb`, html: `${P}a</p>\n${HR}\n${P}b</p>` });
        });
    });

    describe('links', () => {
        test('a link reads "label [url]" in the text', () => {
            expect(render('see [the docs](https://example.com/a?b=1&c=2)')).toEqual({
                text: 'see the docs [https://example.com/a?b=1&c=2]',
                html: `${P}see <a href="https://example.com/a?b=1&amp;c=2">the docs</a></p>`,
            });
        });

        test('a reference-style link is a link too', () => {
            expect(render('[docs][d]\n\n[d]: https://example.com/d')).toEqual({ text: 'docs [https://example.com/d]', html: `${P}<a href="https://example.com/d">docs</a></p>` });
        });

        test('an autolink, a bare scheme URL and an http URL whose label is the URL show it once', () => {
            expect(render('<https://example.com/bare> and https://example.com/x. and [http://example.com/h](http://example.com/h)')).toEqual({
                text: 'https://example.com/bare and https://example.com/x. and http://example.com/h',
                html: `${P}<a href="https://example.com/bare">https://example.com/bare</a> and <a href="https://example.com/x">https://example.com/x</a>. and <a href="http://example.com/h">http://example.com/h</a></p>`,
            });
        });

        test('a mailto: link shows its whole destination in brackets, and its address once when that is its label', () => {
            expect(render('[mail me](mailto:me@example.com), <a@example.com>, [a@example.com](mailto:a@example.com) and mailto:q@example.com')).toEqual({
                text: 'mail me [mailto:me@example.com], a@example.com, a@example.com and mailto:q@example.com',
                html: `${P}<a href="mailto:me@example.com">mail me</a>, <a href="mailto:a@example.com">a@example.com</a>, <a href="mailto:a@example.com">a@example.com</a> and <a href="mailto:q@example.com">mailto:q@example.com</a></p>`,
            });
        });

        test('a label that looks like a web address does not hide a mailto: destination', () => {
            expect(render('[https://example.org](mailto:https://example.org)')).toEqual({
                text: 'https://example.org [mailto:https://example.org]',
                html: `${P}https://example.org [mailto:https://example.org]</p>`,
            });
        });

        test('a label that is a different URL shows both, label first', () => {
            expect(render('[https://bank.example](https://evil.example)')).toEqual({
                text: 'https://bank.example [https://evil.example]',
                html: `${P}<a href="https://evil.example">https://bank.example</a></p>`,
            });
        });

        test('the address shows once only for exactly mailto: + the label', () => {
            expect(render('[a@example.com](MAILTO:a@example.com) [a@example.com](mailto:b@example.com)')).toEqual({
                text: 'a@example.com [MAILTO:a@example.com] a@example.com [mailto:b@example.com]',
                html: `${P}<a href="MAILTO:a@example.com">a@example.com</a> <a href="mailto:b@example.com">a@example.com</a></p>`,
            });
        });

        test('a destination containing mailto: later is shown whole', () => {
            expect(text('[x](https://example.com/?to=mailto:y)')).toBe('x [https://example.com/?to=mailto:y]');
        });

        test('an empty or blank label shows the destination as the label', () => {
            expect(render('[](https://example.com/e) [ ](mailto:b@example.com)')).toEqual({
                text: 'https://example.com/e mailto:b@example.com',
                html: `${P}<a href="https://example.com/e">https://example.com/e</a> <a href="mailto:b@example.com">mailto:b@example.com</a></p>`,
            });
        });

        test.each([
            ['a scheme with no //', '[Read](https:report)', 'Read [https:report]'],
            ['a scheme with one /', '[Read](http:/report)', 'Read [http:/report]'],
            ['a backslash for //', String.raw`[Read](https:\\evil.example)`, 'Read [https:%5Cevil.example]'],
            ['a protocol-relative URL', '[Read](//cdn.example/x)', 'Read [//cdn.example/x]'],
            ['a scheme with no host', '[Read](https://)', 'Read [https://]'],
            ['a scheme before http', '[Read](xhttps://evil.example)', 'Read [xhttps://evil.example]'],
            ['a user and password', '[Read](https://user:pass@evil.example)', 'Read [https://user:pass@evil.example]'],
            ['a user', '[Read](https://bank.example@evil.example)', 'Read [https://bank.example@evil.example]'],
            ['a password only', '[Read](https://:pass@evil.example)', 'Read [https://:pass@evil.example]'],
            ['an escaped backslash before a user', '[Read](https://bank.example%5C@evil.example)', 'Read [https://bank.example%5C@evil.example]'],
        ])('an http(s) destination that is not an absolute URL with a host and no user (%s) is plain text', (_label, markdown, shown) => {
            expect(render(markdown)).toEqual({ text: shown, html: `${P}${shown}</p>` });
        });

        test('a bare URL with a user links only up to the @, and the text shows all of it', () => {
            expect(render('see https://bank.example@evil.example/x')).toEqual({
                text: 'see https://bank.example@evil.example/x',
                html: `${P}see <a href="https://bank.example">https://bank.example</a>@evil.example/x</p>`,
            });
        });

        test('an http(s) destination in any scheme case, with or without a path, is a link shown verbatim', () => {
            expect(render('[x](HTTPS://Example.org/x) [y](Http://Example.org) [z](https:///z.example)')).toEqual({
                text: 'x [HTTPS://Example.org/x] y [Http://Example.org] z [https:///z.example]',
                html: `${P}<a href="HTTPS://Example.org/x">x</a> <a href="Http://Example.org">y</a> <a href="https:///z.example">z</a></p>`,
            });
        });

        test('a host in another script is linked and shown by its punycode name', () => {
            expect(render('[a](https://bücher.example) https://bücher.example')).toEqual({
                text: 'a [https://xn--bcher-kva.example] https://bücher.example [https://xn--bcher-kva.example]',
                html: `${P}<a href="https://xn--bcher-kva.example">a</a> <a href="https://xn--bcher-kva.example">https://bücher.example</a></p>`,
            });
        });

        test.each([
            ['dots', 'mailto:a.b@example.com'],
            ['a plus', 'mailto:a+b@example.com'],
            ['hyphens and digits', 'mailto:a-b_9@my-h0st.co-0p'],
            ['several domain labels', 'mailto:a@mail.example.com'],
            ['capitals', 'MAILTO:Ann@Example.COM'],
        ])('a mailto: of one plain address (%s) is a link', (_label, href) => {
            expect(render(`[Ann](${href})`)).toEqual({ text: `Ann [${href}]`, html: `${P}<a href="${href}">Ann</a></p>` });
        });

        test.each([
            ['a query', 'mailto:ann@example.com?subject=hi'],
            ['two recipients', 'mailto:ann@example.com,bob@example.com'],
            ['a percent encoding', 'mailto:ann%40x@example.com'],
            ['no local part', 'mailto:@@example.com'],
            ['no domain', 'mailto:ann@'],
            ['a domain without a dot', 'mailto:ann@localhost'],
            ['an empty domain label', 'mailto:ann@example..com'],
            ['no address', 'mailto:'],
            ['a scheme before mailto', 'xmailto:ann@example.com'],
            ['a second @', 'mailto:ann@b@example.com'],
        ])('a mailto: that is not one plain address (%s) is plain text', (_label, href) => {
            expect(render(`[Ann](${href})`)).toEqual({ text: `Ann [${href}]`, html: `${P}Ann [${href}]</p>` });
        });

        test('a destination of 2048 characters can be a link; one of 2049 is plain text', () => {
            const url = (length: number): string => `https://example.com/${'a'.repeat(length - 20)}`;
            expect(url(2048)).toHaveLength(2048);
            expect(render(`[x](${url(2048)})`)).toEqual({ text: `x [${url(2048)}]`, html: `${P}<a href="${url(2048)}">x</a></p>` });
            expect(render(`[x](${url(2049)})`)).toEqual({ text: `x [${url(2049)}]`, html: `${P}x [${url(2049)}]</p>` });
            expect(render(`[x](mailto:${'a'.repeat(2048 - 19)}@example.com)`).html).toContain('<a href="mailto:');
            expect(render(`[x](mailto:${'a'.repeat(2049 - 19)}@example.com)`).html).not.toContain('<a ');
        });

        test('markdown in a label is formatted in the HTML and plain in the text', () => {
            expect(render('[**bold** `code`](https://example.com)')).toEqual({
                text: 'bold code [https://example.com]',
                html: `${P}<a href="https://example.com"><strong>bold</strong> ${CODE}code</code></a></p>`,
            });
        });

        test('a link\'s title is not rendered', () => {
            expect(html('[x](https://example.com "Title")')).toBe(`${P}<a href="https://example.com">x</a></p>`);
        });

        test('only http:, https: and mailto: become links, in any case', () => {
            expect(html('[x](HTTPS://example.com/U)')).toBe(`${P}<a href="HTTPS://example.com/U">x</a></p>`);
        });

        test.each([
            ['an ftp: link', '[z](ftp://files.example.com/a)', 'z [ftp://files.example.com/a]'],
            ['a relative link', '[w](/rel)', 'w [/rel]'],
            ['a fragment link', '[f](#top)', 'f [#top]'],
            ['a scheme with https: later in it', '[x](ftp://host/https://y)', 'x [ftp://host/https://y]'],
            ['a data: image link', '[x](data:image/png;base64,AAAA)', 'x [data:image/png;base64,AAAA]'],
            ['a tab inside the scheme', '[x](<java\tscript:alert(1)>)', 'x [java%09script:alert(1)]'],
            ['a zero-width space before the scheme', '[x](​javascript:alert(1))', 'x [%E2%80%8Bjavascript:alert(1)]'],
            ['an ftp: autolink, shown once', '<ftp://files.example.com/a>', 'ftp://files.example.com/a'],
        ])('%s renders as plain text showing its label and URL', (_label, markdown, shown) => {
            expect(render(markdown)).toEqual({ text: shown, html: `${P}${shown.replaceAll('<', '&lt;')}</p>` });
        });

        test.each([
            ['[x](javascript:alert(1))', '[x](javascript:alert(1))'],
            ['[x](JAVASCRIPT:alert(1))', '[x](JAVASCRIPT:alert(1))'],
            ['[x](&#x6A;avascript:alert(1))', '[x](javascript:alert(1))'],
            ['[x](javascript&#58;alert(1))', '[x](javascript:alert(1))'],
            ['[x](vbscript:msgbox)', '[x](vbscript:msgbox)'],
            ['[x](data:text/html,<script>alert(1)</script>)', '[x](data:text/html,<script>alert(1)</script>)'],
            ['![x](javascript:alert(1))', '![x](javascript:alert(1))'],
            ['<javascript:alert(1)>', '<javascript:alert(1)>'],
            ['[x][a]\n\n[a]: javascript:alert(1)', '[x][a]\n\n[a]: javascript:alert(1)'],
        ])('%j is never a link: its source shows as text', (markdown, shown) => {
            const out = render(markdown);
            expect(out.text).toBe(shown);
            expect(out.html).not.toMatch(/<a |href=|<script/iu);
            expect(words(DomUtils.textContent(parseDocument(out.html)))).toEqual(words(shown));
        });

        test('only scheme URLs are linked automatically: bare domains, emails, ftp: and scheme-relative URLs stay text', () => {
            const source = 'example.com, a@example.com, ftp://f.example/x, //cdn.example/x and www.example.com';
            expect(render(source)).toEqual({ text: source, html: `${P}${source}</p>` });
        });

        // A bare ftp: or // URL that linkify still recognised would reach the walk as a link whose
        // label (percent-decoded or IDN for display) differs from its href (encoded), so the walk would
        // add the href in brackets; text with the same characters as the source is the only proof it was not.
        test.each([
            ['an ftp: URL', 'ftp://f.example/a%20b'],
            ['a scheme-relative URL', '//cdn.example/é'],
        ])('%s with an encoded or non-ASCII path is not auto-linked, so nothing is added after it', (_label, source) => {
            expect(render(source)).toEqual({ text: source, html: `${P}${source}</p>` });
        });
    });

    describe('images', () => {
        test('an image is never embedded: its alt text links to its URL in both parts', () => {
            expect(render('![Logo *x*](https://example.com/l.png "t")')).toEqual({
                text: 'Logo x [https://example.com/l.png]',
                html: `${P}<a href="https://example.com/l.png">Logo x</a></p>`,
            });
        });

        test('an image without alt text shows its URL once', () => {
            expect(text('![](https://example.com/p.png)')).toBe('https://example.com/p.png');
        });

        test('an image whose URL is not http:, https: or mailto: is plain text', () => {
            expect(render('![i](data:image/png;base64,AAAA) ![c](cid:logo)')).toEqual({
                text: 'i [data:image/png;base64,AAAA] c [cid:logo]',
                html: `${P}i [data:image/png;base64,AAAA] c [cid:logo]</p>`,
            });
        });

        test('an image URL follows the link rules: no host, a user, or a mailto: query is plain text', () => {
            expect(render('![i](https:img.png) ![u](https://u@img.example/i.png) ![m](mailto:a@example.com?x) ![](mailto:a@example.com)')).toEqual({
                text: 'i [https:img.png] u [https://u@img.example/i.png] m [mailto:a@example.com?x] mailto:a@example.com',
                html: `${P}i [https:img.png] u [https://u@img.example/i.png] m [mailto:a@example.com?x] <a href="mailto:a@example.com">mailto:a@example.com</a></p>`,
            });
        });

        test('an image after a link in the same paragraph is a link of its own', () => {
            expect(html('[a](https://a.example) ![i](https://i.example/i.png)')).toBe(`${P}<a href="https://a.example">a</a> <a href="https://i.example/i.png">i</a></p>`);
        });

        test('an image inside a link is the link\'s label, with its URL as text, never a nested link', () => {
            expect(render('[![logo](https://img.example/l.png)](https://site.example)')).toEqual({
                text: 'logo [https://img.example/l.png] [https://site.example]',
                html: `${P}<a href="https://site.example">logo [https://img.example/l.png]</a></p>`,
            });
        });
    });

    describe('raw HTML is literal text', () => {
        test.each([
            '<script>alert(1)</script>',
            '<img src=x onerror=alert(1)>',
            '<a href="javascript:alert(1)">x</a>',
            '<b>bold</b> and <!-- comment -->',
            '<div>\nblock\n</div>',
        ])('%j is shown, never interpreted', (source) => {
            const out = render(source);
            expect(out.text).toBe(source);
            expect(DomUtils.textContent(parseDocument(out.html))).toBe(source);
            expect(markup(out.html)).toEqual({ elements: new Set(['p', 'br'].filter(name => name === 'p' || source.includes('\n'))), attributes: new Set(['style']) });
        });

        test('special characters are escaped', () => {
            expect(html('Tom & Jerry <3 "q" it\'s')).toBe(`${P}Tom &amp; Jerry &lt;3 &quot;q&quot; it&#39;s</p>`);
        });
    });

    describe('the HTML is a conservative fragment', () => {
        test('every construct together uses only these elements and the style, href and start attributes', () => {
            const out = render('# H\n\n- a\n\n1. b\n\n> q\n\n| a |\n|---|\n| b |\n\n```js\nx\n```\n\n`c` **s** *e* [l](https://example.com) ![i](https://example.com/i.png)  \nx\n\n---');
            expect(markup(out.html)).toEqual({
                elements:   new Set(['h1', 'ul', 'li', 'ol', 'div', 'p', 'table', 'tr', 'th', 'td', 'pre', 'code', 'strong', 'em', 'a', 'br', 'hr']),
                attributes: new Set(['style', 'start', 'href']),
            });
            expect(out.html).not.toMatch(/<(?:html|head|body|style|script|img|input|link|iframe)\b|class=|\son\w+=/iu);
        });
    });

    describe('text/HTML parity: every visible word and URL of the HTML is in the text', () => {
        test.each([
            ['paragraphs and emphasis', 'Hi **bold** and *it*.\n\nSecond, _here_.'],
            ['headings', '# One\n\n## Two\n\n### Three'],
            ['a labelled link followed by punctuation', 'see [the docs](https://example.com/docs).'],
            ['autolinks and bare URLs', '<https://example.com/a> https://example.com/b <a@example.com> mailto:q@example.com'],
            ['a deceptive label', '[https://good.example](https://evil.example)'],
            ['a mailto link', '[mail me](mailto:me@example.com)'],
            ['a mailto link labelled with its address', '[ann@example.com](mailto:ann@example.com)'],
            ['a mailto destination labelled as a web address', '[https://example.org](mailto:https://example.org)'],
            ['a capitalised scheme', '[x](HTTPS://Example.org/x)'],
            ['a blank label', '[ ](mailto:b@example.com) [](https://example.com/b)'],
            ['an unsafe link', '[z](ftp://files.example.com/a)'],
            ['an empty label', '[](https://example.com/e)'],
            ['markdown in a label', '[**bold** `code`](https://example.com)'],
            ['images', '![Logo](https://example.com/l.png) ![](https://example.com/p.png) ![c](cid:x)'],
            ['an image in a link', '[![logo](https://img.example/l.png)](https://site.example)'],
            ['lists', '- a\n- b\n  - c\n\n3. x\n4. y'],
            ['a loose list', '- a\n\n- b'],
            ['quotes', '> outer\n>\n> > inner'],
            ['code', 'Run `a < b`\n\n```\nx < y\n```\n\n    indented'],
            ['a table', '| Name | Qty |\n|:-|-:|\n| apple | 1 |\n| [l](https://example.com/t) | `c` |'],
            ['breaks and rules', 'line  \nbreak\nsoft\n\n---\n\nafter'],
            ['entities', 'Tom &amp; Jerry &copy; &#x41;'],
            ['raw HTML', '<script>alert(1)</script> <b>x</b>'],
        ])('%s', (_label, markdown) => {
            const out = render(markdown);
            expect(wordsMissingFromText(out)).toEqual([]);
            for(const target of linkTargets(out.html)) {
                expect(out.text).toContain(target);
            }
        });

        test('the parity check itself catches a word or URL missing from the text', () => {
            expect(wordsMissingFromText({ text: 'a c', html: '<p>a b c</p>' })).toEqual(['b']);
            expect(wordsMissingFromText({ text: 'b a', html: '<p>a b</p>' })).toEqual(['b']);
            expect(linkTargets('<a href="https://x.example">x</a><a href="mailto:m@x.example">m</a><a href="mailto:m@x.example">m@x.example</a><a href="mailto:https://x.example">https://x.example</a><a href="https://a.example/?a=1&amp;b=2">https://a.example/?a=1&amp;b=2</a>')).toEqual([
                'x [https://x.example]',
                'm [mailto:m@x.example]',
                'm@x.example',
                'https://x.example [mailto:https://x.example]',
                'https://a.example/?a=1&b=2',
            ]);
        });
    });

    describe('limits', () => {
        test('the limits are 64 KB of markdown, 90 KB of text and 500 KB of HTML', () => {
            expect(MARKDOWN_LIMITS).toEqual({ sourceBytes: 65_536, textBytes: 92_160, htmlBytes: 512_000 });
        });

        test('a 64 KB single line renders; one byte more is refused before it is parsed', () => {
            const line = 'a'.repeat(MARKDOWN_LIMITS.sourceBytes);
            expect(render(line)).toEqual({ text: line, html: `${P}${line}</p>` });
            expect(renderMarkdownBody(`${line}b`)).toEqual({ problem: 'the markdown body is larger than 64.0 KB' });
        });

        test('the markdown limit counts UTF-8 bytes', () => {
            const limits = { sourceBytes: 4, textBytes: 100, htmlBytes: 100 };
            expect(render('éé', limits).text).toBe('éé');
            expect(renderMarkdownBody('ééa', limits)).toEqual({ problem: 'the markdown body is larger than 4 B' });
        });

        test('text exactly at its limit renders; one byte more is refused', () => {
            const limits = { sourceBytes: 100, textBytes: 6, htmlBytes: 1000 };
            expect(render('# éa', limits).text).toBe('éa\n==');
            expect(renderMarkdownBody('# éab', limits)).toEqual({ problem: 'the markdown body\'s plain-text version would be larger than 6 B' });
        });

        test('text under its limit in characters but over it in UTF-8 bytes is refused once rendered', () => {
            expect(render('ééé', { sourceBytes: 100, textBytes: 6, htmlBytes: 1000 }).text).toBe('ééé');
            expect(renderMarkdownBody('ééé', { sourceBytes: 100, textBytes: 5, htmlBytes: 1000 })).toEqual({ problem: 'the markdown body\'s plain-text version would be larger than 5 B' });
        });

        test('HTML exactly at its limit renders; one byte more is refused', () => {
            // 26 bytes of <p> tag, 2 of é, 5 of &amp; and 4 of </p>.
            const limits = { sourceBytes: 100, textBytes: 100, htmlBytes: 37 };
            expect(render('é&', limits).html).toBe(`${P}é&amp;</p>`);
            expect(renderMarkdownBody('é&a', limits)).toEqual({ problem: 'the markdown body\'s HTML version would be larger than 37 B' });
        });

        describe('the walk stops at the first token that passes a limit, before building the rest', () => {
            afterEach(() => {
                jest.restoreAllMocks();
            });

            const TEXT_OVER = (bytes: number): { problem: string } => ({ problem: `the markdown body's plain-text version would be larger than ${bytes} B` });
            const HTML_OVER = (bytes: number): { problem: string } => ({ problem: `the markdown body's HTML version would be larger than ${bytes} B` });
            const LONG = `https://example.com/${'x'.repeat(100)}`;
            const ROOMY = { sourceBytes: 100_000, textBytes: 100_000, htmlBytes: 1_000_000 };

            test.each([
                ['a reference link repeated in one paragraph', `${'[a][r] '.repeat(200)}\n\n[r]: ${LONG}`, { ...ROOMY, textBytes: 1000 }, TEXT_OVER(1000)],
                ['a reference link with a blank label, repeated', `${'[ ][r] '.repeat(200)}\n\n[r]: ${LONG}`, { ...ROOMY, textBytes: 1000 }, TEXT_OVER(1000)],
                ['a reference image repeated in one link label', `[${'![a][r]'.repeat(60)}](https://x.example)\n\n[r]: ${LONG}`, { ...ROOMY, textBytes: 1000 }, TEXT_OVER(1000)],
                ['a reference image repeated in one alt text', `![${'![a][r]'.repeat(60)}](https://x.example)\n\n[r]: ${LONG}`, { ...ROOMY, textBytes: 1000 }, TEXT_OVER(1000)],
                ['many short paragraphs', 'x\n\n'.repeat(300), { ...ROOMY, textBytes: 10 }, TEXT_OVER(10)],
                ['many rules', '---\n\n'.repeat(300), { ...ROOMY, textBytes: 100 }, TEXT_OVER(100)],
                ['many code blocks', '```\nx\n```\n\n'.repeat(300), { ...ROOMY, htmlBytes: 1000 }, HTML_OVER(1000)],
                // The text spent inside the quotes is 21 letters; the innermost quote's "> " prefixes take it past 60.
                ['lazy lines in nested quotes', `> > > > > a\n${'b\n'.repeat(20)}\n${'after\n\n'.repeat(100)}`, { ...ROOMY, textBytes: 60 }, TEXT_OVER(60)],
                ['code spans repeated in one paragraph', '`c` '.repeat(300), { ...ROOMY, htmlBytes: 1000 }, HTML_OVER(1000)],
                ['a wide table header over one-cell rows', `|${'a|'.repeat(20)}\n|${'-|'.repeat(20)}\n${'b\n'.repeat(30)}`, { ...ROOMY, htmlBytes: 1000 }, HTML_OVER(1000)],
            ])('%s', (_label, markdown, limits, problem) => {
                const { out, visited, total } = walk(markdown, limits);
                expect(out).toEqual(problem);
                expect(visited).toBeLessThan(total / 4);
            });

            test.each([
                // paragraph_open, inline and its one text child: "aaa" is 3 bytes of text.
                ['text, in the inline run', 'aaa', { sourceBytes: 1000, textBytes: 2, htmlBytes: 1000 }, TEXT_OVER(2), 3],
                // ...and paragraph_close: 26 + 3 + 5 bytes of HTML, less the trailing newline, is 33.
                ['HTML, at the paragraph close', 'aaa', { sourceBytes: 1000, textBytes: 1000, htmlBytes: 32 }, HTML_OVER(32), 4],
                // bullet_list_open to bullet_list_close: "aaa" and then the list's "- " make 5 bytes of text.
                ['text, at the list close', '- aaa', { sourceBytes: 1000, textBytes: 4, htmlBytes: 1000 }, TEXT_OVER(4), 8],
            ])('a part one byte over its limit stops the walk at exactly the token that passes it (%s)', (_label, first, limits, problem, visited) => {
                const out = walk(`${first}${'\n\nb'.repeat(20)}`, limits);
                expect(out.out).toEqual(problem);
                expect(out.visited).toBe(visited);
            });

            test('when one token passes both limits, the text limit is the one reported', () => {
                // <p style="margin:0 0 1em"> is 26 bytes, so "ab" makes 28 of HTML (27 once the trailing newline goes) and 2 of text.
                expect(walk('ab\n\ncd', { sourceBytes: 100, textBytes: 1, htmlBytes: 26 }).out).toEqual(TEXT_OVER(1));
                expect(walk('ab\n\ncd', { sourceBytes: 100, textBytes: 2, htmlBytes: 26 }).out).toEqual(HTML_OVER(26));
            });

            test.each([
                ['plain text', 'aaa'],
                ['a link', 'see [a](https://x.example)'],
                ['a blank-label link', '[ ](https://x.example)'],
                ['a link labelled with its address', '[a@x.example](mailto:a@x.example)'],
                ['a code span', 'run `c`'],
                ['a code span in an alt text', '![`c` *d*](https://x.example/i.png)'],
                ['an image in a link', '[![i](https://i.example/i.png)](https://x.example)'],
                ['a list', '- aaa'],
                ['a quote', '> a\nb'],
                ['a rule', '---'],
                ['a code block', '```\nx\n```'],
                ['a table', '| a |\n|---|\n| b |'],
            ])('%s renders with each limit at exactly its size, and is refused one byte under', (_label, markdown) => {
                const { text: textPart, html: htmlPart } = render(markdown);
                const exact = { sourceBytes: 100, textBytes: textPart.length, htmlBytes: htmlPart.length };
                expect(render(markdown, exact)).toEqual({ text: textPart, html: htmlPart });
                expect(renderMarkdownBody(markdown, { ...exact, textBytes: exact.textBytes - 1 })).toEqual(TEXT_OVER(exact.textBytes - 1));
                expect(renderMarkdownBody(markdown, { ...exact, htmlBytes: exact.htmlBytes - 1 })).toEqual(HTML_OVER(exact.htmlBytes - 1));
            });
        });

        test.each([
            ['block quotes', 19, (depth: number) => `${'>'.repeat(depth)} deep`],
            ['lists', 9, (depth: number) => `${'- '.repeat(depth)}deep`],
        ])('%s nest up to a fixed depth; one level more is refused, never silently cut', (_label, deepest, source) => {
            expect(text(source(deepest))).toEndWith('deep');
            expect(renderMarkdownBody(source(deepest + 1))).toEqual({ problem: 'the markdown body nests lists or block quotes too deeply' });
        });
    });
});

describe('composeEmailBody', () => {
    test('a plain-text body (the default) is exactly the body, with no HTML', () => {
        expect(composeEmailBody('Hi **there**\n<b>x</b>', undefined)).toStrictEqual({ text: 'Hi **there**\n<b>x</b>' });
        expect(composeEmailBody('Hi **there**', 'text')).toStrictEqual({ text: 'Hi **there**' });
    });

    test('a markdown body is its rendered text and HTML', () => {
        expect(composeEmailBody('Hi **there**', 'markdown')).toStrictEqual({ text: 'Hi there', html: `${P}Hi <strong>there</strong></p>` });
    });

    test('a markdown body that renders no HTML is text only', () => {
        expect(composeEmailBody(' \n', 'markdown')).toStrictEqual({ text: '' });
    });

    test('a markdown body the renderer refuses is the refusal', () => {
        expect(composeEmailBody('a'.repeat(MARKDOWN_LIMITS.sourceBytes + 1), 'markdown')).toEqual({ problem: 'the markdown body is larger than 64.0 KB' });
    });
});

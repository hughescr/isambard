import { describe, test, expect } from 'bun:test';
import { messageBodyText } from '@/integrations/email/body-text';

/** Plenty of room: no test below is about the size limit unless it says so. */
const ROOMY = 50_000;

/** The body built from HTML parts alone. */
const fromHtml = (...html: string[]): string => messageBodyText(undefined, html, ROOMY);

describe('messageBodyText', () => {
    describe('choosing the part', () => {
        test('builds the body from the HTML when there is a text part too', () => {
            expect(messageBodyText('the text part', ['<p>the <b>HTML</b> part</p>'], ROOMY)).toBe('the HTML part');
        });

        test('keeps a text-only body exactly as it is', () => {
            expect(messageBodyText('Reply to <user@example.com>\n\n  indented', undefined, ROOMY)).toBe('Reply to <user@example.com>\n\n  indented');
        });

        test('uses the text part when the HTML is only whitespace once converted', () => {
            expect(messageBodyText('the text part', ['<div>&nbsp;</div>'], ROOMY)).toBe('the text part');
        });

        test('uses the text part when there are no HTML parts', () => {
            expect(messageBodyText('the text part', [], ROOMY)).toBe('the text part');
        });

        test('is empty when there is neither part', () => {
            expect(messageBodyText(undefined, undefined, ROOMY)).toBe('');
        });

        test('is empty when the HTML yields nothing and there is no text part', () => {
            expect(messageBodyText(undefined, ['<img src="https://t.example/p.gif">'], ROOMY)).toBe('');
        });

        test('joins the HTML parts with a line break, which HTML reads as a space', () => {
            expect(fromHtml('one', 'two')).toBe('one two');
        });
    });

    describe('links', () => {
        test('shows each link as its label followed by its URL in brackets', () => {
            expect(fromHtml('<p>See <a href="https://example.com/paper">the paper</a>.</p>')).toBe('See the paper [https://example.com/paper].');
        });

        test('shows a link whose label is its URL once', () => {
            expect(fromHtml('<a href="https://example.com/x">https://example.com/x</a>')).toBe('https://example.com/x');
        });

        test('shows a mailto link whose label is its address once, without brackets', () => {
            expect(fromHtml('Write to <a href="mailto:ann@example.com">ann@example.com</a>')).toBe('Write to ann@example.com');
        });

        test('shows a mailto link with another label as the label and its address', () => {
            expect(fromHtml('<a href="mailto:ann@example.com">Ann</a>')).toBe('Ann [ann@example.com]');
        });

        test('shows no URL for a cid: link, whatever its case', () => {
            expect(fromHtml('<a href="cid:logo@x">logo</a> <a href="CID:pic@x">pic</a>')).toBe('logo pic');
        });

        test('shows no URL for a link within the message', () => {
            expect(fromHtml('<a href="#top">back to top</a>')).toBe('back to top');
        });

        test('keeps the PhilPapers digest shape: hyperlinked titles in a table and a list', () => {
            const html = [
                '<h2>New papers in your areas</h2>',
                '<table><tr><th>Title</th><th>Author</th></tr>',
                '<tr><td><a href="https://philpapers.org/rec/AAA">Paper A</a></td><td>Ann Author</td></tr>',
                '<tr><td><a href="https://philpapers.org/rec/BBB">Paper B</a></td><td>Bob Author</td></tr></table>',
                '<ul><li><a href="https://philpapers.org/rec/CCC">Paper C</a></li></ul>',
            ].join('');
            expect(messageBodyText('New papers in your areas\nPaper A\nPaper B\nPaper C', [html], ROOMY)).toBe([
                'New papers in your areas',
                '',
                'Title',
                'Author',
                '',
                'Paper A [https://philpapers.org/rec/AAA]',
                'Ann Author',
                '',
                'Paper B [https://philpapers.org/rec/BBB]',
                'Bob Author',
                '',
                ' * Paper C [https://philpapers.org/rec/CCC]',
            ].join('\n'));
        });
    });

    describe('what is left out', () => {
        test('drops images, alt text and all', () => {
            expect(fromHtml('<p>Hi<img src="https://t.example/p.gif"><img src="https://example.com/logo.png" alt="Logo"></p>')).toBe('Hi');
        });

        test('drops an element with the hidden attribute', () => {
            expect(fromHtml('<p>shown</p><div hidden>secret div</div>')).toBe('shown');
        });

        test('drops an element styled display:none inline', () => {
            expect(fromHtml('shown<span style="display:none">secret span</span>')).toBe('shown');
        });

        test('drops an element styled display: none inline, whatever its case', () => {
            expect(fromHtml('shown<span style="color: red; DISPLAY: NONE">secret span</span>')).toBe('shown');
        });

        test('keeps an element styled to display otherwise', () => {
            expect(fromHtml('<div style="display:block">shown</div>')).toBe('shown');
        });
    });

    describe('layout', () => {
        test('keeps every heading level in its own case', () => {
            expect(fromHtml('<h1>Level One</h1><h2>Level Two</h2><h3>Level Three</h3><h4>Level Four</h4><h5>Level Five</h5><h6>Level Six</h6>'))
                .toBe('Level One\n\n\nLevel Two\n\n\nLevel Three\n\nLevel Four\n\nLevel Five\n\nLevel Six');
        });

        test('puts each table cell on its own line and each row in its own block, without padding', () => {
            expect(fromHtml(`<table><tr><td>${'wide '.repeat(30)}</td><td>b</td></tr><tr><th>c</th><th>d</th></tr></table>`))
                .toBe(`${'wide '.repeat(30).trim()}\nb\n\nc\nd`);
        });

        test('never wraps a long line', () => {
            const sentence = 'word '.repeat(40).trim();
            expect(fromHtml(`<p>${sentence}</p>`)).toBe(sentence);
        });
    });

    describe('the size limit', () => {
        test('keeps a body exactly at the limit whole, with no note', () => {
            expect(messageBodyText('abcde', undefined, 5)).toBe('abcde');
        });

        test('cuts a longer body at the limit and says so on a last line', () => {
            expect(messageBodyText('abcdef', undefined, 5)).toBe('abcde\n[body truncated: showing the first 5 of 6 bytes]');
        });

        test('cuts the body built from HTML, not the HTML', () => {
            expect(messageBodyText(undefined, ['<p><b>abcdefgh</b></p>'], 5)).toBe('abcde\n[body truncated: showing the first 5 of 8 bytes]');
        });

        test('backs up to a whole character when the limit falls inside one', () => {
            // 'あいう' is 9 bytes; byte 5 is inside 'い', so only 'あ' (3 bytes) is shown.
            expect(messageBodyText('あいう', undefined, 5)).toBe('あ\n[body truncated: showing the first 3 of 9 bytes]');
        });

        test('backs up exactly one byte from the continuation byte of a two-byte character', () => {
            expect(messageBodyText('aé', undefined, 2)).toBe('a\n[body truncated: showing the first 1 of 3 bytes]');
        });
    });
});

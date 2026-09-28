import { describe, expect, test } from 'bun:test';
import { textToNoteHtml } from '@/integrations/zotero/note-html';

describe('textToNoteHtml', () => {
    test('escapes every HTML-significant character, so no raw HTML passes through', () => {
        expect(textToNoteHtml('<script>alert("x") & \'y\'</script>')).toBe('<p>&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;</p>');
    });

    test('splits paragraphs on blank lines and turns single newlines into <br>', () => {
        expect(textToNoteHtml('First line\nsecond line\n\nNext para\r\n  \r\nLast')).toBe('<p>First line<br>second line</p><p>Next para</p><p>Last</p>');
    });

    test('drops leading, trailing and repeated blank lines', () => {
        expect(textToNoteHtml('\n\n  one  \n\n\n\ntwo\n\n')).toBe('<p>one</p><p>two</p>');
    });

    test('returns an empty string for blank text', () => {
        expect(textToNoteHtml('')).toBe('');
        expect(textToNoteHtml(' \n \n ')).toBe('');
    });
});

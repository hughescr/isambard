/**
 * Plain text to Zotero note HTML (#157, design §8.2). The text is HTML-escaped first, so no raw
 * HTML from Izzy (or from anything Izzy read) ever reaches a note.
 */

const ESCAPES: Readonly<Record<string, string>> = {
    '&':  '&amp;',
    '<':  '&lt;',
    '>':  '&gt;',
    '"':  '&quot;',
    '\'': '&#39;',
};

function escapeHtml(text: string): string {
    return text.replaceAll(/[&<>"']/g, character => ESCAPES[character]!);
}

/**
 * Escapes `& < > " '`, splits paragraphs on blank lines into `<p>` elements, and turns the single
 * newlines inside a paragraph into `<br>`. Blank text gives an empty string.
 */
export function textToNoteHtml(text: string): string {
    return text
        .replaceAll('\r\n', '\n')
        .split(/\n[ \t]*\n/)
        .map(paragraph => paragraph.trim())
        .filter(paragraph => paragraph !== '')
        .map(paragraph => `<p>${paragraph.split('\n').map(line => escapeHtml(line.trim())).join('<br>')}</p>`)
        .join('');
}

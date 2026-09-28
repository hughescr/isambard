import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Guards against a `test.each` title that can produce a multi-line (or otherwise
 * control-character-bearing) test name.
 *
 * Root cause (found 2026-09-28): `test.each([...])('%p → %p', ...)` where an argument at
 * a `%p`/`%o` position is an object or array pretty-prints across several lines (Bun's
 * `util.inspect`-style formatter), e.g. `"1706.03762v7" → {\n  id: "1706.03762",\n}`.
 * Stryker's bun runner maps a failing test back to its dry-run id by *name*; a name
 * containing `\n` cannot be resolved, so the kill is silently dropped and the mutant
 * re-runs forever on every incremental `bun mutate`. `%s` has the same failure mode for a
 * string argument whose *value* contains a raw control character (`%p`/`%o`/`%j` quote and
 * escape control characters when pretty-printing or JSON-stringifying a string; `%s` just
 * concatenates the raw value).
 *
 * This is a static, best-effort source scan, not a re-implementation of Bun's formatter: it
 * flags a `%p`/`%o` argument column that is syntactically an object/array literal, and a
 * `%s` argument column that is a string literal containing an escaped or literal newline,
 * carriage return or tab. It cannot see through computed data tables, spreads, or
 * non-literal titles, and skips anything it cannot confidently parse rather than risk a
 * false positive — the exhaustive check is a real dry-run test suite (see the commit that
 * fixed identifiers.test.ts for the recipe: `bun --bun test --reporter=junit
 * --reporter-outfile=<path>`, then scan decoded `name="..."` attributes for control
 * characters). This test is the cheap, always-on tripwire that catches the common case — a
 * fresh `test.each` table with an object/array column under `%p`/`%o` — before it ever
 * reaches Stryker.
 */

interface Risk {
    file:   string
    line:   number
    detail: string
}

const CONSUMING_SPECIFIERS = new Set(['p', 'o', 's', 'd', 'i', 'f', 'j']);
const QUOTES = new Set(['\'', '"', '`']);

/** Resume index just past the `{...}` following a template literal's `${`, given the index right after it. */
function skipTemplateExpression(src: string, start: number): number {
    let i = start;
    let depth = 1;
    while(i < src.length && depth > 0) {
        if(src[i] === '{') {
            depth++;
        } else if(src[i] === '}') {
            depth--;
        }
        i++;
    }
    return i;
}

/** Resume index just past the closing quote matching `src[startIdx]`, handling `\`-escapes and (shallowly) `${...}` in template literals. */
function skipString(src: string, startIdx: number): number {
    const quote = src[startIdx];
    let i = startIdx + 1;
    while(i < src.length) {
        if(src[i] === '\\') {
            i += 2;
            continue;
        }
        if(src[i] === quote) {
            return i + 1;
        }
        if(quote === '`' && src[i] === '$' && src[i + 1] === '{') {
            i = skipTemplateExpression(src, i + 2);
            continue;
        }
        i++;
    }
    return src.length;
}

/** Resume index just past the end of a `//` line comment starting at `i`. */
function skipLineComment(src: string, i: number): number {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl + 1;
}

/** Resume index just past the end of a `/* *\/` block comment starting at `i`. */
function skipBlockComment(src: string, i: number): number {
    const end = src.indexOf('*/', i + 2);
    return end === -1 ? src.length : end + 2;
}

/** Index of the character matching the bracket at `src[openIdx]`, skipping over strings/comments. Returns -1 if unmatched. */
function findMatch(src: string, openIdx: number): number {
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const open = src[openIdx];
    const close = pairs[open];
    let depth = 0;
    let i = openIdx;
    while(i < src.length) {
        const c = src[i];
        if(QUOTES.has(c)) {
            i = skipString(src, i);
            continue;
        }
        if(c === '/' && src[i + 1] === '/') {
            i = skipLineComment(src, i);
            continue;
        }
        if(c === '/' && src[i + 1] === '*') {
            i = skipBlockComment(src, i);
            continue;
        }
        if(c === open) {
            depth++;
        } else if(c === close) {
            depth--;
            if(depth === 0) {
                return i;
            }
        }
        i++;
    }
    return -1;
}

/** Splits `src` on a top-level (bracket-depth-0, outside strings) separator char. */
function splitTopLevel(src: string, sep = ','): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    while(i < src.length) {
        const c = src[i];
        if(QUOTES.has(c)) {
            i = skipString(src, i);
            continue;
        }
        if(c === '(' || c === '[' || c === '{') {
            depth++;
        } else if(c === ')' || c === ']' || c === '}') {
            depth--;
        } else if(c === sep && depth === 0) {
            parts.push(src.slice(start, i));
            start = i + 1;
        }
        i++;
    }
    parts.push(src.slice(start));
    return parts.map(p => p.trim()).filter(p => p.length > 0);
}

/** Format specifiers in appearance order, as consumed argument kinds ('p'/'o'/'s'/'d'/'i'/'f'/'j'); `%%` and `%#` consume no argument. */
function specifierKinds(title: string): string[] {
    const kinds: string[] = [];
    const re = /%(.)/g;
    let m: RegExpExecArray | null;
    while((m = re.exec(title))) {
        const k = m[1];
        if(CONSUMING_SPECIFIERS.has(k)) {
            kinds.push(k);
        }
    }
    return kinds;
}

/** Strips a trailing `as const` (and the whitespace before it) from already-trimmed text. */
function stripTrailingAsConst(text: string): string {
    const m = /\bas\s+const$/.exec(text);
    return m ? text.slice(0, m.index).trimEnd() : text;
}

/** The rows of a `.each([...])` data array as raw source text, or null if the array literal can't be statically read (dynamic table). */
function parseDataRows(dataText: string): string[] | null {
    const text = stripTrailingAsConst(dataText.trim());
    if(!text.startsWith('[') || !text.endsWith(']')) {
        return null;
    }
    return splitTopLevel(text.slice(1, -1));
}

/** The columns of one `.each` row: a tuple's elements, or the whole row as a single column. */
function rowColumns(row: string): string[] {
    if(row.startsWith('[') && row.endsWith(']')) {
        return splitTopLevel(row.slice(1, -1));
    }
    return [row];
}

/** True if `text` is a quoted string literal containing a raw or backslash-escaped newline, carriage return or tab. */
function stringLiteralHasControlChar(text: string): boolean {
    const quote = text[0];
    if(!QUOTES.has(quote) || !text.endsWith(quote)) {
        return false;
    }
    const body = text.slice(1, -1);
    return /\\[nrt]/.test(body) || /[\n\r\t]/.test(body);
}

/** Whether one row's column under a `%p`/`%o`/`%s` specifier is risky. */
function columnIsRisky(kind: string, col: string): boolean {
    if(kind === 'p' || kind === 'o') {
        return col.startsWith('{') || col.startsWith('[');
    }
    return stringLiteralHasControlChar(col);
}

/** Risky `%p`/`%o`/`%s` argument columns in one `test.each`/`it.each`/`describe.each` call, given its data-array and title source text. */
function risksForCall(dataText: string, title: string): string[] {
    const rows = parseDataRows(dataText);
    if(rows === null) {
        return [];
    }
    const kinds = specifierKinds(title);
    const risks: string[] = [];
    for(const [columnIndex, kind] of kinds.entries()) {
        if(kind !== 'p' && kind !== 'o' && kind !== 's') {
            continue;
        }
        for(const row of rows) {
            const columns = rowColumns(row);
            if(columnIndex >= columns.length) {
                continue;
            }
            const col = columns[columnIndex].trim();
            if(columnIsRisky(kind, col)) {
                risks.push(`%${kind} at column ${columnIndex} (title ${JSON.stringify(title)}) sees ${col}`);
            }
        }
    }
    return risks;
}

/** The literal title text of a `.each(...)(<title>, fn)` call's first argument, or null if it isn't a plain (non-interpolated) string/template literal. */
function extractTitle(call2Args: string[]): string | null {
    if(call2Args.length === 0) {
        return null;
    }
    const titleRaw = call2Args[0];
    const quote = titleRaw[0];
    if(!QUOTES.has(quote) || !titleRaw.endsWith(quote)) {
        return null; // not a literal title (e.g. computed) — can't statically verify, skip rather than false-positive
    }
    if(quote === '`' && titleRaw.includes('${')) {
        return null; // interpolated template title — dynamic, skip
    }
    return titleRaw.slice(1, -1);
}

interface EachCall {
    dataText: string
    title:    string
}

/** Parses the `([rows])(title, fn)` call pair starting at `openIdx` (the `(` right after `.each`), or null if it isn't statically readable. */
function extractEachCall(source: string, openIdx: number): EachCall | null {
    const closeIdx = findMatch(source, openIdx);
    if(closeIdx === -1) {
        return null;
    }
    const dataText = source.slice(openIdx + 1, closeIdx);

    let j = closeIdx + 1;
    while(j < source.length && /\s/.test(source[j])) {
        j++;
    }
    if(source[j] !== '(') {
        return null;
    }

    const call2Close = findMatch(source, j);
    if(call2Close === -1) {
        return null;
    }
    const title = extractTitle(splitTopLevel(source.slice(j + 1, call2Close)));
    if(title === null) {
        return null;
    }
    return { dataText, title };
}

/** Scans one file's source for `.each(` calls and reports any risky title/data combination found. */
function scanFile(file: string, source: string): Risk[] {
    const risks: Risk[] = [];
    const eachRe = /\.each(?:<[^>]*>)?\(/g;
    let m: RegExpExecArray | null;
    while((m = eachRe.exec(source))) {
        const openIdx = m.index + m[0].length - 1;
        const call = extractEachCall(source, openIdx);
        if(call === null) {
            continue;
        }
        const line = source.slice(0, openIdx).split('\n').length;
        for(const detail of risksForCall(call.dataText, call.title)) {
            risks.push({ file, line, detail });
        }
    }
    return risks;
}

/** Every `.test.ts` file under `tests/`, recursively. */
function testFiles(dir: string): string[] {
    const files: string[] = [];
    // eslint-disable-next-line n/no-sync -- one-shot repo scan at test-collection time, not a hot path
    for(const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if(entry.isDirectory()) {
            files.push(...testFiles(full));
        } else if(entry.isFile() && entry.name.endsWith('.test.ts')) {
            files.push(full);
        }
    }
    return files;
}

describe('test.each title safety', () => {
    test('no %p/%o title argument is an object or array, and no %s argument is a control-character string', () => {
        const root = path.join(import.meta.dir, '../../..');
        const files = testFiles(path.join(root, 'tests'));
        const risks = files.flatMap((file) => {
            // eslint-disable-next-line n/no-sync -- one-shot repo scan at test-collection time, not a hot path
            const source = readFileSync(file, 'utf8');
            return scanFile(path.relative(root, file), source);
        });

        expect(risks).toEqual([]);
    });
});

import { describe, expect, mock, test } from 'bun:test';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, buildAttachments, planLocalAttachments, readLocalAttachments, type ContainedFileReader, type LocalAttachmentPlan } from '../../../src/agent/email-attachments';
import { InvariantViolationError, PathSecurityError, type PathSecurityReason } from '../../../src/errors';

const ROOT = '/work/izzy';

/** A contained reader over an in-memory tree: each relative path's bytes, anything else not found. */
function fakeReader(files: Partial<Record<string, string>>): ReturnType<typeof mock<ContainedFileReader>> {
    return mock<ContainedFileReader>(async (_root, rel, maxBytes) => {
        const content = files[rel];
        if(content === undefined) {
            throw new PathSecurityError(`File not found: ${rel}`, rel, 'not_found');
        }
        const bytes = Buffer.from(content);
        if(bytes.length > maxBytes) {
            throw new PathSecurityError(`File is larger than the ${maxBytes}-byte limit: ${rel}`, rel, 'too_large');
        }
        return { bytes, size: bytes.length };
    });
}

function plan(given: string, relative: string, filename: string): LocalAttachmentPlan {
    return { given, relative, filename };
}

async function drainMicrotasks(ticks = 10): Promise<void> {
    for(let i = 0; i < ticks; i++) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
        await Promise.resolve();
    }
}

describe('attachment limits', () => {
    test('one email carries at most 50 attachments and 25 MiB of them', () => {
        expect(MAX_ATTACHMENTS).toBe(50);
        expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    });
});

describe('planLocalAttachments', () => {
    test('takes a path relative to the working directory, naming the attachment after its last segment', () => {
        expect(planLocalAttachments(ROOT, ['docs/report.pdf', 'notes.txt'])).toEqual([
            plan('docs/report.pdf', 'docs/report.pdf', 'report.pdf'),
            plan('notes.txt', 'notes.txt', 'notes.txt'),
        ]);
    });

    test('normalises an absolute path inside the working directory to one relative to it', () => {
        expect(planLocalAttachments(ROOT, ['/work/izzy/docs/./drafts/../report.pdf', './a//b.txt'])).toEqual([
            plan('/work/izzy/docs/./drafts/../report.pdf', 'docs/report.pdf', 'report.pdf'),
            plan('./a//b.txt', 'a/b.txt', 'b.txt'),
        ]);
    });

    test('accepts a name that only contains dots after its first character, and two dots inside a name', () => {
        expect(planLocalAttachments(ROOT, ['a.b.c', 'x..y/z'])).toEqual([plan('a.b.c', 'a.b.c', 'a.b.c'), plan('x..y/z', 'x..y/z', 'z')]);
    });

    test.each([
        ['a parent-directory escape', '../secret.txt'],
        ['a deeper escape', 'docs/../../secret.txt'],
        ['an absolute path elsewhere', '/Users/craig/.ssh/id_ed25519'],
        ['a sibling directory sharing the root as a prefix', '/work/izzy-other/a.txt'],
        ['the parent itself', '..'],
    ])('refuses %s, naming the path as given', (_label, given) => {
        expect(planLocalAttachments(ROOT, [given])).toEqual({ problem: `the attachment ${JSON.stringify(given)} is outside your working directory` });
    });

    test.each([
        ['a dotfile', '.env'],
        ['a file in a dot-directory', '.git/config'],
        ['a dotfile deeper down', 'keys/.ssh/id_ed25519'],
        ['an absolute path into a dot-directory', '/work/izzy/.cache/x.pdf'],
        ['a name that is only a dot-prefixed extension', 'docs/.pdf'],
    ])('refuses %s', (_label, given) => {
        expect(planLocalAttachments(ROOT, [given])).toEqual({ problem: `the attachment ${JSON.stringify(given)} is a hidden file or in a hidden folder (a name starting with ".")` });
    });

    test.each([
        ['the working directory itself', '.', 'it is empty'],
        ['the root as an absolute path', '/work/izzy', 'it is empty'],
        ['a control character', 'bad\u0007name.txt', 'it contains a control or text-direction character'],
        ['a NUL', 'nul\u0000.txt', 'it contains a control or text-direction character'],
        ['a DEL', 'del\u007F.txt', 'it contains a control or text-direction character'],
        ['a right-to-left override', `invoice${String.fromCodePoint(0x20_2E)}txt.exe`, 'it contains a control or text-direction character'],
        ['an encoded-word start', 'report=?utf-8?.pdf', 'it contains "=?"'],
        ['leading whitespace', ' report.pdf', 'it starts or ends with whitespace'],
        ['trailing whitespace', 'report.pdf ', 'it starts or ends with whitespace'],
        ['a backslash', String.raw`a\b.pdf`, 'it contains a backslash'],
    ])('refuses a file name with %s', (_label, given, reason) => {
        expect(planLocalAttachments(ROOT, [given])).toEqual({ problem: `the attachment ${JSON.stringify(given.replaceAll(/[\u0000-\u001F\u007F‮]/gu, ''))} has a file name that can't be sent (${reason})` });
    });

    // Built here rather than in a test.each table, which replaces a lone surrogate before the test sees it.
    test('refuses a path with an unpaired surrogate anywhere in it, before normalising could replace it', () => {
        const surrogate = String.fromCodePoint(0xD8_00);
        for(const given of [`half${surrogate}.txt`, `dir${surrogate}/a.txt`]) {
            expect(given.isWellFormed()).toBe(false);
            expect(planLocalAttachments(ROOT, [given])).toEqual({ problem: `the attachment ${JSON.stringify(given)} is not valid Unicode text` });
        }
    });

    test('refuses a file name longer than 255 bytes, showing it cut', () => {
        const given = `${'é'.repeat(126)}.pdf`;
        expect(Buffer.byteLength(given)).toBe(256);
        expect(planLocalAttachments(ROOT, [given])).toEqual({ problem: `the attachment "${'é'.repeat(80)}…" has a file name that can't be sent (it is longer than 255 bytes)` });
    });

    test('accepts a 255-byte name and inner whitespace', () => {
        const name = `${'é'.repeat(125)}a.pdf`;
        expect(Buffer.byteLength(name)).toBe(255);
        expect(planLocalAttachments(ROOT, [name, 'two words.pdf'])).toEqual([plan(name, name, name), plan('two words.pdf', 'two words.pdf', 'two words.pdf')]);
    });

    test('shows the path as given with control characters stripped, cut to 80 characters', () => {
        const long = `../${'x'.repeat(100)}`;
        expect(planLocalAttachments(ROOT, ['../\u001B[31mevil.txt', long])).toEqual({ problem: 'the attachment "../[31mevil.txt" is outside your working directory' });
        expect(planLocalAttachments(ROOT, [long])).toEqual({ problem: `the attachment "${long.slice(0, 80)}…" is outside your working directory` });
    });

    test('reports the first path that fails, in the order given', () => {
        expect(planLocalAttachments(ROOT, ['ok.txt', '.env', '../x'])).toEqual({ problem: 'the attachment ".env" is a hidden file or in a hidden folder (a name starting with ".")' });
    });

    test('plans nothing for no paths', () => {
        expect(planLocalAttachments(ROOT, [])).toEqual([]);
    });
});

describe('readLocalAttachments', () => {
    test('reads each file through the contained reader under the root, capped at the remaining budget, and encodes it in order', async () => {
        const read = fakeReader({ 'docs/report.pdf': 'pdf bytes', 'notes.txt': 'text', 'blob.bin': 'raw', noext: 'plain' });
        const budget = { remaining: 1000 };
        const result = await readLocalAttachments({ root: ROOT, read }, [
            plan('docs/report.pdf', 'docs/report.pdf', 'report.pdf'),
            plan('notes.txt', 'notes.txt', 'notes.txt'),
            plan('blob.bin', 'blob.bin', 'blob.bin'),
            plan('noext', 'noext', 'noext'),
        ], budget);
        expect(result).toEqual({ attachments: [
            { filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('pdf bytes').toString('base64') },
            { filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('text').toString('base64') },
            { filename: 'blob.bin', contentType: 'application/octet-stream', content: Buffer.from('raw').toString('base64') },
            { filename: 'noext', contentType: 'application/octet-stream', content: Buffer.from('plain').toString('base64') },
        ] });
        expect(read.mock.calls.slice(0, 2)).toEqual([[ROOT, 'docs/report.pdf', 1000], [ROOT, 'notes.txt', 1000]]);
        expect(budget.remaining).toBe(1000 - 9 - 4 - 3 - 5);
    });

    test('types an attachment by its extension, case-insensitively', async () => {
        const read = fakeReader({ 'A.PDF': 'x', 'b.Docx': 'y' });
        const result = await readLocalAttachments({ root: ROOT, read }, [plan('A.PDF', 'A.PDF', 'A.PDF'), plan('b.Docx', 'b.Docx', 'b.Docx')], { remaining: 10 });
        expect(result).toEqual({ attachments: [
            { filename: 'A.PDF', contentType: 'application/pdf', content: Buffer.from('x').toString('base64') },
            { filename: 'b.Docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('y').toString('base64') },
        ] });
    });

    test('caps a read that starts after another finished at what that one left of the budget', async () => {
        const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        const caps: number[] = [];
        const read = mock<ContainedFileReader>(async (_root, rel, maxBytes) => {
            caps.push(maxBytes);
            if(rel === 'a') {
                await gates[0].promise;
            }
            if(rel === 'b') {
                await gates[1].promise;
            }
            const bytes = Buffer.from(rel === 'a' ? 'aaaa' : 'b');
            return { bytes, size: bytes.length };
        });
        const pending = readLocalAttachments({ root: ROOT, read }, [plan('a', 'a', 'a'), plan('b', 'b', 'b'), plan('c', 'c', 'c')], { remaining: 10 });
        await drainMicrotasks();
        gates[0].resolve();
        await drainMicrotasks();
        gates[1].resolve();
        await pending;
        expect(caps).toEqual([10, 10, 6]);
    });

    test('never reads more than two files at once, and returns every attachment', async () => {
        const gate = Promise.withResolvers<void>();
        let active = 0;
        let maxActive = 0;
        const read = mock<ContainedFileReader>(async (_root, rel) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            try {
                await gate.promise;
                return { bytes: Buffer.from(rel), size: rel.length };
            } finally {
                active -= 1;
            }
        });
        const pending = readLocalAttachments({ root: ROOT, read }, [plan('a0.txt', 'a0.txt', 'a0.txt'), plan('a1.txt', 'a1.txt', 'a1.txt'), plan('a2.txt', 'a2.txt', 'a2.txt')], { remaining: 100 });
        try {
            await drainMicrotasks();
            // Exactly 2 (not 1, not 3): proves the concurrency limit is 2, not merely "at most 2".
            expect(maxActive).toBe(2);
            gate.resolve();
            expect(await pending).toEqual({ attachments: ['a0.txt', 'a1.txt', 'a2.txt'].map(name => ({ filename: name, contentType: 'text/plain', content: Buffer.from(name).toString('base64') })) });
        } finally {
            gate.resolve();
            await pending.catch(() => undefined);
        }
    });

    test('refuses files that together pass the budget, even when each fit when it started', async () => {
        const read = fakeReader({ a: '123456', b: '123456' });
        const result = await readLocalAttachments({ root: ROOT, read }, [plan('a', 'a', 'a'), plan('b', 'b', 'b')], { remaining: 10 });
        expect(result).toEqual({ problem: 'the attachments come to more than the 25.0 MB one email can carry' });
    });

    test('accepts files that use up the budget exactly', async () => {
        const read = fakeReader({ a: '12345', b: '12345' });
        const budget = { remaining: 10 };
        const result = await readLocalAttachments({ root: ROOT, read }, [plan('a', 'a', 'a'), plan('b', 'b', 'b')], budget);
        expect('attachments' in result).toBe(true);
        expect(budget.remaining).toBe(0);
    });

    test('a budget already overdrawn caps the next read at zero bytes', async () => {
        const read = fakeReader({ empty: '' });
        const result = await readLocalAttachments({ root: ROOT, read }, [plan('empty', 'empty', 'empty')], { remaining: -5 });
        expect(read.mock.calls).toEqual([[ROOT, 'empty', 0]]);
        expect(result).toEqual({ problem: 'the attachments come to more than the 25.0 MB one email can carry' });
    });

    test('a file larger than the remaining budget is refused as too large', async () => {
        const read = fakeReader({ big: 'x'.repeat(20) });
        expect(await readLocalAttachments({ root: ROOT, read }, [plan('big', 'big', 'big')], { remaining: 10 })).toEqual({ problem: 'the attachments come to more than the 25.0 MB one email can carry' });
    });

    test.each<[PathSecurityReason, string]>([
        ['not_found', 'was not found'],
        ['is_symlink', 'is a symbolic link'],
        ['not_directory', 'is in a folder that is missing, is a symbolic link or is not a folder'],
        ['not_file', 'is not a regular file'],
        ['hardlinked', 'has more than one hard link'],
        ['changed_during_read', 'changed while it was being read'],
        ['outside_cwd', 'is outside your working directory'],
        ['unsupported_platform', 'could not be read'],
        ['changed_during_write', 'could not be read'],
    ])('a read refused as %s is reported in plain words', async (reason, phrase) => {
        const read = mock<ContainedFileReader>(async (_root, rel) => {
            throw new PathSecurityError(`refused ${rel}`, rel, reason);
        });
        expect(await readLocalAttachments({ root: ROOT, read }, [plan('given/x.pdf', 'given/x.pdf', 'x.pdf')], { remaining: 10 })).toEqual({ problem: `the attachment "given/x.pdf" ${phrase}` });
    });

    test.each([
        ['an object shaped like a too-large refusal', { context: { reason: 'too_large' } }],
        ['an object shaped like a not-found refusal', { context: { reason: 'not_found' } }],
    ])('takes only a PathSecurityError for a refusal: %s could not be read', async (_label, thrown) => {
        const read = mock<ContainedFileReader>();
        read.mockRejectedValue(thrown);
        expect(await readLocalAttachments({ root: ROOT, read }, [plan('x.pdf', 'x.pdf', 'x.pdf')], { remaining: 10 })).toEqual({ problem: 'the attachment "x.pdf" could not be read' });
    });

    test('a read that fails some other way could not be read, and its own text is not shown', async () => {
        const read = mock<ContainedFileReader>(async () => {
            throw new InvariantViolationError('contained-fs', 'secret detail');
        });
        expect(await readLocalAttachments({ root: ROOT, read }, [plan('x.pdf', 'x.pdf', 'x.pdf')], { remaining: 10 })).toEqual({ problem: 'the attachment "x.pdf" could not be read' });
    });

    test('reports the first failed read in the order given', async () => {
        const read = fakeReader({ ok: 'x', big: 'x'.repeat(8) });
        expect(await readLocalAttachments({ root: ROOT, read }, [plan('ok', 'ok', 'ok'), plan('gone1', 'gone1', 'gone1'), plan('gone2', 'gone2', 'gone2')], { remaining: 5 })).toEqual({ problem: 'the attachment "gone1" was not found' });
        expect(await readLocalAttachments({ root: ROOT, read }, [plan('big', 'big', 'big'), plan('gone1', 'gone1', 'gone1')], { remaining: 5 })).toEqual({ problem: 'the attachments come to more than the 25.0 MB one email can carry' });
    });

    test('a refused read is reported before files that together pass the budget', async () => {
        const read = fakeReader({ a: '123456', b: '123456' });
        expect(await readLocalAttachments({ root: ROOT, read }, [plan('a', 'a', 'a'), plan('b', 'b', 'b'), plan('gone', 'gone', 'gone')], { remaining: 10 })).toEqual({ problem: 'the attachment "gone" was not found' });
    });

    test('reads nothing for no plans', async () => {
        const read = fakeReader({});
        expect(await readLocalAttachments({ root: ROOT, read }, [], { remaining: 0 })).toEqual({ attachments: [] });
        expect(read).not.toHaveBeenCalled();
    });
});

describe('buildAttachments', () => {
    test('plans and reads the files of one email within the 25 MiB budget', async () => {
        const read = fakeReader({ 'a.txt': 'A' });
        expect(await buildAttachments({ root: ROOT, read }, ['/work/izzy/a.txt'])).toEqual({ attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('A').toString('base64') }] });
        expect(read.mock.calls).toEqual([[ROOT, 'a.txt', MAX_ATTACHMENT_BYTES]]);
    });

    test('refuses more than 50 files before reading any', async () => {
        const read = fakeReader({});
        const paths = Array.from({ length: 51 }, (_, index) => `f${index}.txt`);
        expect(await buildAttachments({ root: ROOT, read }, paths)).toEqual({ problem: 'that would be 51 attachments, more than the 50 one email can carry' });
        expect(read).not.toHaveBeenCalled();
    });

    test('takes exactly 50 files', async () => {
        const files = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`f${index}.txt`, 'x']));
        const result = await buildAttachments({ root: ROOT, read: fakeReader(files) }, Object.keys(files));
        expect(result).toEqual({ attachments: Object.keys(files).map(name => ({ filename: name, contentType: 'text/plain', content: Buffer.from('x').toString('base64') })) });
    });

    test('refuses a path outside the root before reading any file', async () => {
        const read = fakeReader({ 'a.txt': 'A' });
        expect(await buildAttachments({ root: ROOT, read }, ['a.txt', '/etc/passwd'])).toEqual({ problem: 'the attachment "/etc/passwd" is outside your working directory' });
        expect(read).not.toHaveBeenCalled();
    });
});

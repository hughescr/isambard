import { describe, expect, test } from 'bun:test';
import {
    MAX_TEXT_CHARS,
    addedBy,
    clip,
    collectionRows,
    formatAnnotation,
    formatAttachment,
    formatCreators,
    formatNote,
    htmlToText,
    itemFields,
    sortAnnotations,
    summarizeItem
} from '../../../../src/agent/zotero/format';
import type { ZoteroCollection, ZoteroItem } from '../../../../src/integrations/zotero';

const IZZY = 21_862_647;

function item(data: Record<string, unknown>, meta: Record<string, unknown> = {}): ZoteroItem {
    const key = typeof data.key === 'string' ? data.key : 'ABCD2345';
    const version = typeof data.version === 'number' ? data.version : 3;
    return { key, version, meta, data: { key: 'ABCD2345', version: 3, itemType: 'journalArticle', ...data } };
}

describe('zotero format', () => {
    describe('clip and htmlToText', () => {
        test('keeps text at the limit and marks longer text truncated', () => {
            expect(clip('abc', 3)).toEqual({ text: 'abc' });
            expect(clip('abcd', 3)).toEqual({ text: 'abc', truncated: true });
            expect(MAX_TEXT_CHARS).toBe(8000);
            expect(clip('x'.repeat(8001))).toEqual({ text: 'x'.repeat(8000), truncated: true });
        });

        test('converts note HTML to plain text without wrapping', () => {
            expect(htmlToText('<p>First <b>para</b></p><p>Second</p>')).toBe('First para\n\nSecond');
            expect(htmlToText(`<p>${'word '.repeat(40)}</p>`)).not.toContain('\n');
        });
    });

    describe('formatCreators', () => {
        test('formats people as "Last, F." and organisations by name', () => {
            expect(formatCreators([
                { creatorType: 'author', firstName: 'Ada Mary', lastName: 'Lovelace' },
                { creatorType: 'author', name: 'CERN' },
                { creatorType: 'editor', firstName: 'Alan', lastName: 'Turing' },
                { creatorType: 'author', firstName: '', lastName: 'Solo' },
            ])).toBe('Lovelace, A. M.; CERN; Turing, A. (editor); Solo');
        });

        test('ignores a missing or malformed creator list', () => {
            expect(formatCreators(undefined)).toBe('');
            expect(formatCreators([null, 'x', {}])).toBe('');
        });
    });

    describe('addedBy', () => {
        test('names Izzy, another user, or unknown', () => {
            expect(addedBy({ createdByUser: { id: IZZY, username: 'isambard' } }, IZZY)).toBe('izzy');
            expect(addedBy({ createdByUser: { id: 1, username: 'craig' } }, IZZY)).toBe('craig');
            expect(addedBy({ createdByUser: { id: 1 } }, IZZY)).toBe('unknown');
            expect(addedBy(undefined, IZZY)).toBe('unknown');
        });
    });

    describe('summarizeItem', () => {
        test('summarises a regular item', () => {
            const summary = summarizeItem(item({
                title:       'Attention',
                creators:    [{ creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' }],
                date:        '2017',
                DOI:         '10.48550/arXiv.1706.03762',
                url:         'https://arxiv.org/abs/1706.03762',
                tags:        [{ tag: 'ml' }, { tag: 'nlp', type: 1 }],
                collections: ['COLL2345'],
            }, { numChildren: 2, createdByUser: { id: IZZY } }), IZZY);

            expect(summary).toEqual({
                key:         'ABCD2345',
                version:     3,
                itemType:    'journalArticle',
                title:       'Attention',
                creators:    'Vaswani, A.',
                date:        '2017',
                DOI:         '10.48550/arXiv.1706.03762',
                url:         'https://arxiv.org/abs/1706.03762',
                tags:        ['ml', 'nlp'],
                collections: ['COLL2345'],
                numChildren: 2,
                addedBy:     'izzy',
                inTrash:     false,
            });
        });

        test('omits absent optional fields and reads the trash flag', () => {
            const summary = summarizeItem(item({ deleted: 1 }), IZZY);

            expect(summary).toEqual({
                key: 'ABCD2345', version: 3, itemType: 'journalArticle', title: '', creators: '', tags: [], collections: [], numChildren: 0, addedBy: 'unknown', inTrash: true,
            });
            expect(summarizeItem(item({ deleted: true }), IZZY).inTrash).toBe(true);
            expect(summarizeItem(item({ deleted: false, DOI: '', url: '', date: '' }), IZZY)).not.toHaveProperty('DOI');
        });
    });

    describe('itemFields', () => {
        test('lists the editable non-empty string fields only', () => {
            expect(itemFields({
                key: 'K', version: 1, itemType: 'book', title: 'T', publisher: 'P', extra: '', abstractNote: 'A', note: 'N', parentItem: 'X', dateAdded: 'd', dateModified: 'm', volume: 3,
            })).toEqual({ title: 'T', publisher: 'P' });
        });
    });

    describe('notes, attachments and annotations', () => {
        test('formats a note as clipped text', () => {
            const note = item({ itemType: 'note', note: `<p>${'y'.repeat(8005)}</p>`, dateModified: '2026-09-27T00:00:00Z', tags: [{ tag: 'todo' }] }, { createdByUser: { id: 5, username: 'craig' } });

            expect(formatNote(note, IZZY)).toEqual({
                key: 'ABCD2345', version: 3, text: 'y'.repeat(8000), truncated: true, addedBy: 'craig', dateModified: '2026-09-27T00:00:00Z', tags: ['todo'],
            });
            expect(formatNote(item({ itemType: 'note' }), IZZY)).toEqual({ key: 'ABCD2345', version: 3, text: '', addedBy: 'unknown', tags: [] });
        });

        test('formats a stored PDF attachment with its annotations', () => {
            const attachment = { ...item({ itemType: 'attachment', title: 'Full Text PDF', contentType: 'application/pdf', filename: 'paper.pdf', linkMode: 'imported_file' }), links: { enclosure: { length: 1234 } } } as ZoteroItem;
            const annotation = item({ key: 'ANNO2345', itemType: 'annotation', annotationType: 'highlight', annotationText: 'key point', annotationComment: 'yes', annotationColor: '#ffd400', annotationPageLabel: '4', dateModified: 'm' }, { createdByUser: { id: 5, username: 'craig' } });

            expect(formatAttachment(attachment, [annotation], IZZY)).toEqual({
                key:             'ABCD2345',
                version:         3,
                title:           'Full Text PDF',
                contentType:     'application/pdf',
                filename:        'paper.pdf',
                linkMode:        'imported_file',
                hasFile:         true,
                sizeBytes:       1234,
                annotationCount: 1,
                annotations:     [{ key: 'ANNO2345', type: 'highlight', text: 'key point', comment: 'yes', color: '#ffd400', pageLabel: '4', addedBy: 'craig', dateModified: 'm' }],
            });
        });

        test('reports hasFile from md5 and omits annotations when not read', () => {
            const byMd5 = item({ itemType: 'attachment', linkMode: 'imported_url', md5: 'abc', contentType: 'text/html' });
            const linked = item({ itemType: 'attachment', linkMode: 'linked_url', title: 'Link' });

            expect(formatAttachment(byMd5, undefined, IZZY)).toEqual({ key: 'ABCD2345', version: 3, title: '', contentType: 'text/html', linkMode: 'imported_url', hasFile: true });
            expect(formatAttachment(item({ itemType: 'attachment' }), undefined, IZZY)).toEqual({ key: 'ABCD2345', version: 3, title: '', contentType: '', linkMode: '', hasFile: false });
            expect(formatAttachment(linked, undefined, IZZY).hasFile).toBe(false);
            expect(formatAttachment(item({ itemType: 'attachment', linkMode: 'imported_file', md5: null }), undefined, IZZY).hasFile).toBe(false);
            expect(formatAttachment({ ...linked, links: { enclosure: {} } }, undefined, IZZY)).not.toHaveProperty('sizeBytes');
        });

        test('lists ink and image annotations without text', () => {
            const ink = item({ itemType: 'annotation', annotationType: 'ink', annotationText: '', annotationPosition: '{"paths":[]}' });

            expect(formatAnnotation(ink, IZZY)).toEqual({ key: 'ABCD2345', type: 'ink', addedBy: 'unknown' });
            expect(formatAnnotation(item({ itemType: 'annotation' }), IZZY)).toEqual({ key: 'ABCD2345', type: 'unknown', addedBy: 'unknown' });
        });

        test('clips long annotation text and comments', () => {
            const long = item({ itemType: 'annotation', annotationType: 'note', annotationComment: 'c'.repeat(8001) });

            expect(formatAnnotation(long, IZZY)).toEqual({ key: 'ABCD2345', type: 'note', comment: 'c'.repeat(8000), truncated: true, addedBy: 'unknown' });
        });

        test('sorts annotations by their sort index, unsorted ones last', () => {
            const at = (key: string, index?: string) => item({ key, itemType: 'annotation', ...index === undefined ? {} : { annotationSortIndex: index } });
            const sorted = sortAnnotations([at('C', '00002|000001|00000'), at('D'), at('A', '00001|000500|00000'), at('B', '00001|000900|00000')]);

            expect(sorted.map(annotation => annotation.data.key)).toEqual(['A', 'B', 'C', 'D']);
        });
    });

    describe('collectionRows', () => {
        test('computes each collection path from its parents', () => {
            const collection = (key: string, name: string, parent: string | false, extra: Record<string, unknown> = {}): ZoteroCollection => ({
                key, version: 2, meta: { numItems: 1, numCollections: 0 }, data: { key, version: 2, name, parentCollection: parent, ...extra },
            });

            const rows = collectionRows([
                collection('CCCC2345', 'Leaf', 'BBBB2345'),
                collection('AAAA2345', 'Root', false),
                collection('BBBB2345', 'Mid', 'AAAA2345', { deleted: true }),
                collection('DDDD2345', 'Orphan', 'ZZZZ2345'),
            ]);

            expect(rows).toEqual([
                { key: 'CCCC2345', version: 2, name: 'Leaf', parentKey: 'BBBB2345', numItems: 1, numCollections: 0, inTrash: false, path: 'Root / Mid / Leaf' },
                { key: 'AAAA2345', version: 2, name: 'Root', parentKey: null, numItems: 1, numCollections: 0, inTrash: false, path: 'Root' },
                { key: 'BBBB2345', version: 2, name: 'Mid', parentKey: 'AAAA2345', numItems: 1, numCollections: 0, inTrash: true, path: 'Root / Mid' },
                { key: 'DDDD2345', version: 2, name: 'Orphan', parentKey: 'ZZZZ2345', numItems: 1, numCollections: 0, inTrash: false, path: 'Orphan' },
            ]);
        });

        test('stops on a parent cycle and defaults missing counts', () => {
            const rows = collectionRows([
                { key: 'AAAA2345', version: 1, data: { key: 'AAAA2345', version: 1, name: 'A', parentCollection: 'BBBB2345' } },
                { key: 'BBBB2345', version: 1, data: { key: 'BBBB2345', version: 1, name: 'B', parentCollection: 'AAAA2345' } },
            ]);

            expect(rows.map(row => row.path)).toEqual(['B / A', 'A / B']);
            expect(rows[0].numItems).toBe(0);
            expect(rows[0].numCollections).toBe(0);
        });
    });
});

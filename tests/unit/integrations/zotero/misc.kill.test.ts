/**
 * Kills mutants surviving in item-fields.ts, types.ts, note-html.ts and deps.ts (#157).
 */
import { describe, expect, test } from 'bun:test';
import { TEST_API_KEY, recordingFetch, json } from '../../../helpers/zotero-fake';
import { createZoteroDeps } from '@/integrations/zotero/deps';
import { fitToTemplate, type MappedItem } from '@/integrations/zotero/item-fields';
import { textToNoteHtml } from '@/integrations/zotero/note-html';
import { zoteroItemSchema } from '@/integrations/zotero/types';

function mapped(overrides: Partial<MappedItem> = {}): MappedItem {
    return {
        itemType:      'journalArticle',
        fields:        { title: 'Deep learning', DOI: '10.1038/nature14539', publicationTitle: 'Nature' },
        creators:      [{ creatorType: 'author', firstName: 'Yann', lastName: 'LeCun' }],
        pdfCandidates: [],
        ...overrides,
    };
}

describe('fitToTemplate: extra stays unset when there is nothing to record', () => {
    test('does not add item.extra to a template that lacks it when there is no extra content', () => {
        const noteTemplate = { itemType: 'note', tags: [], collections: [], relations: {} };
        const item = fitToTemplate(mapped({ itemType: 'note', fields: {} }), noteTemplate);

        expect(Object.hasOwn(item, 'extra')).toBe(false);
        expect(item.extra).toBeUndefined();
    });
});

describe('textToNoteHtml: trims each line inside a paragraph, not just the paragraph as a whole', () => {
    test('strips leading/trailing whitespace from an inner line before escaping it', () => {
        expect(textToNoteHtml('first line \n  second line')).toBe('<p>first line<br>second line</p>');
    });
});

describe('zoteroItemSchema: meta.createdByUser keeps its own field shapes', () => {
    test('rejects a non-number id on the creating user, rather than accepting any loose object', () => {
        const candidate = {
            key:     'ABCD2345',
            version: 1,
            meta:    { createdByUser: { id: 'not-a-number', username: 'someone' } },
            data:    { key: 'ABCD2345', version: 1, itemType: 'note' },
        };

        const result = zoteroItemSchema.safeParse(candidate);

        expect(result.success).toBe(false);
    });

    test('still accepts a valid numeric id', () => {
        const candidate = {
            key:     'ABCD2345',
            version: 1,
            meta:    { createdByUser: { id: 7, username: 'someone' } },
            data:    { key: 'ABCD2345', version: 1, itemType: 'note' },
        };

        const result = zoteroItemSchema.safeParse(candidate);

        expect(result.success).toBe(true);
    });
});

describe('createZoteroDeps: no crossrefMailto means no mailto in the Crossref User-Agent', () => {
    test('omitting crossrefMailto leaves the User-Agent without a mailto clause', async () => {
        const { fetch, calls } = recordingFetch(() => json({ message: { items: [] } }));

        const deps = createZoteroDeps({ apiKey: TEST_API_KEY, groupId: 42, userId: 7, maxStoredFileBytes: 1234 }, { fetch });
        await deps.metadata.lookupDois(['10.1038/nature14539']);

        expect(calls[0].headers.get('User-Agent')).toBe('Isambard (+https://github.com/hughescr/isambard)');
        expect(calls[0].headers.get('User-Agent')).not.toContain('mailto:');
    });
});

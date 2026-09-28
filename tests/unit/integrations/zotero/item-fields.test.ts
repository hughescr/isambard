import { describe, expect, test } from 'bun:test';
import journalTemplate from '../../../fixtures/zotero/template-journalArticle.json';
import noteTemplate from '../../../fixtures/zotero/template-note.json';
import webpageTemplate from '../../../fixtures/zotero/template-webpage.json';
import { fitToTemplate, type MappedItem } from '@/integrations/zotero/item-fields';

function mapped(overrides: Partial<MappedItem> = {}): MappedItem {
    return {
        itemType:      'journalArticle',
        fields:        { title: 'Deep learning', DOI: '10.1038/nature14539', publicationTitle: 'Nature' },
        creators:      [{ creatorType: 'author', firstName: 'Yann', lastName: 'LeCun' }, { creatorType: 'author', name: 'The Consortium' }],
        pdfCandidates: [],
        ...overrides,
    };
}

describe('fitToTemplate', () => {
    test('keeps template fields, shapes creators, and applies tags and collections', () => {
        const item = fitToTemplate(mapped(), journalTemplate, { tags: ['ml', 'review'], collections: ['ABCD2345'] });

        expect(item.itemType).toBe('journalArticle');
        expect(item.title).toBe('Deep learning');
        expect(item.DOI).toBe('10.1038/nature14539');
        expect(item.publicationTitle).toBe('Nature');
        expect(item.volume).toBe('');
        expect(item.extra).toBe('');
        expect(item.creators).toEqual([
            { creatorType: 'author', firstName: 'Yann', lastName: 'LeCun' },
            { creatorType: 'author', name: 'The Consortium' },
        ]);
        expect(item.tags).toEqual([{ tag: 'ml' }, { tag: 'review' }]);
        expect(item.collections).toEqual(['ABCD2345']);
        expect(item.relations).toEqual({});
    });

    test('defaults tags and collections to empty', () => {
        const item = fitToTemplate(mapped(), journalTemplate);

        expect(item.tags).toEqual([]);
        expect(item.collections).toEqual([]);
    });

    test('moves fields the item type lacks into extra, after any mapped extra', () => {
        const item = fitToTemplate(mapped({
            itemType: 'webpage',
            fields:   { title: 'Page', publicationTitle: 'Nature', ISSN: '0028-0836', extra: 'Journal ref: X' },
        }), webpageTemplate);

        expect(item.extra).toBe('Journal ref: X\npublicationTitle: Nature\nISSN: 0028-0836');
        expect(item).not.toHaveProperty('publicationTitle');
        expect(item).not.toHaveProperty('ISSN');
    });

    test('never lets a mapped field overwrite structural template fields', () => {
        const item = fitToTemplate(mapped({ fields: { title: 'T', tags: 'x', collections: 'y', relations: 'z', creators: 'c', itemType: 'book' } }), journalTemplate);

        expect(item.itemType).toBe('journalArticle');
        expect(item.tags).toEqual([]);
        expect(item.collections).toEqual([]);
        expect(item.relations).toEqual({});
        expect(item.extra).toBe('tags: x\ncollections: y\nrelations: z\ncreators: c\nitemType: book');
    });

    test('skips empty mapped values', () => {
        const item = fitToTemplate(mapped({ fields: { title: '', volume: '', ISBN: '' } }), journalTemplate);

        expect(item.title).toBe('');
        expect(item.extra).toBe('');
    });

    test('fills a missing first or last name with an empty string', () => {
        const item = fitToTemplate(mapped({ creators: [{ creatorType: 'author', lastName: 'Solo' }, { creatorType: 'editor', firstName: 'Only' }] }), journalTemplate);

        expect(item.creators).toEqual([
            { creatorType: 'author', firstName: '', lastName: 'Solo' },
            { creatorType: 'editor', firstName: 'Only', lastName: '' },
        ]);
    });

    test('a template without creators gets none, and one without extra still records overflow', () => {
        const item = fitToTemplate(mapped({ itemType: 'note', fields: { DOI: '10.1/x' } }), { itemType: 'note', tags: [], collections: [], relations: {} });

        expect(item).not.toHaveProperty('creators');
        expect(item.extra).toBe('DOI: 10.1/x');
    });

    test('does not mutate the template', () => {
        fitToTemplate(mapped(), journalTemplate, { tags: ['x'] });

        expect(journalTemplate.title).toBe('');
        expect(journalTemplate.tags).toEqual([]);
        expect(noteTemplate.note).toBe('');
    });
});

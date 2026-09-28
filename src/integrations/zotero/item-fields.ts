/**
 * Fitting resolved metadata to a Zotero item template (#157, design §5.5).
 *
 * Crossref, arXiv and page metadata are first mapped to a `MappedItem` with Zotero field names.
 * `fitToTemplate` then keeps only the fields the item type's template (`GET /items/new`) has; any
 * other mapped field is appended to `extra` as a `Field: value` line, which is Zotero's own
 * convention for data the item type cannot hold.
 */

/** A creator as the metadata mappers produce it: a split name, or a single `name` for organisations. */
export interface MappedCreator {
    creatorType: string
    firstName?:  string
    lastName?:   string
    name?:       string
}

/** Resolved metadata in Zotero terms, before it is fitted to the item type's template. */
export interface MappedItem {
    itemType:      string
    /** Zotero field name → value. Empty values are ignored. */
    fields:        Record<string, string>
    creators:      MappedCreator[]
    /** PDF URLs to try, in order. */
    pdfCandidates: string[]
}

/** A new item's JSON as `POST /items` takes it. */
export type NewItemData = Record<string, unknown> & { itemType: string };

/** Template keys that are never set from mapped metadata. */
const STRUCTURAL_FIELDS = new Set(['itemType', 'creators', 'tags', 'collections', 'relations']);

function shapeCreator(creator: MappedCreator): Record<string, string> {
    return creator.name === undefined
        ? { creatorType: creator.creatorType, firstName: creator.firstName ?? '', lastName: creator.lastName ?? '' }
        : { creatorType: creator.creatorType, name: creator.name };
}

/**
 * Builds a new item from `template` (not mutated): mapped fields the template has are set, others
 * go to `extra` after any mapped `extra`, creators replace the template's placeholder when the type
 * has creators, and `tags`/`collections` come from the caller.
 */
export function fitToTemplate(
    mapped: MappedItem,
    template: Record<string, unknown>,
    options: { tags?: string[], collections?: string[] } = {}
): NewItemData {
    const item: Record<string, unknown> = structuredClone(template);
    const extraLines: string[] = [];
    const overflow: string[] = [];

    for(const [field, value] of Object.entries(mapped.fields)) {
        if(value === '') {
            continue;
        }
        if(field === 'extra') {
            // Stryker disable next-line ArrayMethodSwap -- mapped.fields has at most one 'extra' key, so this pushes at most once; push and unshift are then equivalent
            extraLines.push(value);
        } else if(Object.hasOwn(template, field) && !STRUCTURAL_FIELDS.has(field)) {
            item[field] = value;
        } else {
            overflow.push(`${field}: ${value}`);
        }
    }

    const extra = [...extraLines, ...overflow].join('\n');
    if(extra !== '') {
        item.extra = extra;
    }
    if(Object.hasOwn(template, 'creators')) {
        item.creators = mapped.creators.map(creator => shapeCreator(creator));
    }
    item.tags = (options.tags ?? []).map(tag => ({ tag }));
    item.collections = [...options.collections ?? []];
    return item as NewItemData;
}

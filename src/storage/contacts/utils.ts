import { type ContactBackend } from './backend';
import { createContactId, type ContactId } from './types';

/**
 * Generate a kebab-case personId from a display name.
 * E.g., "Alice Wonderland" → "alice-wonderland"
 */
export function generatePersonId(displayName: string): string {
    return displayName.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '');
}

/**
 * Find an available personId by appending -2, -3, etc. until no collision is found.
 */
export async function findAvailablePersonId(backend: ContactBackend, baseId: string): Promise<ContactId> {
    let candidateId = baseId;
    let suffix = 2;
    // eslint-disable-next-line no-await-in-loop -- sequential: each check depends on the prior candidate
    while(await backend.getContact(createContactId(candidateId))) {
        candidateId = `${baseId}-${suffix}`;
        suffix++;
    }
    return createContactId(candidateId);
}

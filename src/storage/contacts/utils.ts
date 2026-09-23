import { type ContactBackend } from './backend';
import { createPersonId, type PersonId } from './types';

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
export async function findAvailablePersonId(backend: ContactBackend, baseId: string): Promise<PersonId> {
    let candidateId = baseId;
    let suffix = 2;
    // eslint-disable-next-line no-await-in-loop -- sequential: each check depends on the prior candidate
    while(await backend.getContact(createPersonId(candidateId))) {
        candidateId = `${baseId}-${suffix}`;
        suffix++;
    }
    return createPersonId(candidateId);
}

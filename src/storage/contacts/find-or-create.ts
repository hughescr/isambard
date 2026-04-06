import { type ContactBackend } from './backend';
import { type ContactId, type PlatformType } from './types';
import { generatePersonId, findAvailablePersonId } from './utils';

/**
 * Resolve an identifier to an existing contact, or create a new contact if none exists.
 * Used by the allowlist saga and migration script.
 *
 * @param backend - Contact storage backend
 * @param platform - The platform type of the identifier (e.g., 'email', 'bsky')
 * @param value - The identifier value (e.g., 'alice@example.com', 'alice.bsky.social')
 * @param displayName - Display name for the new contact (used only if creating)
 * @param opts - Optional notes for the new contact
 * @returns The personId of the existing or newly created contact
 */
export async function findOrCreateContact(
    backend: ContactBackend,
    platform: PlatformType,
    value: string,
    displayName: string,
    opts?: { notes?: string }
): Promise<ContactId> {
    const matches = await backend.resolveIdentifier(platform, value);
    if(matches.length > 0) {
        return matches[0].personId;
    }

    const baseId   = generatePersonId(displayName);
    const personId = await findAvailablePersonId(backend, baseId);
    const now      = new Date().toISOString();
    await backend.putContact({
        personId,
        displayName,
        identifiers: [{ platform, value }],
        notes:       opts?.notes,
        createdAt:   now,
        updatedAt:   now,
    });
    return personId;
}

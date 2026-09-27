// Types and schemas
export {
    platformTypeSchema,
    contactIdentifierSchema,
    personIdSchema,
    createPersonId,
    normalizeIdentifierValue,
    contactIdentifierKey,
    type ContactIdentifier,
    type ContactIdentifierKey,
    type PersonId,
    type ContactChangeRequest,
    type Contact,
    type PlatformType
} from './types';

// Backend
export { ContactBackend } from './backend';

// Utilities
export { generatePersonId, findAvailablePersonId } from './utils';

// Find or create helper
export { findOrCreateContact } from './find-or-create';

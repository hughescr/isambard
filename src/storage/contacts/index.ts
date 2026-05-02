// Types and schemas
export {
    platformTypeSchema,
    contactIdentifierSchema,
    createContactId,
    type ContactIdentifier,
    type ContactId,
    type Contact,
    type PlatformType
} from './types';

// Backend
export { ContactBackend } from './backend';

// Utilities
export { generatePersonId, findAvailablePersonId } from './utils';

// Find or create helper
export { findOrCreateContact } from './find-or-create';

// Reconciliation
export {
    runContactReconciliation,
    createContactReconciliationScheduler,
    type ContactReconcilerDeps,
    type ContactReconcilerOptions,
    type ContactReconciliationResult,
    type ContactReconciliationConfig,
    type ContactReconciliationSchedulerDeps,
    type ContactReconciliationScheduler
} from './reconciliation';

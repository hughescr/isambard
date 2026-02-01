/**
 * User Registry Module
 *
 * Provides bidirectional username ↔ userId mapping for Discord users.
 */

export { UserRegistry } from './registry';
export {
    UserRegistryError,
    UserNotFoundError,
    AmbiguousUsernameError
} from './errors';
export type {
    UserMetadata
} from './types';
export {
    userMetadataSchema,
    createUserMetadata,
    isUserMetadata
} from './types';

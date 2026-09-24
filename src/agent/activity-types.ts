import { createActivityLogger as createStorageActivityLogger, type ActivityLogger as StorageActivityLogger } from '@/storage';

/** Agent and integration-owned vocabulary for automatically logged activities. */
export type ActivityType
    = | 'email-send-approved' | 'email-sent' | 'email-rejected'
      | 'bsky-reply-approved' | 'bsky-post-sent' | 'bsky-post-rejected'
      | 'bsky-dm-approved' | 'bsky-dm-sent' | 'bsky-dm-rejected'
      | 'discord-exchange'
      | 'perch-start' | 'perch-end'
      | 'catchup-start' | 'catchup-complete';

export type AppActivityLogger = StorageActivityLogger<ActivityType>;
/** Existing agent consumers use the concrete alias, not storage's open generic. */
export { type AppActivityLogger as ActivityLogger };
export const createActivityLogger = createStorageActivityLogger<ActivityType>;

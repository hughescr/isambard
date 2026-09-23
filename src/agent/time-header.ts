/**
 * The product's bound time-header formatter.
 *
 * `src/utils/time.ts`'s `createTimeHeaderFormatter` is pure and has no product-name knowledge
 * (it takes `selfLabel` as a dependency) — this is the one place that binds it to "Izzy", the
 * identity vocabulary owned by the agent layer (see `SESSION_PEER_NAMES` in
 * `src/agent/session/query-options.ts`). Every producer of a time header in this codebase
 * imports {@link formatTimeHeader} from here (or from the `@/agent` barrel), never
 * `createTimeHeaderFormatter` directly.
 *
 * @module agent/time-header
 */
import { createTimeHeaderFormatter } from '@/utils';

/**
 * Formats a time header with UTC, Izzy's timezone, and optionally the user's timezone. See
 * `createTimeHeaderFormatter`'s doc for the exact shape.
 */
export const formatTimeHeader = createTimeHeaderFormatter({ selfLabel: 'Izzy' });

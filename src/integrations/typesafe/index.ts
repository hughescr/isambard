/**
 * TypeSafe integration: the Jev (System One) classifier that judges whether a rejected Discord send
 * is worth retrying. Importable by the composition root only.
 */
export { createJevOutboxFailureClassifier } from './jev-outbox-failure-classifier';
export type { JevOutboxFailureClassifierDeps } from './jev-outbox-failure-classifier';

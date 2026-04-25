/**
 * Re-exports internalFn under a public-looking alias, but the re-export is
 * marked @internal so barrels must not pass it through.
 * @internal
 */
export { internalFn as publicAlias } from './deeper-source';

/** A genuinely public re-export with an alias */
export { internalFn as publicNonInternalAlias } from './deeper-source';

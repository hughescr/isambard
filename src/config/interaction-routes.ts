/**
 * Closed prefix vocabularies for the Discord interaction-route grammar encoded/parsed by
 * `encodeCustomId` / `parseCustomId` (`@/utils`). Each feature owns its own tuple, split by
 * button vs. modal vs. select where relevant, because `bot.ts`'s `routeButton`, `routeModal` and
 * select-menu branch are three independently-gated dispatch points that each register only the
 * prefixes belonging to it.
 *
 * These live in `config` (domain vocabulary) rather than `utils` (pure, domain-free codec) so
 * every consumer that needs them — `services`, `email`, `bsky`, `discord` — can reach them
 * without a boundary violation (`utils` is documented as "no domain knowledge" in
 * eslint-boundaries.config.mjs; a discord-typed module would be unreachable from `services`
 * and `email`).
 */

/** `question:{questionId}:{value}` — the generic answer-button route. */
export const QUESTION_PREFIX = 'question';

/** `contact-{approve,reject,delete-confirm,delete-cancel}:{uuid}` buttons. */
export const CONTACT_PREFIXES = ['contact-approve', 'contact-reject', 'contact-delete-confirm', 'contact-delete-cancel'] as const;

/** `allowlist-{yes,next,create,startmodal}:{sagaId}` buttons. */
export const ALLOWLIST_BUTTON_PREFIXES = ['allowlist-yes', 'allowlist-next', 'allowlist-create', 'allowlist-startmodal'] as const;
/** `allowlist-name:{sagaId}` modal. */
export const ALLOWLIST_MODAL_PREFIXES = ['allowlist-name'] as const;

/** `email-{trash,junk,allow,allowlist}:{uid}:{folder}` inbox-review buttons. */
export const EMAIL_REVIEW_PREFIXES = ['email-trash', 'email-junk', 'email-allow', 'email-allowlist'] as const;
/** `email-send-{approve,approveallowlist,reject}:{uid}` outbound-approval buttons. */
export const EMAIL_SEND_BUTTON_PREFIXES = ['email-send-approve', 'email-send-approveallowlist', 'email-send-reject'] as const;
/** `email-send-reject-reason:{uid}` outbound-rejection modal. */
export const EMAIL_SEND_MODAL_PREFIXES = ['email-send-reject-reason'] as const;
/** `email-allowlist-select:{uid}` select menu. */
export const EMAIL_ALLOWLIST_SELECT_PREFIX = 'email-allowlist-select';

/** `bsky-{send,dm}-{approve,approveallowlist,reject}:{uuid}` outbound-approval buttons. */
export const BSKY_BUTTON_PREFIXES = [
    'bsky-send-approve', 'bsky-send-approveallowlist', 'bsky-send-reject',
    'bsky-dm-approve',   'bsky-dm-approveallowlist',   'bsky-dm-reject',
] as const;
/** `bsky-{send,dm}-reject-reason:{uuid}` outbound-rejection modals. */
export const BSKY_MODAL_PREFIXES = ['bsky-send-reject-reason', 'bsky-dm-reject-reason'] as const;

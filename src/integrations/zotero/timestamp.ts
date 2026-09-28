/**
 * The timestamp format Zotero accepts for date-time fields such as `accessDate` (#157).
 *
 * Zotero's Web API validates with `'accessDate' must be in ISO 8601 or UTC 'YYYY-MM-DD[ hh:mm:ss]'
 * format or 'CURRENT_TIMESTAMP'`, and it rejects the fractional seconds that `Date.toISOString()`
 * always emits. Every timestamp this integration sends goes through here so no call site can
 * regress to the millisecond form.
 */

/** `YYYY-MM-DD hh:mm:ss` in UTC for an epoch-millisecond time; sub-second precision is dropped. */
export function zoteroTimestamp(epochMs: number): string {
    // "YYYY-MM-DDThh:mm:ss.sssZ" -> "YYYY-MM-DD hh:mm:ss"; toISOString is always UTC.
    return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

import type { OperationalStateRead, OperationalStateSchema } from './types';

/**
 * Decodes a stored operational-state `content` attribute: JSON-parses it, then validates it with
 * `schema`. Serves both new `OPERATIONAL_STATE#` rows and legacy `/state/services/...` memory rows,
 * which hold the same wire JSON. Never throws — a non-string or malformed payload is
 * `invalid`/`json`, a schema rejection `invalid`/`schema`, each carrying the underlying error.
 *
 * @internal
 */
export function decodeOperationalState<T>(content: unknown, schema: OperationalStateSchema<T>): Exclude<OperationalStateRead<T>, { status: 'absent' }> {
    if(typeof content !== 'string') {
        return { status: 'invalid', reason: 'json', error: new TypeError(`operational-state content must be a JSON string, got ${typeof content}`) };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (error) {
        return { status: 'invalid', reason: 'json', error };
    }

    try {
        return { status: 'valid', value: schema.parse(parsed) };
    } catch (error) {
        return { status: 'invalid', reason: 'schema', error };
    }
}

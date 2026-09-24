import { describe, test, expect } from 'bun:test';
import { z, ZodError } from 'zod';
import { decodeOperationalState } from '@/storage/operational-state/decode';

const schema = z.object({ n: z.number() });

describe('decodeOperationalState', () => {
    test('a JSON string the schema accepts decodes to a valid read of the parsed value', () => {
        expect(decodeOperationalState('{"n":1}', schema)).toEqual({ status: 'valid', value: { n: 1 } });
    });

    test('numeric content is invalid json with a TypeError naming the content type', () => {
        const read = decodeOperationalState(42, schema);
        expect(read).toEqual({ status: 'invalid', reason: 'json', error: expect.any(TypeError) });
        expect((read as { error: Error }).error.message).toBe('operational-state content must be a JSON string, got number');
        expect(read.value).toBeUndefined();
    });

    test('undefined content is invalid json with a TypeError naming undefined', () => {
        const read = decodeOperationalState(undefined, schema);
        expect(read.status).toBe('invalid');
        expect((read as { reason: string }).reason).toBe('json');
        expect((read as { error: Error }).error).toBeInstanceOf(TypeError);
        expect((read as { error: Error }).error.message).toBe('operational-state content must be a JSON string, got undefined');
    });

    test('malformed JSON is invalid json carrying the SyntaxError', () => {
        const read = decodeOperationalState('{not json', schema);
        expect(read).toEqual({ status: 'invalid', reason: 'json', error: expect.any(SyntaxError) });
        expect(read.value).toBeUndefined();
    });

    test('a schema rejection is invalid schema carrying the exact thrown error', () => {
        const thrown = new ZodError([]);
        const rejecting = { parse: (): never => {
            throw thrown;
        } };
        const read = decodeOperationalState('{"n":"x"}', rejecting);
        expect(read).toEqual({ status: 'invalid', reason: 'schema', error: thrown });
        expect((read as { error: unknown }).error).toBe(thrown);
        expect(read.value).toBeUndefined();
    });

    test('the schema receives the JSON-parsed value, not the raw string', () => {
        const seen: unknown[] = [];
        decodeOperationalState('[1,2]', { parse: (input: unknown) => {
            seen.push(input);
            return input;
        } });
        expect(seen).toEqual([[1, 2]]);
    });
});

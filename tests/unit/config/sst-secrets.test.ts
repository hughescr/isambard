/* eslint-disable n/no-sync -- reads the real sst/secrets.ts: node:fs/promises is globally mocked in tests/setup.ts */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// sst/secrets.ts only runs inside SST's Pulumi program, where `sst.Secret` is a global, so it cannot
// be imported here; this reads its source instead. An `sst.Secret` with no placeholder throws
// SecretMissingError when it has not been set, which stops `sst dev`, `sst shell` and `sst deploy`.
// An optional integration's secret therefore needs an empty placeholder, so "unset" really means
// "off" (loadConfig treats '' as not configured).
const SECRETS = readFileSync(path.join(import.meta.dir, '../../../sst/secrets.ts'), 'utf8');

describe('sst/secrets.ts', () => {
    test('the optional Zotero key has an empty placeholder, so leaving it unset turns Zotero off instead of breaking startup', () => {
        expect(SECRETS).toContain('new sst.Secret(\'ZoteroApiKey\', \'\')');
    });
});

/* eslint-disable @typescript-eslint/triple-slash-reference -- SST requires triple-slash reference for config types */
/// <reference path="./.sst/platform/config.d.ts" />
/* eslint-enable @typescript-eslint/triple-slash-reference -- Re-enable rule after required SST reference */

export default $config({
    app(input) {
        return {
            name:      'isambard',
            removal:   input?.stage === 'production' ? 'retain' : 'remove',
            protect:   ['production'].includes(input?.stage),
            home:      'aws',
            providers: {
                aws: {
                    region:      'us-west-2',
                    defaultTags: {
                        tags: {
                            'sst:app':   'isambard',
                            'sst:stage': input?.stage ?? 'dev',
                        },
                    },
                },
            },
        };
    },
    async run() {
    // Import secrets first to ensure they exist
        const secrets = await import('./sst/secrets');

        // Import non-secret configuration
        const { config } = await import('./sst/config');

        // Import infrastructure
        const { memoryTable } = await import('./sst/dynamo');

        // SST prints every top-level output after a deploy, and `secret.value` is the
        // decrypted secret itself, so never output anything derived from `.value` here.
        // `secret.name` is just the plain string passed to `new sst.Secret(...)`, so it's
        // safe to print; this lists every secret's SST name (for `sst secret set <name>`)
        // automatically as secrets are added to ./sst/secrets.
        const secretNames = Object.values(secrets).map(secret => secret.name);

        return {
            memoryTable: memoryTable.name,
            secretNames,
            config,
        };
    },
});

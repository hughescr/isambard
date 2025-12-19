/* eslint-disable @typescript-eslint/triple-slash-reference -- SST requires triple-slash reference for config types */
/// <reference path="./.sst/platform/config.d.ts" />
/* eslint-enable @typescript-eslint/triple-slash-reference -- Re-enable rule after required SST reference */

export default $config({
  app(input: any) {
    return {
      name: 'isambard',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: {
        aws: { region: 'us-west-2' },
      },
    };
  },
  async run() {
    // Import secrets first to ensure they exist
    await import('./sst/secrets');

    // Import non-secret configuration
    await import('./sst/config');

    // Import infrastructure
    const { memoryTable } = await import('./sst/dynamo');

    return {
      memoryTable: memoryTable.name,
    };
  },
});

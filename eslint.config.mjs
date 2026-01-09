import config from '@hughescr/eslint-config-default';

export default [
    ...config,
    {
        ignores: ['scratch/', 'dist/', 'node_modules/', '.stryker-tmp/', 'reports/', '.sst/', 'sst.config.ts', 'sst/**/*', 'sst-env.d.ts', 'plugins/**']
    },
    {
        rules: {
            'n/no-missing-import':     'off',
            'n/no-unpublished-import': 'off'
        }
    }
];

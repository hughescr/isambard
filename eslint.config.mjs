import config from '@hughescr/eslint-config-default';

export default [
    ...config,
    {
        ignores: [
            'scratch/', // Izzy's work area

            'dist/',
            'node_modules/',

            '.stryker-tmp/',
            'reports/',

            '.serena/',

            '.claude/',

            '.sst/',
            'sst/',
            'sst.config.ts',
            'sst-env.d.ts'
        ]
    },
    {
        rules: {
            'n/no-missing-import':     'off',
            'n/no-unpublished-import': 'off'
        }
    }
];

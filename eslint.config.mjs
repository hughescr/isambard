// eslint-disable-next-line n/no-unpublished-import -- This is a devDependency
import config from '@hughescr/eslint-config-default';

export default [
    ...config,
    {
        ignores: ['dist/', 'node_modules/', '.stryker-tmp/', 'sst.config.ts', 'sst/**/*']
    }
];

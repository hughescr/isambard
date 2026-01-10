import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { homedir } from 'node:os';
import _ from 'lodash';
import { mockLogger, mockFsPromises, resetMockFsPrefix } from '../../setup';
import { loadPlugins, resolveExternalPath, findLatestMarketplaceVersion } from '@/agent/plugin-loader';

// Helper to create mock directory structures in the in-memory filesystem
async function createMockPluginDir(basePath: string): Promise<void> {
    await mockFsPromises.mkdir(join(basePath, '.claude-plugin'), { recursive: true });
    await mockFsPromises.writeFile(join(basePath, '.claude-plugin', 'plugin.json'), '{}');
}

describe.concurrent('resolveExternalPath', () => {
    test('should expand ~ to home directory', () => {
        const homeDir = homedir();
        const result = resolveExternalPath('~/my-plugin');
        expect(result).toBe(join(homeDir, 'my-plugin'));
    });

    test('should preserve absolute paths', () => {
        const result = resolveExternalPath('/absolute/path/to/plugin');
        expect(result).toBe('/absolute/path/to/plugin');
    });

    test('should expand ~ at start of path only', () => {
        const homeDir = homedir();
        const result = resolveExternalPath('~/path/with/~/tilde');
        expect(result).toBe(join(homeDir, 'path/with/~/tilde'));
    });

    test('should return empty string for empty input', () => {
        const result = resolveExternalPath('');
        expect(result).toBe('');
    });

    test('should expand exact ~ to home directory', () => {
        const homeDir = homedir();
        const result = resolveExternalPath('~');
        expect(result).toBe(homeDir);
    });

    test('should not expand ~ in middle of path', () => {
        const result = resolveExternalPath('/path/~/foo');
        expect(result).toBe('/path/~/foo');
    });

    test('should preserve relative paths without tilde', () => {
        const result = resolveExternalPath('./relative/path');
        expect(result).toBe('./relative/path');
    });

    test('should preserve relative parent paths', () => {
        const result = resolveExternalPath('../relative/path');
        expect(result).toBe('../relative/path');
    });
});

describe('findLatestMarketplaceVersion', () => {
    const tempDir = '/mock-find-version';

    beforeEach(async () => {
        resetMockFsPrefix('/mock-find-version');
        await mockFsPromises.mkdir(tempDir, { recursive: true });
    });

    test('should return undefined for non-existent plugin directory', async () => {
        const result = await findLatestMarketplaceVersion('/nonexistent/path', 'test-plugin');
        expect(result).toBeUndefined();
    });

    test('should return the single version if only one exists', async () => {
        const pluginDir = join(tempDir, 'test-plugin');
        const versionDir = join(pluginDir, '1.0.0');
        await createMockPluginDir(versionDir);

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        expect(result).toBe(versionDir);
    });

    test('should return the latest semver version when multiple exist', async () => {
        const pluginDir = join(tempDir, 'test-plugin');
        const version1 = join(pluginDir, '1.0.0');
        const version2 = join(pluginDir, '2.0.0');
        const version3 = join(pluginDir, '1.5.0');

        await createMockPluginDir(version1);
        await createMockPluginDir(version2);
        await createMockPluginDir(version3);

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        expect(result).toBe(version2);
    });

    test('should handle prerelease versions correctly', async () => {
        const pluginDir = join(tempDir, 'test-plugin');
        const release = join(pluginDir, '1.0.0');
        const prerelease = join(pluginDir, '1.0.1-beta.1');

        await createMockPluginDir(release);
        await createMockPluginDir(prerelease);

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        // Prerelease is lower than release in semver
        expect(result).toBe(prerelease);
    });

    test('should skip directories without .claude-plugin', async () => {
        const pluginDir = join(tempDir, 'test-plugin');
        const validVersion = join(pluginDir, '1.0.0');
        const invalidVersion = join(pluginDir, '2.0.0');

        await createMockPluginDir(validVersion);
        await mockFsPromises.mkdir(invalidVersion, { recursive: true });
        // No .claude-plugin directory in invalidVersion

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        expect(result).toBe(validVersion);
    });

    test('should return undefined if no valid version directories exist', async () => {
        const pluginDir = join(tempDir, 'test-plugin');
        await mockFsPromises.mkdir(pluginDir, { recursive: true });
        // Create a directory without .claude-plugin
        await mockFsPromises.mkdir(join(pluginDir, '1.0.0'), { recursive: true });

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        expect(result).toBeUndefined();
    });

    test('should skip non-semver directory names', async () => {
        const pluginDir = join(tempDir, 'test-plugin');
        const validVersion = join(pluginDir, '1.0.0');
        const invalidName = join(pluginDir, 'not-a-version');

        await createMockPluginDir(validVersion);
        await createMockPluginDir(invalidName);

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        expect(result).toBe(validVersion);
    });

    test('should ignore files when scanning for version directories', async () => {
        const pluginDir = join(tempDir, 'test-plugin');
        const validVersion = join(pluginDir, '1.0.0');
        await createMockPluginDir(validVersion);

        // Create a file (not a directory) with a semver name
        await mockFsPromises.writeFile(join(pluginDir, '2.0.0'), 'this is a file not a directory');

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        expect(result).toBe(validVersion);
    });

    test('should skip invalid semver versions (missing patch)', async () => {
        const pluginDir = join(tempDir, 'test-plugin');
        const validVersion = join(pluginDir, '1.0.0');
        const invalidSemver = join(pluginDir, '1.2'); // Missing patch version

        await createMockPluginDir(validVersion);
        await createMockPluginDir(invalidSemver);

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        expect(result).toBe(validVersion);
    });

    test('should return undefined when all versions are invalid', async () => {
        const pluginDir = join(tempDir, 'test-plugin');
        const invalidSemver1 = join(pluginDir, '1.2');
        const invalidSemver2 = join(pluginDir, 'not-a-version');

        await createMockPluginDir(invalidSemver1);
        await createMockPluginDir(invalidSemver2);

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        expect(result).toBeUndefined();
    });

    test('should handle versions with prerelease metadata', async () => {
        const pluginDir = join(tempDir, 'test-plugin');
        const version1 = join(pluginDir, '1.0.0-alpha.1');
        const version2 = join(pluginDir, '1.0.0-beta.1');

        await createMockPluginDir(version1);
        await createMockPluginDir(version2);

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        // beta comes after alpha in semver
        expect(result).toBe(version2);
    });

    test('should handle versions with build metadata', async () => {
        const pluginDir = join(tempDir, 'test-plugin');
        const version1 = join(pluginDir, '1.0.0+build.1');
        const version2 = join(pluginDir, '1.0.0+build.2');

        await createMockPluginDir(version1);
        await createMockPluginDir(version2);

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        // Build metadata doesn't affect precedence, but we should handle it
        expect(result).toBeDefined();
        // Non-null assertion safe since we verified toBeDefined
        expect([version1, version2]).toContain(result!);
    });
});

describe('loadPlugins', () => {
    const tempDir = '/mock-load-plugins';
    const pluginsDir = join(tempDir, 'plugins');
    const marketplaceDir = join(tempDir, '.claude', 'plugins');

    beforeEach(async () => {
        resetMockFsPrefix('/mock-load-plugins');
        await mockFsPromises.mkdir(pluginsDir, { recursive: true });
        await mockFsPromises.mkdir(marketplaceDir, { recursive: true });

        // Create default empty plugins.json
        await mockFsPromises.writeFile(
            join(pluginsDir, 'plugins.json'),
            JSON.stringify({ externalPaths: [], marketplace: [] })
        );

        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
    });

    describe('in-repo plugin discovery', () => {
        test('should discover in-repo plugins with .claude-plugin directory', async () => {
            const inRepoPlugin = join(pluginsDir, 'my-custom-plugin');
            await createMockPluginDir(inRepoPlugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: inRepoPlugin });
        });

        test('should ignore directories without .claude-plugin and warn', async () => {
            const notAPlugin = join(pluginsDir, 'not-a-plugin');
            await mockFsPromises.mkdir(notAPlugin, { recursive: true });
            await mockFsPromises.writeFile(join(notAPlugin, 'some-file.txt'), 'content');

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: 'not-a-plugin',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Test matcher
                    msg:  expect.stringContaining('not a valid plugin'),
                })
            );
        });

        test('should discover multiple in-repo plugins', async () => {
            const plugin1 = join(pluginsDir, 'plugin-one');
            const plugin2 = join(pluginsDir, 'plugin-two');

            await createMockPluginDir(plugin1);
            await createMockPluginDir(plugin2);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(2);
            const paths = _.map(result, 'path');
            expect(paths).toContain(plugin1);
            expect(paths).toContain(plugin2);
        });

        test('should skip plugins.json file when scanning for in-repo plugins', async () => {
            // plugins.json exists by default, ensure it is not treated as a plugin
            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(0);
        });

        test('should skip README.md when scanning for in-repo plugins', async () => {
            await mockFsPromises.writeFile(join(pluginsDir, 'README.md'), '# Plugins');

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(0);
        });
    });

    describe('external path resolution', () => {
        test('should load external plugins from absolute paths', async () => {
            const externalPlugin = join(tempDir, 'external-plugin');
            await createMockPluginDir(externalPlugin);

            await mockFsPromises.writeFile(
                join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [externalPlugin], marketplace: [] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: externalPlugin });
        });

        test('should warn and skip missing external paths', async () => {
            await mockFsPromises.writeFile(
                join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: ['/nonexistent/plugin'], marketplace: [] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: '/nonexistent/plugin',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:  expect.stringContaining('not found'),
                })
            );
        });

        test('should warn and skip external paths without .claude-plugin directory', async () => {
            const invalidPlugin = join(tempDir, 'invalid-plugin');
            await mockFsPromises.mkdir(invalidPlugin, { recursive: true });
            // No .claude-plugin directory

            await mockFsPromises.writeFile(
                join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [invalidPlugin], marketplace: [] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: invalidPlugin,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:  expect.stringContaining('missing .claude-plugin'),
                })
            );
        });
    });

    describe('marketplace plugin resolution', () => {
        test('should load marketplace plugins with latest version', async () => {
            const marketplacePlugin = join(marketplaceDir, 'cool-plugin', '1.0.0');
            await createMockPluginDir(marketplacePlugin);

            await mockFsPromises.writeFile(
                join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [], marketplace: ['cool-plugin'] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: marketplacePlugin });
        });

        test('should select latest version when multiple exist', async () => {
            const v1 = join(marketplaceDir, 'versioned-plugin', '1.0.0');
            const v2 = join(marketplaceDir, 'versioned-plugin', '2.0.0');

            await createMockPluginDir(v1);
            await createMockPluginDir(v2);

            await mockFsPromises.writeFile(
                join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [], marketplace: ['versioned-plugin'] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: v2 });
        });

        test('should warn and skip missing marketplace plugins', async () => {
            await mockFsPromises.writeFile(
                join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [], marketplace: ['nonexistent-plugin'] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: 'nonexistent-plugin',
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg:  expect.stringContaining('not found'),
                })
            );
        });
    });

    describe('priority and deduplication', () => {
        test('should prioritize in-repo over external path with same name', async () => {
            const inRepoPlugin = join(pluginsDir, 'shared-plugin');
            const externalPlugin = join(tempDir, 'shared-plugin');

            await createMockPluginDir(inRepoPlugin);
            await createMockPluginDir(externalPlugin);

            await mockFsPromises.writeFile(
                join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [externalPlugin], marketplace: [] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: inRepoPlugin });
        });

        test('should prioritize in-repo over marketplace with same name', async () => {
            const inRepoPlugin = join(pluginsDir, 'shared-plugin');
            const marketplacePlugin = join(marketplaceDir, 'shared-plugin', '1.0.0');

            await createMockPluginDir(inRepoPlugin);
            await createMockPluginDir(marketplacePlugin);

            await mockFsPromises.writeFile(
                join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [], marketplace: ['shared-plugin'] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: inRepoPlugin });
        });

        test('should prioritize external over marketplace with same name', async () => {
            const externalPlugin = join(tempDir, 'shared-plugin');
            const marketplacePlugin = join(marketplaceDir, 'shared-plugin', '1.0.0');

            await createMockPluginDir(externalPlugin);
            await createMockPluginDir(marketplacePlugin);

            await mockFsPromises.writeFile(
                join(pluginsDir, 'plugins.json'),
                JSON.stringify({
                    externalPaths: [externalPlugin],
                    marketplace:   ['shared-plugin'],
                })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: externalPlugin });
        });

        test('should load plugins from all sources when no duplicates', async () => {
            const inRepoPlugin = join(pluginsDir, 'in-repo-plugin');
            const externalPlugin = join(tempDir, 'external-plugin');
            const marketplacePlugin = join(marketplaceDir, 'marketplace-plugin', '1.0.0');

            await createMockPluginDir(inRepoPlugin);
            await createMockPluginDir(externalPlugin);
            await createMockPluginDir(marketplacePlugin);

            await mockFsPromises.writeFile(
                join(pluginsDir, 'plugins.json'),
                JSON.stringify({
                    externalPaths: [externalPlugin],
                    marketplace:   ['marketplace-plugin'],
                })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(3);
            const paths = _.map(result, 'path');
            expect(paths).toContain(inRepoPlugin);
            expect(paths).toContain(externalPlugin);
            expect(paths).toContain(marketplacePlugin);
        });
    });

    describe('error handling', () => {
        test('should handle missing plugins.json gracefully', async () => {
            await mockFsPromises.rm(join(pluginsDir, 'plugins.json'));

            const inRepoPlugin = join(pluginsDir, 'in-repo-plugin');
            await createMockPluginDir(inRepoPlugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            // Should still find in-repo plugins
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: inRepoPlugin });
        });

        test('should handle invalid JSON in plugins.json', async () => {
            await mockFsPromises.writeFile(join(pluginsDir, 'plugins.json'), '{ invalid json }');

            const inRepoPlugin = join(pluginsDir, 'in-repo-plugin');
            await createMockPluginDir(inRepoPlugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            // Should warn and continue with in-repo plugins only
            expect(result).toHaveLength(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg: expect.stringContaining('Failed to parse plugins.json'),
                })
            );
        });

        test('should handle null value in plugins.json', async () => {
            await mockFsPromises.writeFile(join(pluginsDir, 'plugins.json'), 'null');

            const inRepoPlugin = join(pluginsDir, 'in-repo-plugin');
            await createMockPluginDir(inRepoPlugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            // Should warn and use defaults
            expect(result).toHaveLength(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg: expect.stringContaining('Invalid plugins.json schema'),
                })
            );
        });

        test('should handle array in plugins.json', async () => {
            await mockFsPromises.writeFile(join(pluginsDir, 'plugins.json'), '[]');

            const inRepoPlugin = join(pluginsDir, 'in-repo-plugin');
            await createMockPluginDir(inRepoPlugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            // Should warn and use defaults
            expect(result).toHaveLength(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg: expect.stringContaining('Invalid plugins.json schema'),
                })
            );
        });

        test('should handle empty object in plugins.json', async () => {
            await mockFsPromises.writeFile(join(pluginsDir, 'plugins.json'), '{}');

            const inRepoPlugin = join(pluginsDir, 'in-repo-plugin');
            await createMockPluginDir(inRepoPlugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            // Empty object should be valid with defaults applied
            expect(result).toHaveLength(1);
        });

        test('should handle missing externalPaths field', async () => {
            await mockFsPromises.writeFile(join(pluginsDir, 'plugins.json'), JSON.stringify({ marketplace: [] }));

            const inRepoPlugin = join(pluginsDir, 'in-repo-plugin');
            await createMockPluginDir(inRepoPlugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            // Should use default empty array for externalPaths
            expect(result).toHaveLength(1);
        });

        test('should handle missing marketplace field', async () => {
            await mockFsPromises.writeFile(join(pluginsDir, 'plugins.json'), JSON.stringify({ externalPaths: [] }));

            const inRepoPlugin = join(pluginsDir, 'in-repo-plugin');
            await createMockPluginDir(inRepoPlugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            // Should use default empty array for marketplace
            expect(result).toHaveLength(1);
        });

        test('should handle invalid schema in plugins.json (wrong types)', async () => {
            await mockFsPromises.writeFile(
                join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: 'not-an-array', marketplace: 123 })
            );

            const inRepoPlugin = join(pluginsDir, 'in-repo-plugin');
            await createMockPluginDir(inRepoPlugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            // Should warn about invalid schema and use defaults
            expect(result).toHaveLength(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.stringContaining returns AsymmetricMatcher
                    msg: expect.stringContaining('Invalid plugins.json schema'),
                })
            );
        });

        test('should handle missing plugins directory gracefully', async () => {
            await mockFsPromises.rm(pluginsDir, { recursive: true, force: true });

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(0);
        });

        test('should handle missing marketplace directory gracefully', async () => {
            await mockFsPromises.rm(marketplaceDir, { recursive: true, force: true });

            await mockFsPromises.writeFile(
                join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [], marketplace: ['some-plugin'] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(0);
            expect(mockLogger.warn).toHaveBeenCalled();
        });
    });

    describe('return type structure', () => {
        test('should return PluginEntry objects with type and path', async () => {
            const plugin = join(pluginsDir, 'test-plugin');
            await createMockPluginDir(plugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toHaveProperty('type', 'local');
            expect(result[0]).toHaveProperty('path', plugin);
        });

        test('should return empty array when no plugins found', async () => {
            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toEqual([]);
        });
    });
});

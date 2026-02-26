import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, test, expect, beforeEach } from 'bun:test';
import _ from 'lodash';
import { mockLogger, mockFsPromises, resetMockFsPrefix } from '../../setup';
import { loadPlugins, resolveExternalPath, findLatestMarketplaceVersion } from '@/agent/plugin-loader';

// Helper to create mock directory structures in the in-memory filesystem
async function createMockPluginDir(basePath: string): Promise<void> {
    await mockFsPromises.mkdir(join(basePath, '.claude-plugin'), { recursive: true });
    await mockFsPromises.writeFile(join(basePath, '.claude-plugin', 'plugin.json'), '{}');
}

describe('resolveExternalPath', () => {
    test.each([
        ['~/my-plugin', join(homedir(), 'my-plugin'), 'expand ~ to home directory'],
        ['~', homedir(), 'expand exact ~ to home directory'],
        ['~/path/with/~/tilde', join(homedir(), 'path/with/~/tilde'), 'expand ~ at start only, preserve internal ~'],
        ['/absolute/path/to/plugin', '/absolute/path/to/plugin', 'preserve absolute paths'],
        ['/path/~/foo', '/path/~/foo', 'not expand ~ in middle of path'],
        ['./relative/path', './relative/path', 'preserve relative paths'],
        ['../relative/path', '../relative/path', 'preserve relative parent paths'],
        ['', '', 'return empty string for empty input'],
    ])('should %s', (input, expected) => {
        const result = resolveExternalPath(input);
        expect(result).toBe(expected);
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

    test.each([
        ['single version', ['1.0.0'], '1.0.0'],
        ['multiple versions', ['1.0.0', '2.0.0', '1.5.0'], '2.0.0'],
        ['prerelease versions', ['1.0.0', '1.0.1-beta.1'], '1.0.1-beta.1'],
        ['alpha vs beta', ['1.0.0-alpha.1', '1.0.0-beta.1'], '1.0.0-beta.1'],
    ])('should return latest from %s', async (_desc, versions, expected) => {
        const pluginDir = join(tempDir, 'test-plugin');

        for(const version of versions) {
            await createMockPluginDir(join(pluginDir, version));
        }

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        expect(result).toBe(join(pluginDir, expected));
    });

    test.each([
        [
            'directories without .claude-plugin',
            async (pluginDir: string) => {
                await createMockPluginDir(join(pluginDir, '1.0.0'));
                await mockFsPromises.mkdir(join(pluginDir, '2.0.0'), { recursive: true });
            },
            join(tempDir, 'test-plugin', '1.0.0'),
        ],
        [
            'non-semver directory names',
            async (pluginDir: string) => {
                await createMockPluginDir(join(pluginDir, '1.0.0'));
                await createMockPluginDir(join(pluginDir, 'not-a-version'));
            },
            join(tempDir, 'test-plugin', '1.0.0'),
        ],
        [
            'invalid semver (missing patch)',
            async (pluginDir: string) => {
                await createMockPluginDir(join(pluginDir, '1.0.0'));
                await createMockPluginDir(join(pluginDir, '1.2'));
            },
            join(tempDir, 'test-plugin', '1.0.0'),
        ],
        [
            'files instead of directories',
            async (pluginDir: string) => {
                await createMockPluginDir(join(pluginDir, '1.0.0'));
                await mockFsPromises.writeFile(join(pluginDir, '2.0.0'), 'file');
            },
            join(tempDir, 'test-plugin', '1.0.0'),
        ],
        [
            '.claude-plugin as file not directory',
            async (pluginDir: string) => {
                await mockFsPromises.mkdir(join(pluginDir, '1.0.0'), { recursive: true });
                await mockFsPromises.writeFile(join(pluginDir, '1.0.0', '.claude-plugin'), 'file');
            },
            undefined,
        ],
    ])('should skip %s', async (_desc, setup, expected) => {
        const pluginDir = join(tempDir, 'test-plugin');
        await setup(pluginDir);

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        expect(result).toBe(expected);
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
        test('should use empty config defaults when plugins.json is missing without warning', async () => {
            await mockFsPromises.rm(join(pluginsDir, 'plugins.json'));

            // Create marketplace plugin that would be loaded IF config existed
            const marketplacePlugin = join(marketplaceDir, 'marketplace-plugin', '1.0.0');
            await createMockPluginDir(marketplacePlugin);

            // Create external plugin that would be loaded IF config existed
            const externalPlugin = join(tempDir, 'external-plugin');
            await createMockPluginDir(externalPlugin);

            const inRepoPlugin = join(pluginsDir, 'in-repo-plugin');
            await createMockPluginDir(inRepoPlugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            // Should ONLY find in-repo plugins because config defaults to empty arrays
            // External and marketplace plugins should NOT be loaded without config
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: inRepoPlugin });

            // CRITICAL: No warning should be logged when file is simply missing
            // This is the key difference from the catch block which DOES log warnings
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test.each([
            ['invalid JSON', async () => {
                await mockFsPromises.writeFile(join(pluginsDir, 'plugins.json'), '{ invalid json }');
            }, 'Failed to parse plugins.json'],
            ['null value', async () => {
                await mockFsPromises.writeFile(join(pluginsDir, 'plugins.json'), 'null');
            }, 'Invalid plugins.json schema'],
            ['array value', async () => {
                await mockFsPromises.writeFile(join(pluginsDir, 'plugins.json'), '[]');
            }, 'Invalid plugins.json schema'],
            ['wrong field types', async () => {
                await mockFsPromises.writeFile(
                    join(pluginsDir, 'plugins.json'),
                    JSON.stringify({ externalPaths: 'not-an-array', marketplace: 123 })
                );
            }, 'Invalid plugins.json schema'],
            ['empty object', async () => {
                await mockFsPromises.writeFile(join(pluginsDir, 'plugins.json'), '{}');
            }, null],
            ['missing externalPaths field', async () => {
                await mockFsPromises.writeFile(join(pluginsDir, 'plugins.json'), JSON.stringify({ marketplace: [] }));
            }, null],
            ['missing marketplace field', async () => {
                await mockFsPromises.writeFile(join(pluginsDir, 'plugins.json'), JSON.stringify({ externalPaths: [] }));
            }, null],
        ])('should handle %s', async (_desc, setup, expectedWarning) => {
            await setup();

            const inRepoPlugin = join(pluginsDir, 'in-repo-plugin');
            await createMockPluginDir(inRepoPlugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            // Should still find in-repo plugins
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: inRepoPlugin });

            if(expectedWarning) {
                expect(mockLogger.warn).toHaveBeenCalledWith(
                    expect.objectContaining({
                        msg: expect.stringContaining(expectedWarning),
                    })
                );
            }
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
        });
    });
});

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { homedir } from 'node:os';
import path from 'node:path';
import { mockLogger, mockFsPromises, resetMockFsPrefix } from '../../setup';
import { loadPlugins, resolveExternalPath, findLatestMarketplaceVersion } from '@/agent/plugin-loader';

// Helper to create mock directory structures in the in-memory filesystem
async function createMockPluginDir(basePath: string): Promise<void> {
    await mockFsPromises.mkdir(path.join(basePath, '.claude-plugin'), { recursive: true });
    await mockFsPromises.writeFile(path.join(basePath, '.claude-plugin', 'plugin.json'), '{}');
}

// Flushes pending microtasks without a real timer, so p-limit's internal Promise chain
// (enqueue -> internal resolve -> .then(run)) has a chance to settle deterministically.
async function flushMicrotasks(remaining: number): Promise<void> {
    if(remaining > 0) {
        await Promise.resolve();
        await flushMicrotasks(remaining - 1);
    }
}

describe('resolveExternalPath', () => {
    test.each([
        ['~/my-plugin', path.join(homedir(), 'my-plugin'), 'expand ~ to home directory'],
        ['~', homedir(), 'expand exact ~ to home directory'],
        ['~/path/with/~/tilde', path.join(homedir(), 'path/with/~/tilde'), 'expand ~ at start only, preserve internal ~'],
        ['/absolute/path/to/plugin', '/absolute/path/to/plugin', 'preserve absolute paths'],
        ['/path/~/foo', '/path/~/foo', 'not expand ~ in middle of path'],
        ['./relative/path', './relative/path', 'preserve relative paths'],
        ['../relative/path', '../relative/path', 'preserve relative parent paths'],
        ['', '', 'return empty string for empty input'],
        ['~foo', '~foo', 'not expand a bare ~name with no following slash'],
        [String.raw`~\subdir`, String.raw`~\subdir`, 'not expand ~ followed by a backslash (only ~/ triggers expansion)'],
        ['~ ', '~ ', 'not expand ~ followed by whitespace instead of a slash'],
        ['~/', homedir(), 'expand ~/ with nothing after it to exactly the home directory'],
        ['~//', path.join(homedir(), '/'), 'expand ~// the same way path.join normalizes a doubled separator'],
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

    afterEach(() => {
        resetMockFsPrefix('/mock-find-version');
    });

    test('should return undefined for non-existent plugin directory', async () => {
        const result = await findLatestMarketplaceVersion('/nonexistent/path', 'test-plugin');
        expect(result).toBeUndefined();
    });

    test('does not accept a manifest that access denies even when stat can see its directory', async () => {
        const pluginDir = path.join(tempDir, 'access-denied');
        const versionDir = path.join(pluginDir, '1.0.0');
        const manifestDir = path.join(versionDir, '.claude-plugin');
        await createMockPluginDir(versionDir);
        mockFsPromises.access.mockImplementation(async (checkedPath) => {
            if(checkedPath === manifestDir) {
                throw new Error('EACCES');
            }
        });
        expect(await findLatestMarketplaceVersion(tempDir, 'access-denied')).toBeUndefined();
    });

    test('does not accept a manifest when stat fails after access succeeds', async () => {
        const pluginDir = path.join(tempDir, 'stat-failed');
        const versionDir = path.join(pluginDir, '1.0.0');
        await createMockPluginDir(versionDir);
        mockFsPromises.stat.mockRejectedValueOnce(new Error('stat failed'));
        expect(await findLatestMarketplaceVersion(tempDir, 'stat-failed')).toBeUndefined();
    });

    test('ignores a semver-named symbolic link even when its target has a plugin manifest', async () => {
        const pluginDir = path.join(tempDir, 'linked-plugin');
        const validVersion = path.join(pluginDir, '1.0.0');
        const linkedVersion = path.join(pluginDir, '9.0.0');
        await createMockPluginDir(validVersion);
        await mockFsPromises.symlink('/outside/plugin', linkedVersion);
        await mockFsPromises.mkdir(path.join(linkedVersion, '.claude-plugin'), { recursive: true });
        expect(await findLatestMarketplaceVersion(tempDir, 'linked-plugin')).toBe(validVersion);
    });

    test.each([
        ['single version', ['1.0.0'], '1.0.0'],
        ['multiple versions', ['1.0.0', '2.0.0', '1.5.0'], '2.0.0'],
        ['prerelease versions', ['1.0.0', '1.0.1-beta.1'], '1.0.1-beta.1'],
        ['alpha vs beta', ['1.0.0-alpha.1', '1.0.0-beta.1'], '1.0.0-beta.1'],
    ])('should return latest from %s', async (_desc, versions, expected) => {
        const pluginDir = path.join(tempDir, 'test-plugin');

        await Promise.all(versions.map(version => createMockPluginDir(path.join(pluginDir, version))));

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        expect(result).toBe(path.join(pluginDir, expected));
    });

    test('sorts versions by their semver directory names rather than plugin name', async () => {
        const pluginDir = path.join(tempDir, 'test-plugin');
        await Promise.all(['2.0.0', '1.0.0'].map(version => createMockPluginDir(path.join(pluginDir, version))));

        expect(await findLatestMarketplaceVersion(tempDir, 'test-plugin')).toBe(path.join(pluginDir, '2.0.0'));
    });

    test.each([
        [
            'directories without .claude-plugin',
            async (pluginDir: string) => {
                await createMockPluginDir(path.join(pluginDir, '1.0.0'));
                await mockFsPromises.mkdir(path.join(pluginDir, '2.0.0'), { recursive: true });
            },
            path.join(tempDir, 'test-plugin', '1.0.0'),
        ],
        [
            'non-semver directory names',
            async (pluginDir: string) => {
                await createMockPluginDir(path.join(pluginDir, '1.0.0'));
                await createMockPluginDir(path.join(pluginDir, 'not-a-version'));
            },
            path.join(tempDir, 'test-plugin', '1.0.0'),
        ],
        [
            'invalid semver (missing patch)',
            async (pluginDir: string) => {
                await createMockPluginDir(path.join(pluginDir, '1.0.0'));
                await createMockPluginDir(path.join(pluginDir, '1.2'));
            },
            path.join(tempDir, 'test-plugin', '1.0.0'),
        ],
        [
            'files instead of directories',
            async (pluginDir: string) => {
                await createMockPluginDir(path.join(pluginDir, '1.0.0'));
                await mockFsPromises.writeFile(path.join(pluginDir, '2.0.0'), 'file');
            },
            path.join(tempDir, 'test-plugin', '1.0.0'),
        ],
        [
            '.claude-plugin as file not directory',
            async (pluginDir: string) => {
                await mockFsPromises.mkdir(path.join(pluginDir, '1.0.0'), { recursive: true });
                await mockFsPromises.writeFile(path.join(pluginDir, '1.0.0', '.claude-plugin'), 'file');
            },
            undefined,
        ],
    ])('should skip %s', async (_desc, setup, expected) => {
        const pluginDir = path.join(tempDir, 'test-plugin');
        await setup(pluginDir);

        const result = await findLatestMarketplaceVersion(tempDir, 'test-plugin');
        expect(result).toBe(expected);
    });

    test('should handle versions with build metadata', async () => {
        const pluginDir = path.join(tempDir, 'test-plugin');
        const version1 = path.join(pluginDir, '1.0.0+build.1');
        const version2 = path.join(pluginDir, '1.0.0+build.2');

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
    const pluginsDir = path.join(tempDir, 'plugins');
    const marketplaceDir = path.join(tempDir, '.claude', 'plugins');

    beforeEach(async () => {
        resetMockFsPrefix('/mock-load-plugins');
        await mockFsPromises.mkdir(pluginsDir, { recursive: true });
        await mockFsPromises.mkdir(marketplaceDir, { recursive: true });

        // Create default empty plugins.json
        await mockFsPromises.writeFile(
            path.join(pluginsDir, 'plugins.json'),
            JSON.stringify({ externalPaths: [], marketplace: [] })
        );

        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
    });

    afterEach(() => {
        resetMockFsPrefix('/mock-load-plugins');
    });

    describe('in-repo plugin discovery', () => {
        test('ignores regular files and reports no invalid-plugin warning for them', async () => {
            await mockFsPromises.writeFile(path.join(pluginsDir, 'README.md'), '# plugins');
            expect(await loadPlugins(pluginsDir, marketplaceDir)).toEqual([]);
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test('should discover in-repo plugins with .claude-plugin directory', async () => {
            const inRepoPlugin = path.join(pluginsDir, 'my-custom-plugin');
            await createMockPluginDir(inRepoPlugin);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: inRepoPlugin });
        });

        test('should ignore directories without .claude-plugin and warn', async () => {
            const notAPlugin = path.join(pluginsDir, 'not-a-plugin');
            await mockFsPromises.mkdir(notAPlugin, { recursive: true });
            await mockFsPromises.writeFile(path.join(notAPlugin, 'some-file.txt'), 'content');

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
            const plugin1 = path.join(pluginsDir, 'plugin-one');
            const plugin2 = path.join(pluginsDir, 'plugin-two');

            await createMockPluginDir(plugin1);
            await createMockPluginDir(plugin2);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(2);
            const paths = result.map(item => item.path);
            expect(paths).toContain(plugin1);
            expect(paths).toContain(plugin2);
        });

        test('should append discovered in-repo plugins in discovery order, not reverse it', async () => {
            const plugin1 = path.join(pluginsDir, 'plugin-alpha');
            const plugin2 = path.join(pluginsDir, 'plugin-beta');
            const plugin3 = path.join(pluginsDir, 'plugin-gamma');

            // Created (and therefore discovered) in this exact order.
            await createMockPluginDir(plugin1);
            await createMockPluginDir(plugin2);
            await createMockPluginDir(plugin3);

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result.map(item => item.path)).toEqual([plugin1, plugin2, plugin3]);
        });
    });

    describe('external path resolution', () => {
        test('should load external plugins from absolute paths', async () => {
            const externalPlugin = path.join(tempDir, 'external-plugin');
            await createMockPluginDir(externalPlugin);

            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [externalPlugin], marketplace: [] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: externalPlugin });
        });

        test('should expand a ~-prefixed external path before checking it', async () => {
            const externalPlugin = path.join(homedir(), 'tilde-external-plugin');
            await createMockPluginDir(externalPlugin);

            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: ['~/tilde-external-plugin'], marketplace: [] })
            );

            try {
                const result = await loadPlugins(pluginsDir, marketplaceDir);

                expect(result).toHaveLength(1);
                expect(result[0]).toEqual({ type: 'local', path: externalPlugin });
            } finally {
                await mockFsPromises.rm(externalPlugin, { recursive: true, force: true });
            }
        });

        test('should warn and skip missing external paths', async () => {
            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
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
            const invalidPlugin = path.join(tempDir, 'invalid-plugin');
            await mockFsPromises.mkdir(invalidPlugin, { recursive: true });
            // No .claude-plugin directory

            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
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
            const marketplacePlugin = path.join(marketplaceDir, 'cool-plugin', '1.0.0');
            await createMockPluginDir(marketplacePlugin);

            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [], marketplace: ['cool-plugin'] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: marketplacePlugin });
        });

        test('should select latest version when multiple exist', async () => {
            const v1 = path.join(marketplaceDir, 'versioned-plugin', '1.0.0');
            const v2 = path.join(marketplaceDir, 'versioned-plugin', '2.0.0');

            await createMockPluginDir(v1);
            await createMockPluginDir(v2);

            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [], marketplace: ['versioned-plugin'] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: v2 });
        });

        test('should warn and skip missing marketplace plugins', async () => {
            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
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
        test('should treat in-repo plugin names as case-sensitive when deduplicating', async () => {
            const inRepoPlugin = path.join(pluginsDir, 'MyPlugin');
            const externalPlugin = path.join(tempDir, 'myplugin');

            await createMockPluginDir(inRepoPlugin);
            await createMockPluginDir(externalPlugin);

            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [externalPlugin], marketplace: [] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            // externalPlugin's basename "myplugin" differs in case from the in-repo "MyPlugin",
            // so it must NOT be deduplicated against it: both should load.
            expect(result).toHaveLength(2);
            const paths = result.map(item => item.path);
            expect(paths).toContain(inRepoPlugin);
            expect(paths).toContain(externalPlugin);
        });

        test('should prioritize in-repo over external path with same name', async () => {
            const inRepoPlugin = path.join(pluginsDir, 'shared-plugin');
            const externalPlugin = path.join(tempDir, 'shared-plugin');

            await createMockPluginDir(inRepoPlugin);
            await createMockPluginDir(externalPlugin);

            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [externalPlugin], marketplace: [] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: inRepoPlugin });
            expect(mockLogger.debug).toHaveBeenCalledWith({
                name: 'shared-plugin',
                path: externalPlugin,
                msg:  'Skipping external plugin (already loaded from higher priority source)',
            });
            expect(mockFsPromises.access.mock.calls.some(([checkedPath]) => checkedPath === externalPlugin)).toBe(false);
        });

        test('should prioritize in-repo over marketplace with same name', async () => {
            const inRepoPlugin = path.join(pluginsDir, 'shared-plugin');
            const marketplacePlugin = path.join(marketplaceDir, 'shared-plugin', '1.0.0');

            await createMockPluginDir(inRepoPlugin);
            await createMockPluginDir(marketplacePlugin);

            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [], marketplace: ['shared-plugin'] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: inRepoPlugin });
            expect(mockLogger.debug).toHaveBeenCalledWith({
                name: 'shared-plugin',
                msg:  'Skipping marketplace plugin (already loaded from higher priority source)',
            });
        });

        test('should prioritize external over marketplace with same name', async () => {
            const externalPlugin = path.join(tempDir, 'shared-plugin');
            const marketplacePlugin = path.join(marketplaceDir, 'shared-plugin', '1.0.0');

            await createMockPluginDir(externalPlugin);
            await createMockPluginDir(marketplacePlugin);

            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
                JSON.stringify({
                    externalPaths: [externalPlugin],
                    marketplace:   ['shared-plugin'],
                })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({ type: 'local', path: externalPlugin });
            expect(mockLogger.debug).toHaveBeenCalledWith({
                name: 'shared-plugin',
                msg:  'Skipping marketplace plugin (already loaded from higher priority source)',
            });
        });

        test('should load a marketplace plugin only once when configured twice', async () => {
            const marketplacePlugin = path.join(marketplaceDir, 'repeated-plugin', '1.0.0');
            await createMockPluginDir(marketplacePlugin);
            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [], marketplace: ['repeated-plugin', 'repeated-plugin'] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toEqual([{ type: 'local', path: marketplacePlugin }]);
            expect(mockLogger.debug).toHaveBeenCalledWith({
                name: 'repeated-plugin',
                msg:  'Skipping marketplace plugin (already loaded from higher priority source)',
            });
        });

        test('should load plugins from all sources when no duplicates', async () => {
            const inRepoPlugin = path.join(pluginsDir, 'in-repo-plugin');
            const externalPlugin = path.join(tempDir, 'external-plugin');
            const marketplacePlugin = path.join(marketplaceDir, 'marketplace-plugin', '1.0.0');

            await createMockPluginDir(inRepoPlugin);
            await createMockPluginDir(externalPlugin);
            await createMockPluginDir(marketplacePlugin);

            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
                JSON.stringify({
                    externalPaths: [externalPlugin],
                    marketplace:   ['marketplace-plugin'],
                })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(3);
            const paths = result.map(item => item.path);
            expect(paths).toContain(inRepoPlugin);
            expect(paths).toContain(externalPlugin);
            expect(paths).toContain(marketplacePlugin);
        });

        test('preserves configuration and source-priority order while retaining the highest-priority duplicate', async () => {
            const inRepoFirst = path.join(pluginsDir, 'in-repo-first');
            const inRepoShared = path.join(pluginsDir, 'shared-plugin');
            const externalFirst = path.join(tempDir, 'external-first');
            const externalShared = path.join(tempDir, 'shared-plugin');
            const externalSecond = path.join(tempDir, 'external-second');
            const marketplaceFirst = path.join(marketplaceDir, 'marketplace-first', '1.0.0');
            const marketplaceShared = path.join(marketplaceDir, 'shared-plugin', '1.0.0');
            const marketplaceSecond = path.join(marketplaceDir, 'marketplace-second', '1.0.0');

            await Promise.all([
                inRepoFirst,
                inRepoShared,
                externalFirst,
                externalShared,
                externalSecond,
                marketplaceFirst,
                marketplaceShared,
                marketplaceSecond,
            ].map(pluginPath => createMockPluginDir(pluginPath)));

            await mockFsPromises.writeFile(path.join(pluginsDir, 'plugins.json'), JSON.stringify({
                externalPaths: [externalFirst, externalShared, externalSecond],
                marketplace:   ['marketplace-first', 'shared-plugin', 'marketplace-second'],
            }));

            const plugins = await loadPlugins(pluginsDir, marketplaceDir);
            expect(plugins.slice(0, 2)).toEqual(expect.arrayContaining([
                { type: 'local', path: inRepoFirst },
                { type: 'local', path: inRepoShared },
            ]));
            expect(plugins.slice(2)).toEqual([
                { type: 'local', path: externalFirst },
                { type: 'local', path: externalSecond },
                { type: 'local', path: marketplaceFirst },
                { type: 'local', path: marketplaceSecond },
            ]);
            expect(mockLogger.debug).toHaveBeenCalledWith({
                name: 'shared-plugin',
                path: externalShared,
                msg:  'Skipping external plugin (already loaded from higher priority source)',
            });
            expect(mockLogger.debug).toHaveBeenCalledWith({
                name: 'shared-plugin',
                msg:  'Skipping marketplace plugin (already loaded from higher priority source)',
            });
        });
    });

    describe('error handling', () => {
        test('logs the zod issues array (not a flattened field-error map) for an invalid schema', async () => {
            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: 'not-an-array', marketplace: 123 })
            );

            await loadPlugins(pluginsDir, marketplaceDir);

            const call = mockLogger.warn.mock.calls.find(([arg]) => (arg as { errors?: unknown }).errors !== undefined);
            expect(call).toBeDefined();
            // result.error.issues is an array of ZodIssue; .flatten().fieldErrors is a plain object keyed by field.
            expect(Array.isArray((call?.[0] as { errors: unknown }).errors)).toBe(true);
        });

        test('logs the underlying Error message (not String(error)) when plugins.json fails to read', async () => {
            mockFsPromises.readFile.mockRejectedValueOnce(new Error('boom'));

            await loadPlugins(pluginsDir, marketplaceDir);

            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    // error.message is 'boom'; String(error) would be 'Error: boom'.
                    error: 'boom',
                })
            );
        });

        test('should use empty config defaults when plugins.json is missing without warning', async () => {
            await mockFsPromises.rm(path.join(pluginsDir, 'plugins.json'));

            // Create marketplace plugin that would be loaded IF config existed
            const marketplacePlugin = path.join(marketplaceDir, 'marketplace-plugin', '1.0.0');
            await createMockPluginDir(marketplacePlugin);

            // Create external plugin that would be loaded IF config existed
            const externalPlugin = path.join(tempDir, 'external-plugin');
            await createMockPluginDir(externalPlugin);

            const inRepoPlugin = path.join(pluginsDir, 'in-repo-plugin');
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
                await mockFsPromises.writeFile(path.join(pluginsDir, 'plugins.json'), '{ invalid json }');
            }, 'Failed to parse plugins.json'],
            ['null value', async () => {
                await mockFsPromises.writeFile(path.join(pluginsDir, 'plugins.json'), 'null');
            }, 'Invalid plugins.json schema'],
            ['array value', async () => {
                await mockFsPromises.writeFile(path.join(pluginsDir, 'plugins.json'), '[]');
            }, 'Invalid plugins.json schema'],
            ['wrong field types', async () => {
                await mockFsPromises.writeFile(
                    path.join(pluginsDir, 'plugins.json'),
                    JSON.stringify({ externalPaths: 'not-an-array', marketplace: 123 })
                );
            }, 'Invalid plugins.json schema'],
            ['empty object', async () => {
                await mockFsPromises.writeFile(path.join(pluginsDir, 'plugins.json'), '{}');
            }, null],
            ['missing externalPaths field', async () => {
                await mockFsPromises.writeFile(path.join(pluginsDir, 'plugins.json'), JSON.stringify({ marketplace: [] }));
            }, null],
            ['missing marketplace field', async () => {
                await mockFsPromises.writeFile(path.join(pluginsDir, 'plugins.json'), JSON.stringify({ externalPaths: [] }));
            }, null],
        ])('should handle %s', async (_desc, setup, expectedWarning) => {
            await setup();

            const inRepoPlugin = path.join(pluginsDir, 'in-repo-plugin');
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
                expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            } else {
                expect(mockLogger.warn).not.toHaveBeenCalled();
            }
        });

        test('uses the default marketplace directory when no path is supplied', async () => {
            const defaultMarketplace = path.join(homedir(), '.claude', 'plugins');
            const pluginPath = path.join(defaultMarketplace, 'default-plugin', '1.0.0');
            try {
                await createMockPluginDir(pluginPath);
                await mockFsPromises.writeFile(
                    path.join(pluginsDir, 'plugins.json'),
                    JSON.stringify({ marketplace: ['default-plugin'] })
                );
                expect(await loadPlugins(pluginsDir)).toEqual([{ type: 'local', path: pluginPath }]);
            } finally {
                await mockFsPromises.rm(defaultMarketplace, { recursive: true, force: true });
            }
        });

        test('logs the exact accepted plugin names and counts by source', async () => {
            const inRepoPlugin = path.join(pluginsDir, 'internal');
            const externalPlugin = path.join(tempDir, 'external');
            const marketplacePlugin = path.join(marketplaceDir, 'catalog', '1.0.0');
            await Promise.all([
                createMockPluginDir(inRepoPlugin),
                createMockPluginDir(externalPlugin),
                createMockPluginDir(marketplacePlugin),
            ]);
            await mockFsPromises.writeFile(path.join(pluginsDir, 'plugins.json'), JSON.stringify({
                externalPaths: [externalPlugin], marketplace: ['catalog'],
            }));

            expect(await loadPlugins(pluginsDir, marketplaceDir)).toHaveLength(3);
            expect(mockLogger.info.mock.calls.map(call => call[0])).toEqual([
                { count: 1, plugins: ['internal'], msg: 'Discovered in-repo plugins' },
                { count: 1, plugins: ['external'], msg: 'Loaded external plugins' },
                { count: 1, plugins: ['catalog'], msg: 'Loaded marketplace plugins' },
            ]);
        });

        test('should handle missing plugins directory gracefully', async () => {
            await mockFsPromises.rm(pluginsDir, { recursive: true, force: true });

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(0);
            expect(mockLogger.info).not.toHaveBeenCalled();
        });

        test('should handle missing marketplace directory gracefully', async () => {
            await mockFsPromises.rm(marketplaceDir, { recursive: true, force: true });

            await mockFsPromises.writeFile(
                path.join(pluginsDir, 'plugins.json'),
                JSON.stringify({ externalPaths: [], marketplace: ['some-plugin'] })
            );

            const result = await loadPlugins(pluginsDir, marketplaceDir);

            expect(result).toHaveLength(0);
        });
    });

    describe('concurrency limits', () => {
        const configPath = path.join(pluginsDir, 'plugins.json');

        test('checks at most 8 external plugin paths concurrently', async () => {
            const externalPaths = Array.from({ length: 12 }, (_, i) => path.join(tempDir, `ext-gate-${i}`));
            await mockFsPromises.writeFile(configPath, JSON.stringify({ externalPaths, marketplace: [] }));

            let inFlight = 0;
            let maxInFlight = 0;
            const releasers: (() => void)[] = [];
            mockFsPromises.access.mockImplementation(async (checkedPath) => {
                // Let the framework's own existence checks (plugins dir, plugins.json) through
                // immediately; only the external-plugin candidates are held open to measure
                // how many run at once.
                if(checkedPath === pluginsDir || checkedPath === configPath) {
                    return;
                }
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise<void>((_resolve, reject) => {
                    releasers.push(() => {
                        inFlight--;
                        reject(new Error('ENOENT'));
                    });
                });
            });

            const resultPromise = loadPlugins(pluginsDir, marketplaceDir);
            await flushMicrotasks(20);

            expect(maxInFlight).toBe(8);

            // Drain in waves: releasing one wave lets p-limit start the next, which needs its
            // own microtask flush before it shows up in `releasers`.
            while(releasers.length > 0) {
                for(const release of releasers.splice(0)) {
                    release();
                }
                // eslint-disable-next-line no-await-in-loop -- draining a variable-length wave queue; each wave's size depends on the previous wave's release
                await flushMicrotasks(5);
            }
            await resultPromise;
        });

        test('checks at most 8 marketplace plugin versions concurrently', async () => {
            const marketplaceNames = Array.from({ length: 12 }, (_, i) => `mkt-gate-${i}`);
            await mockFsPromises.writeFile(configPath, JSON.stringify({ externalPaths: [], marketplace: marketplaceNames }));

            let inFlight = 0;
            let maxInFlight = 0;
            const releasers: (() => void)[] = [];
            mockFsPromises.access.mockImplementation(async (checkedPath) => {
                if(checkedPath === pluginsDir || checkedPath === configPath) {
                    return;
                }
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise<void>((_resolve, reject) => {
                    releasers.push(() => {
                        inFlight--;
                        reject(new Error('ENOENT'));
                    });
                });
            });

            const resultPromise = loadPlugins(pluginsDir, marketplaceDir);
            await flushMicrotasks(20);

            expect(maxInFlight).toBe(8);

            while(releasers.length > 0) {
                for(const release of releasers.splice(0)) {
                    release();
                }
                // eslint-disable-next-line no-await-in-loop -- draining a variable-length wave queue; each wave's size depends on the previous wave's release
                await flushMicrotasks(5);
            }
            await resultPromise;
        });
    });
});

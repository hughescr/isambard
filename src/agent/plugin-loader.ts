import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import pLimit from 'p-limit';
import semver from 'semver';
import { z } from 'zod';

/**
 * Schema for plugins.json configuration file.
 */
const PluginsConfigSchema = z.object({
    externalPaths: z.array(z.string()).default([]),
    marketplace:   z.array(z.string()).default([]),
});

type PluginsConfig = z.infer<typeof PluginsConfigSchema>;

/**
 * Resolves a path, expanding ~ to the home directory.
 * @param inputPath Path that may contain ~ prefix
 * @returns Absolute path with ~ expanded
 */
export function resolveExternalPath(inputPath: string): string {
    if(inputPath.startsWith('~/')) {
        // Stryker disable next-line llm: substring(2) and slice(2, inputPath.length) are equivalent to slice(2) for every string
        return path.join(homedir(), inputPath.slice(2));
    }
    if(inputPath === '~') {
        return homedir();
    }
    return inputPath;
}

/**
 * Checks if a path exists.
 * @param filePath Path to check
 * @returns true if path exists
 */
async function pathExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch{
        // Silent: ENOENT or EACCES means the path does not exist or is inaccessible.
        // The function contract is "returns false when the path can't be accessed."
        return false;
    }
}

/**
 * Checks if a path is a directory.
 * @param dirPath Path to check
 * @returns true if path is a directory
 */
async function isDirectory(dirPath: string): Promise<boolean> {
    try {
        const stats = await stat(dirPath);
        return stats.isDirectory();
    } catch{
        // Silent: stat() throws if the path doesn't exist or is inaccessible.
        // The function contract is "returns false when the path is not a directory."
        return false;
    }
}

/**
 * Checks if a directory is a valid Claude Code plugin (contains .claude-plugin/).
 * @param dirPath Directory path to check
 * @returns true if directory contains .claude-plugin subdirectory
 */
async function isValidPluginDirectory(dirPath: string): Promise<boolean> {
    const pluginManifestDir = path.join(dirPath, '.claude-plugin');
    return pathExists(pluginManifestDir).then(exists => exists && isDirectory(pluginManifestDir));
}

/**
 * Finds the latest version directory for a marketplace plugin.
 * Scans version subdirectories and returns the one with the highest semver.
 *
 * @param marketplacePath Base path to marketplace plugins (~/.claude/plugins)
 * @param pluginName Name of the plugin to find
 * @returns Absolute path to the latest version directory, or undefined if not found
 */
export async function findLatestMarketplaceVersion(marketplacePath: string, pluginName: string): Promise<string | undefined> {
    const pluginDir = path.join(marketplacePath, pluginName);

    if(!await pathExists(pluginDir)) {
        return undefined;
    }

    // Read version directories
    const entries = await readdir(pluginDir, { withFileTypes: true });
    const versionDirs = entries.filter(e => e.isDirectory());
    // Filter to valid plugin directories with semver names
    const withVersionInfo = versionDirs.map(dir => ({
        name:    dir.name,
        path:    path.join(pluginDir, dir.name),
        version: semver.valid(dir.name),
    }));

    // Stryker disable next-line llm: semver.valid returns string | null, never undefined, so an extra undefined check is redundant.
    const withSemver = withVersionInfo.filter(v => v.version !== null);

    // Check each directory for validity in parallel
    const validityChecks = await Promise.all(
        withSemver.map(async v => ({
            ...v,
            isValid: await isValidPluginDirectory(v.path),
        }))
    );

    const validVersions = validityChecks.filter(v => v.isValid);

    // Sort by semver ascending and return the last (latest)
    const sorted = validVersions.toSorted((a, b) => {
        // Stryker disable next-line llm: a.version is semver.valid(a.name), so parsing the raw directory name yields the same SemVer ordering as parsing its canonical form.
        const av = semver.parse(a.version);
        // Stryker disable next-line llm: b.version is semver.valid(b.name), so parsing the raw directory name yields the same SemVer ordering as parsing its canonical form.
        const bv = semver.parse(b.version);
        // Stryker disable next-line NumberLiteralValue,llm: versions passed semver.valid and the null-valued entries were filtered out before parsing, so the null fallback is unreachable.
        return av === null || bv === null ? 0 : semver.compare(av, bv);
    });
    const latest = sorted.at(-1);

    return latest?.path;
}

/**
 * Discovers in-repo plugins (directories with .claude-plugin/ under plugins/).
 * @param pluginsDir Path to the plugins directory
 * @returns Array of SdkPluginConfig for discovered in-repo plugins
 */
async function discoverInRepoPlugins(pluginsDir: string): Promise<SdkPluginConfig[]> {
    if(!await pathExists(pluginsDir)) {
        return [];
    }

    const entries = await readdir(pluginsDir, { withFileTypes: true });
    const directories = entries.filter(e => e.isDirectory());

    const withPaths = directories.map(dir => ({
        name: dir.name,
        path: path.join(pluginsDir, dir.name),
    }));

    // Check validity in parallel
    const validityChecks = await Promise.all(
        withPaths.map(async d => ({
            ...d,
            isValid: await isValidPluginDirectory(d.path),
        }))
    );

    const validDirs = validityChecks.filter(d => d.isValid);
    const invalidDirs = validityChecks.filter(d => !d.isValid);

    // Warn about directories without .claude-plugin/ - likely misconfiguration
    for(const invalid of invalidDirs) {
        logger.warn({
            name: invalid.name,
            path: invalid.path,
            msg:  `Directory in ${pluginsDir} is not a valid plugin (missing .claude-plugin/)`,
        });
    }

    return validDirs.map(d => ({ type: 'local' as const, path: d.path }));
}

/**
 * Loads plugins configuration from plugins.json.
 * @param pluginsDir Path to the plugins directory
 * @returns Parsed config or default empty config
 */
async function loadPluginsConfig(pluginsDir: string): Promise<PluginsConfig> {
    const configPath = path.join(pluginsDir, 'plugins.json');

    if(!await pathExists(configPath)) {
        return { externalPaths: [], marketplace: [] };
    }

    try {
        const content = await readFile(configPath, 'utf8');
        const parsed = JSON.parse(content) as unknown;
        const result = PluginsConfigSchema.safeParse(parsed);

        if(!result.success) {
            logger.warn({
                path:   configPath,
                errors: result.error.issues,
                msg:    'Invalid plugins.json schema, using defaults',
            });
            return { externalPaths: [], marketplace: [] };
        }

        return result.data;
    } catch (error) {
        logger.warn({
            path:  configPath,
            error: error instanceof Error ? error.message : String(error),
            msg:   'Failed to parse plugins.json, using defaults',
        });
        return { externalPaths: [], marketplace: [] };
    }
}

/**
 * Resolves external plugin paths from configuration.
 * @param externalPaths Array of paths (may include ~)
 * @param loadedNames Set of already-loaded plugin names (for deduplication)
 * @returns Array of SdkPluginConfig for valid external plugins
 */
async function resolveExternalPlugins(externalPaths: string[], loadedNames: Set<string>): Promise<SdkPluginConfig[]> {
    const plugins: SdkPluginConfig[] = [];
    const limit = pLimit(8);
    const candidates = externalPaths.map((rawPath) => {
        const resolvedPath = resolveExternalPath(rawPath);
        return { name: path.basename(resolvedPath), resolvedPath };
    });
    const checks = await Promise.all(candidates.map(candidate => limit(async () => {
        if(loadedNames.has(candidate.name)) {
            return undefined;
        }
        const exists = await pathExists(candidate.resolvedPath);
        return { exists, valid: exists && await isValidPluginDirectory(candidate.resolvedPath) };
    })));

    for(const [index, { name, resolvedPath }] of candidates.entries()) {
        // Skip if already loaded (deduplication)
        if(loadedNames.has(name)) {
            logger.debug({
                name,
                path: resolvedPath,
                msg:  'Skipping external plugin (already loaded from higher priority source)',
            });
            continue;
        }

        if(!checks[index]?.exists) {
            logger.warn({
                path: resolvedPath,
                msg:  'External plugin path not found, skipping',
            });
            continue;
        }

        if(!checks[index].valid) {
            logger.warn({
                path: resolvedPath,
                msg:  'External plugin missing .claude-plugin directory, skipping',
            });
            continue;
        }

        plugins.push({ type: 'local', path: resolvedPath });
        loadedNames.add(name);
    }

    return plugins;
}

/**
 * Resolves marketplace plugins from configuration.
 * @param marketplaceNames Array of plugin names to load from marketplace
 * @param marketplacePath Path to marketplace plugins directory
 * @param loadedNames Set of already-loaded plugin names (for deduplication)
 * @returns Array of SdkPluginConfig for valid marketplace plugins
 */
async function resolveMarketplacePlugins(
    marketplaceNames: string[],
    marketplacePath: string,
    loadedNames: Set<string>
): Promise<SdkPluginConfig[]> {
    const plugins: SdkPluginConfig[] = [];
    const limit = pLimit(8);
    const resolved = await Promise.all(marketplaceNames.map(name => limit(async () => ({
        name,
        latestPath: loadedNames.has(name) ? undefined : await findLatestMarketplaceVersion(marketplacePath, name),
    }))));

    for(const { name, latestPath } of resolved) {
        // Skip if already loaded (deduplication)
        if(loadedNames.has(name)) {
            logger.debug({
                name,
                msg: 'Skipping marketplace plugin (already loaded from higher priority source)',
            });
            continue;
        }

        if(!latestPath) {
            logger.warn({
                name,
                marketplacePath,
                msg: 'Marketplace plugin not found or has no valid versions, skipping',
            });
            continue;
        }

        plugins.push({ type: 'local', path: latestPath });
        loadedNames.add(name);
    }

    return plugins;
}

/**
 * Loads all plugins from configured sources with priority-based deduplication.
 *
 * Priority (highest to lowest):
 * 1. In-repo plugins (directories under pluginsDir with .claude-plugin/)
 * 2. External paths (from plugins.json externalPaths)
 * 3. Marketplace plugins (from plugins.json marketplace, resolved from marketplacePath)
 *
 * @param pluginsDir Path to the plugins directory (default: PROJECT_ROOT/plugins)
 * @param marketplacePath Path to marketplace plugins (default: ~/.claude/plugins)
 * @returns Array of SdkPluginConfig objects ready for the SDK
 */
export async function loadPlugins(
    pluginsDir: string,
    marketplacePath: string = path.join(homedir(), '.claude', 'plugins')
): Promise<SdkPluginConfig[]> {
    const loadedNames = new Set<string>();
    const allPlugins: SdkPluginConfig[] = [];

    // 1. Discover in-repo plugins (highest priority)
    const inRepoPlugins = await discoverInRepoPlugins(pluginsDir);
    for(const plugin of inRepoPlugins) {
        const name = path.basename(plugin.path);
        // Stryker disable next-line llm: guarding Set.add with !has is equivalent because Set.add is idempotent
        loadedNames.add(name);
        allPlugins.push(plugin);
    }

    if(inRepoPlugins.length > 0) {
        logger.info({
            count:   inRepoPlugins.length,
            plugins: inRepoPlugins.map(p => path.basename(p.path)),
            msg:     'Discovered in-repo plugins',
        });
    }

    // 2. Load configuration and resolve external + marketplace plugins
    const config = await loadPluginsConfig(pluginsDir);

    // 3. Resolve external plugins
    // Stryker disable next-line llm: PluginsConfigSchema and every fallback guarantee externalPaths is an array
    const externalPlugins = await resolveExternalPlugins(config.externalPaths, loadedNames);
    allPlugins.push(...externalPlugins);

    if(externalPlugins.length > 0) {
        logger.info({
            count:   externalPlugins.length,
            plugins: externalPlugins.map(p => path.basename(p.path)),
            msg:     'Loaded external plugins',
        });
    }

    // 4. Resolve marketplace plugins (lowest priority)
    // Stryker disable next-line llm: PluginsConfigSchema and every fallback guarantee marketplace is an array
    const marketplacePlugins = await resolveMarketplacePlugins(config.marketplace, marketplacePath, loadedNames);
    allPlugins.push(...marketplacePlugins);

    if(marketplacePlugins.length > 0) {
        logger.info({
            count:   marketplacePlugins.length,
            plugins: marketplacePlugins.map(p => path.basename(path.dirname(p.path))),
            msg:     'Loaded marketplace plugins',
        });
    }

    return allPlugins;
}

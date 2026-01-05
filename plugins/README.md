# Isambard Plugins

This directory contains configuration for Claude Code plugins to be loaded by Isambard.

## Plugin Sources (Priority Order)

1. **In-repo plugins** (highest priority): Directories under `plugins/` that contain a `.claude-plugin/` subdirectory
2. **External paths**: Absolute paths specified in `plugins.json` under `externalPaths`
3. **Marketplace plugins**: Plugin names from `~/.claude/plugins/` specified in `plugins.json` under `marketplace`

## Configuration

Edit `plugins.json` to configure external and marketplace plugins:

```json
{
    "externalPaths": [
        "~/my-plugins/custom-plugin",
        "/absolute/path/to/another-plugin"
    ],
    "marketplace": [
        "some-marketplace-plugin"
    ]
}
```

### External Paths

- Can use `~` for home directory expansion
- Must point to a directory containing `.claude-plugin/plugin.json`
- Missing paths are logged as warnings and skipped

### Marketplace Plugins

Marketplace plugins are installed via the Claude Code CLI and stored in Claude Code's cache.

**To add a marketplace plugin:**

1. Add the marketplace (if not already added):
   ```bash
   claude plugin marketplace add owner/repo
   ```

2. Install the plugin:
   ```bash
   claude plugin install plugin-name@marketplace-name
   ```
   This installs to `~/.claude/plugins/cache/cc-plugins/{plugin-name}/{version}/`

3. Add to `plugins.json`:
   ```json
   {
     "marketplace": ["plugin-name@marketplace-name"]
   }
   ```

**How it works:**
- The plugin loader parses `plugin-name@marketplace-name` format
- Looks in `~/.claude/plugins/cache/cc-plugins/{plugin-name}/`
- Automatically selects the latest installed version (by semver)
- Missing plugins are logged as warnings and skipped

**To update a marketplace plugin:**
```bash
claude plugin update plugin-name@marketplace-name
```
The plugin loader will automatically pick up the new version on next Isambard start.

## In-Repo Plugins

Place custom plugins directly in subdirectories of `plugins/`:

```
plugins/
  my-custom-plugin/
    .claude-plugin/
      plugin.json
    ...
```

## Deduplication

If the same plugin appears in multiple sources, the highest-priority source wins.
The plugin loader prevents duplicate plugin loading.

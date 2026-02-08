# Isambard Agents, Skills, and Plugins

This directory contains agent definitions, skill definitions, and plugin configuration for Isambard's Claude Agent SDK integration.

## Directory Structure

```
agents-skills-plugins/
  agents/           ← Agent definitions (.md files)
  skills/           ← Skill definitions (directories with SKILL.md)
  plugins/          ← Plugin configuration (plugins.json)
  README.md
```

## How It Works

At startup, Isambard copies `agents/` and `skills/` to `scratch/.claude/` so the Claude Agent SDK can discover them via filesystem-based discovery (`settingSources: ['project']`). Plugins are loaded separately via the plugin loader.

### Agents

Agent definitions are Markdown files with YAML frontmatter. Place them in `agents/`:

```
agents/
  memory-archivist.md
  memory-curator.md
```

These are available to the main agent and its sub-agents via the `Task` tool.

### Skills

Skill definitions are directories containing a `SKILL.md` file. Place them in `skills/`:

```
skills/
  memory-reflection/
    SKILL.md
```

Skills are invokable via the `Skill` tool.

### Plugins

Plugin configuration lives in `plugins/plugins.json`. Plugins follow the Claude Code plugin specification (directories with `.claude-plugin/plugin.json`).

#### Plugin Sources (Priority Order)

1. **In-repo plugins** (highest priority): Directories under `plugins/` that contain a `.claude-plugin/` subdirectory
2. **External paths**: Absolute paths specified in `plugins.json` under `externalPaths`
3. **Marketplace plugins**: Plugin names from `~/.claude/plugins/` specified in `plugins.json` under `marketplace`

#### Configuration

Edit `plugins/plugins.json` to configure external and marketplace plugins:

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

## Adding New Components

### Adding an Agent

1. Create a new `.md` file in `agents/`
2. Include YAML frontmatter with `name`, `description`, `model`, and `tools`
3. Restart Isambard (agents are copied at startup)

### Adding a Skill

1. Create a new directory in `skills/`
2. Add a `SKILL.md` file with YAML frontmatter (`name`, `version`, `description`)
3. Restart Isambard (skills are copied at startup)

### Adding a Plugin

1. Place the plugin directory (with `.claude-plugin/`) under `plugins/`, OR
2. Add the path to `plugins/plugins.json` under `externalPaths`, OR
3. Install via marketplace and add to `plugins/plugins.json` under `marketplace`

## Deduplication

If the same plugin appears in multiple sources, the highest-priority source wins. The plugin loader prevents duplicate plugin loading.

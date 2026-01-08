# Thinker - Claude Code Thinking Visibility Patch

Makes Claude Code's thinking blocks visible by default and adds custom color support.

## Features

- **Always-visible thinking** - No more `ctrl+o` to expand
- **Custom colors** - Color the header and content separately
- **Preset themes** - Quick access to popular colors
- **Safe patching** - Automatic backup and restore

## Usage

```bash
# Basic - show thinking with default styling
node thinker.js

# Custom color for both header and content
node thinker.js --color=pink

# Separate colors for header and content (Watermelon theme!)
node thinker.js --color=green --content-color=pink

# Preview changes without applying
node thinker.js --dry-run

# Restore original Claude Code
node thinker.js --restore

# Check if current version is patchable
node thinker.js --check

# Show help
node thinker.js --help
```

## Color Options

### Presets
```
cyan, green, magenta, yellow, blue, red, white,
pink, orange, purple, teal, gold, lime, coral, sky
```

### Custom Hex
```bash
node thinker.js --color=#ff69b4 --content-color=#32cd32
```

## Theme Ideas

| Theme | Command |
|-------|---------|
| Watermelon | `--color=green --content-color=pink` |
| Sunset | `--color=coral --content-color=gold` |
| Ocean | `--color=teal --content-color=sky` |
| Mono Pink | `--color=pink` |
| Cyberpunk | `--color=#00ffff --content-color=#ff00ff` |

## Requirements

- Node.js
- Claude Code CLI installed globally

## Notes

- Re-run after Claude Code updates (the patch targets specific code patterns)
- A backup is created automatically at `cli.js.backup`
- Tested with Claude Code v2.1.x

## How It Works

The patch modifies Claude Code's CLI to:
1. Disable the collapsed thinking view (`ctrl+o to expand`)
2. Force the expanded view to always render
3. Inject color props into Ink's Text components for custom styling

Colors are applied through Ink's native `color` prop system, ensuring proper rendering across terminal line wraps.

# Thinker - Claude Code Thinking Visibility Patch

Makes Claude Code's thinking blocks visible by default and adds custom color support.

## Implementations

This tool has two implementations:

| File | Approach | Status |
|------|----------|--------|
| `thinker-ast.js` | **AST-based** (Acorn + magic-string) | **Recommended** - more robust |
| `thinker.js` | Regex-based | Legacy - may break on updates |

**We recommend using `thinker-ast.js`** - it uses proper JavaScript parsing to find patch targets via stable string anchors (like `"∴ Thinking…"`) rather than fragile regex patterns that break when minifier variable names change.

## Features

- **Always-visible thinking** - No more `ctrl+o` to expand
- **Custom colors** - Color the header and content separately
- **Preset themes** - Quick access to popular colors
- **Safe patching** - Automatic backup and restore

## Usage

```bash
# Basic - show thinking with default styling
node thinker-ast.js

# Use a preset theme
node thinker-ast.js --theme=watermelon

# Custom color for both header and content
node thinker-ast.js --color=pink

# Separate colors for header and content
node thinker-ast.js --color=green --content-color=pink

# Preview changes without applying
node thinker-ast.js --dry-run

# Restore original Claude Code
node thinker-ast.js --restore

# Check if current version is patchable
node thinker-ast.js --check

# Show help
node thinker-ast.js --help
```

## Color Options

### Presets
```
cyan, green, magenta, yellow, blue, red, white,
pink, orange, purple, teal, gold, lime, coral, sky
```

### Custom Hex
```bash
node thinker-ast.js --color=#ff69b4 --content-color=#32cd32
```

## Theme Presets

Use `--theme=NAME` for quick preset combos:

| Theme | Header | Content |
|-------|--------|---------|
| `watermelon` | #32cd32 (lime) | #FF77FF (pink) |
| `emerald-saffron` | #00C853 | #F4C24D |
| `bubblegum` | #87ceeb (sky) | #FF77FF (pink) |
| `carrot` | #ff8c00 (orange) | #32cd32 (lime) |
| `autumn` | #FFBF00 (amber) | #D2691E (chocolate) |
| `ocean` | #98D8C8 | #20B2AA (teal) |
| `forest` | #90EE90 | #228B22 |
| `cherry-blossom` | #FF69B4 | #FFB6C1 |
| `cyberpunk` | #FCE300 (yellow) | #00F0FF (cyan) |

## Custom Theme Examples

| Theme | Command |
|-------|---------|
| Sunset | `--color=coral --content-color=gold` |
| Mono Pink | `--color=pink` |
| Matrix | `--color=#00ff00` |

## Requirements

- Node.js
- Claude Code CLI installed globally

### For AST version (thinker-ast.js)
```bash
cd ~/.claude/tools/claude-thinking-toggle
npm install
```
This installs: `acorn`, `acorn-walk`, `magic-string`

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

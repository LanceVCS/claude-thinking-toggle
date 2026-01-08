#!/usr/bin/env node
/**
 * Claude Code Thinking Visibility Patch - "Thinker"
 *
 * Patches Claude Code to show thinking blocks expanded by default.
 *
 * Usage:
 *   node thinker.js           # Apply patch
 *   node thinker.js --dry-run # Preview changes
 *   node thinker.js --restore # Restore from backup
 *   node thinker.js --check   # Check if patchable
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESTORE = args.includes('--restore');
const CHECK_ONLY = args.includes('--check');
const HELP = args.includes('--help') || args.includes('-h');

// Parse --color=<value> argument (for header, or both if no content-color)
const colorArg = args.find(a => a.startsWith('--color='));
const CUSTOM_COLOR = colorArg ? colorArg.split('=')[1] : null;

// Parse --content-color=<value> argument (for thinking body)
const contentColorArg = args.find(a => a.startsWith('--content-color='));
const CONTENT_COLOR = contentColorArg ? contentColorArg.split('=')[1] : null;

// Parse --theme=<value> argument (for preset theme combos)
const themeArg = args.find(a => a.startsWith('--theme='));
const THEME = themeArg ? themeArg.split('=')[1] : null;

// Preset theme combos (header + content)
const THEME_PRESETS = {
  'watermelon': { header: '#32cd32', content: '#ff69b4' },
  'emerald-saffron': { header: '#00C853', content: '#F4C24D' },
  'bubblegum': { header: '#87ceeb', content: '#ff69b4' },
};

// Preset color themes (using hex for reliability with Ink)
const COLOR_PRESETS = {
  'dim': null,           // Default dimmed gray
  'cyan': '#00ffff',
  'green': '#32cd32',
  'magenta': '#ff00ff',
  'yellow': '#ffff00',
  'blue': '#4169e1',
  'red': '#ff4444',
  'white': '#ffffff',
  'pink': '#ff69b4',
  'orange': '#ff8c00',
  'purple': '#9370db',
  'teal': '#20b2aa',
  'gold': '#ffd700',
  'lime': '#00ff00',
  'coral': '#ff7f50',
  'sky': '#87ceeb',
};

if (HELP) {
  console.log(`
🧠 Thinker - Claude Code Thinking Visibility Patch

Usage:
  node thinker.js                           Apply the patch (default dim gray)
  node thinker.js --theme=watermelon        Apply preset theme 🍉
  node thinker.js --theme=emerald-saffron   Apply preset theme 🌿
  node thinker.js --color=green             Apply with custom header color
  node thinker.js --content-color=pink      Apply with custom content color
  node thinker.js --color=green --content-color=pink   Custom combo
  node thinker.js --dry-run                 Preview changes without applying
  node thinker.js --restore                 Restore from backup
  node thinker.js --check                   Check if current version is patchable

Theme presets:
  watermelon       Green header + pink content 🍉
  emerald-saffron  Emerald header + gold content 🌿
  bubblegum        Sky blue header + pink content 🫧

Color options:
  Named:  cyan, green, magenta, yellow, blue, red, white
  Presets: pink, orange, purple, teal, gold, lime, coral, sky
  Hex:    #ff69b4, #4ecdc4, etc.
  RGB:    rgb(255,107,107)

What it does:
  1. Removes the collapsed "∴ Thinking..." banner
  2. Forces thinking content to display inline automatically
  3. Optionally applies custom colors to header and content separately
  `);
  process.exit(0);
}

// Find Claude Code installation
function findClaudeCode() {
  const searchPaths = [];

  // 1. Check symlink from 'which claude'
  try {
    const claudePath = execSync('which claude', { encoding: 'utf8' }).trim();
    const realPath = fs.realpathSync(claudePath);
    searchPaths.push(realPath);
    searchPaths.push(path.dirname(realPath) + '/cli.js');
  } catch (e) {}

  // 2. Global npm
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    searchPaths.push(path.join(npmRoot, '@anthropic-ai/claude-code/cli.js'));
  } catch (e) {}

  // 3. Local installations
  const home = process.env.HOME || process.env.USERPROFILE;
  searchPaths.push(
    path.join(home, '.claude/local/node_modules/@anthropic-ai/claude-code/cli.js'),
    path.join(home, '.config/claude/local/node_modules/@anthropic-ai/claude-code/cli.js')
  );

  for (const p of searchPaths) {
    if (fs.existsSync(p) && p.endsWith('cli.js')) {
      return p;
    }
  }

  return null;
}

// Extract version from cli.js
function getVersion(content) {
  const match = content.match(/\/\/ Version: ([\d.]+)/);
  return match ? match[1] : 'unknown';
}

// Extract the NbA thinking component that shows collapsed/expanded view (v2.1.x)
function extractThinkingComponent(content) {
  // Match the NbA component that contains the collapsed "∴ Thinking (ctrl+o to expand)" text
  // Unpatched: if(!(B||G))return $6A.default.createElement(...)
  // Patched: if(!1)return $6A.default.createElement(...)
  const collapsedRegex = /if\(!\(([A-Z])\|\|([A-Z])\)\)return ([\$A-Za-z0-9]+)\.default\.createElement\(([A-Z]),\{marginTop:[A-Z]\?1:0\},\3\.default\.createElement\(([A-Z]),\{dimColor:!0,italic:!0\},"∴ Thinking \(ctrl\+o to expand\)"\)\);/;
  const patchedRegex = /if\(!1\)return ([\$A-Za-z0-9]+)\.default\.createElement\(([A-Z]),\{marginTop:[A-Z]\?1:0\},\1\.default\.createElement\(([A-Z]),\{dimColor:!0,italic:!0\},"∴ Thinking \(ctrl\+o to expand\)"\)\);/;

  let match = content.match(collapsedRegex);
  if (match) {
    return {
      fullMatch: match[0],
      transcriptVar: match[1],
      verboseVar: match[2],
      reactVar: match[3],
      wrapperElement: match[4],
      textElement: match[5],
      isPatched: false
    };
  }

  match = content.match(patchedRegex);
  if (match) {
    return {
      fullMatch: match[0],
      reactVar: match[1],
      wrapperElement: match[2],
      textElement: match[3],
      isPatched: true
    };
  }

  return null;
}

// Legacy: Extract the full banner function using precise pattern matching (pre-v2.1.x)
function extractBannerFunction(content) {
  // Match the banner function signature and capture the function name
  // Pattern: function XXX({streamMode:A}){let[...]=YYY.useState(null),[...]=YYY.useState(null);if(YYY.useEffect...
  const signatureRegex = /function ([A-Za-z0-9]+)\(\{streamMode:([A-Z])\}\)\{let\[([A-Z]),([A-Z])\]=([A-Za-z0-9]+)\.useState\(null\),\[([A-Z]),([A-Z])\]=\5\.useState\(null\);if\(\5\.useEffect/;
  const match = content.match(signatureRegex);

  if (!match) return null;

  const funcName = match[1];
  const funcStart = content.indexOf(`function ${funcName}({streamMode:`);

  if (funcStart === -1) return null;

  // The function ends with "return null}" - find it by searching from the function start
  // We need to find the specific "return null}" that ends THIS function
  // It should be followed by "var" or end of the function context

  // Search for the pattern "return null}" followed by either "var" or end context markers
  const searchFrom = funcStart;
  const searchRegion = content.substring(searchFrom, searchFrom + 2000); // The function is ~600 chars

  // Find "return null}" in the search region
  const endPattern = 'return null}';
  const endIdx = searchRegion.indexOf(endPattern);

  if (endIdx === -1) return null;

  const fullFunction = content.substring(funcStart, funcStart + endIdx + endPattern.length);

  // Validate it looks like the banner function (contains the expected elements)
  if (!fullFunction.includes('Thinking') || !fullFunction.includes('ctrl+o')) {
    return null;
  }

  return {
    funcName,
    fullFunction,
    startIdx: funcStart
  };
}

// Detect the thinking case pattern (v2.1.x with hideInTranscript)
function detectThinkingPatternV2(content) {
  // Pattern: case"thinking":{if(!D&&!Z)return null;return XXX.createElement(YYY,{addMargin:Q,param:A,isTranscriptMode:D,verbose:Z,hideInTranscript:...}
  const regex = /case"thinking":\{if\(!([A-Z])&&!([A-Z])\)return null;return ([a-z0-9]+)\.createElement\(([A-Za-z0-9]+),\{addMargin:([A-Z]),param:([A-Z]),isTranscriptMode:([A-Z]),verbose:([A-Z]),hideInTranscript:[^}]+\}/;
  const match = content.match(regex);

  if (!match) return null;

  return {
    fullMatch: match[0],
    guardVar1: match[1],
    guardVar2: match[2],
    reactVar: match[3],
    componentName: match[4],
    addMarginVar: match[5],
    paramVar: match[6],
    transcriptVar: match[7],
    verboseVar: match[8],
    version: 'v2.1'
  };
}

// Detect the expanded thinking header (v2.1.x) for color patching
function detectExpandedHeader(content) {
  // Match: createElement(C,{dimColor:!0,italic:!0},"∴ Thinking…")
  // Also match if already patched with color (different prop order)
  // Unpatched: {dimColor:!0,italic:!0}
  // Patched: {italic:!0,color:"..."}
  const regexUnpatched = /([\$A-Za-z0-9]+)\.default\.createElement\(([A-Z]),\{dimColor:!0,italic:!0\},"∴ Thinking…"\)/;
  const regexPatched = /([\$A-Za-z0-9]+)\.default\.createElement\(([A-Z]),\{italic:!0,color:"[^"]+"\},"∴ Thinking…"\)/;

  let match = content.match(regexUnpatched);
  if (match) {
    return {
      fullMatch: match[0],
      reactVar: match[1],
      textElement: match[2],
      isPatched: false
    };
  }

  match = content.match(regexPatched);
  if (match) {
    return {
      fullMatch: match[0],
      reactVar: match[1],
      textElement: match[2],
      isPatched: true
    };
  }

  return null;
}

// Detect the thinking content wrapper (v2.1.x) for color patching
function detectThinkingContent(content) {
  // Unpatched: createElement(T,{paddingLeft:2},REACT.default.createElement(uV,null,A))
  // Patched v1: createElement(T,{paddingLeft:2},REACT.default.createElement(uV,null,V1.hex('...')(A)))
  // Patched v2: createElement(T,{paddingLeft:2},REACT.default.createElement(uV,null,A.split('\n\n').map(p=>p?V1.hex('...')(p):p).join('\n\n')))
  const regexUnpatched = /([\$A-Za-z0-9]+)\.default\.createElement\(T,\{paddingLeft:2\},\1\.default\.createElement\(([a-zA-Z0-9]+),null,([A-Z])\)\)/;
  const regexPatchedV1 = /([\$A-Za-z0-9]+)\.default\.createElement\(T,\{paddingLeft:2\},\1\.default\.createElement\(([a-zA-Z0-9]+),null,V1\.hex\('[^']+'\)\(([A-Z])\)\)\)/;
  const regexPatchedV2 = /([\$A-Za-z0-9]+)\.default\.createElement\(T,\{paddingLeft:2\},\1\.default\.createElement\(([a-zA-Z0-9]+),null,([A-Z])\.split\('\\\\n\\\\n'\)\.map\(p=>p\?V1\.hex\('[^']+'\)\(p\):p\)\.join\('\\\\n\\\\n'\)\)\)/;

  let match = content.match(regexUnpatched);
  if (match) {
    return {
      fullMatch: match[0],
      reactVar: match[1],
      contentComponent: match[2],
      contentVar: match[3],
      isPatched: false
    };
  }

  // Check for v2 patched format first (paragraph-based coloring)
  match = content.match(regexPatchedV2);
  if (match) {
    return {
      fullMatch: match[0],
      reactVar: match[1],
      contentComponent: match[2],
      contentVar: match[3],
      isPatched: true
    };
  }

  // Check for v1 patched format (simple wrap)
  match = content.match(regexPatchedV1);
  if (match) {
    return {
      fullMatch: match[0],
      reactVar: match[1],
      contentComponent: match[2],
      contentVar: match[3],
      isPatched: true
    };
  }

  return null;
}

// Detect the thinking case pattern (legacy pre-v2.1.x)
function detectThinkingPattern(content) {
  // Pattern: case"thinking":if(!X&&!Y)return null;return ZZZ.createElement(AAA,{addMargin:B,param:C,isTranscriptMode:D,verbose:E})
  // React var can include $ (like $7)
  const regex = /case"thinking":if\(!([A-Z])&&!([A-Z])\)return null;return ([$A-Za-z0-9]+)\.createElement\(([A-Za-z0-9]+),\{addMargin:([A-Z]),param:([A-Z]),isTranscriptMode:([A-Z]),verbose:([A-Z])\}\)/;
  const match = content.match(regex);

  if (!match) return null;

  return {
    fullMatch: match[0],
    guardVar1: match[1],
    guardVar2: match[2],
    reactVar: match[3],
    componentName: match[4],
    addMarginVar: match[5],
    paramVar: match[6],
    transcriptVar: match[7],
    verboseVar: match[8],
    version: 'legacy'
  };
}

// Main
function main() {
  console.log('🧠 Thinker - Claude Code Thinking Visibility Patch\n');
  console.log('🔍 Finding Claude Code installation...');

  const cliPath = findClaudeCode();
  if (!cliPath) {
    console.error('❌ Could not find Claude Code installation');
    console.error('   Searched common locations. Is Claude Code installed?');
    process.exit(1);
  }

  console.log(`📁 Found: ${cliPath}`);
  const backupPath = cliPath + '.backup';

  // Handle restore
  if (RESTORE) {
    if (!fs.existsSync(backupPath)) {
      console.error('❌ No backup found at:', backupPath);
      process.exit(1);
    }
    if (DRY_RUN) {
      console.log('🔄 [DRY RUN] Would restore from backup');
    } else {
      fs.copyFileSync(backupPath, cliPath);
      console.log('✅ Restored from backup');
    }
    return;
  }

  // Read file
  const content = fs.readFileSync(cliPath, 'utf8');
  const version = getVersion(content);
  console.log(`📦 Version: ${version}\n`);

  // Detect patterns - try v2.1.x first, then legacy
  const bannerInfo = extractBannerFunction(content);
  const thinkingComponentInfo = extractThinkingComponent(content);
  const thinkingInfoV2 = detectThinkingPatternV2(content);
  const thinkingInfoLegacy = detectThinkingPattern(content);
  const thinkingInfo = thinkingInfoV2 || thinkingInfoLegacy;
  const expandedHeaderInfo = detectExpandedHeader(content);
  const thinkingContentInfo = detectThinkingContent(content);

  // Resolve colors from theme preset, individual presets, or use as-is
  let resolvedHeaderColor, resolvedContentColor;

  if (THEME && THEME_PRESETS[THEME]) {
    // Theme preset overrides individual colors
    resolvedHeaderColor = THEME_PRESETS[THEME].header;
    resolvedContentColor = THEME_PRESETS[THEME].content;
  } else {
    resolvedHeaderColor = CUSTOM_COLOR ? (COLOR_PRESETS[CUSTOM_COLOR] || CUSTOM_COLOR) : null;
    // Content color defaults to header color if not specified separately
    resolvedContentColor = CONTENT_COLOR
      ? (COLOR_PRESETS[CONTENT_COLOR] || CONTENT_COLOR)
      : resolvedHeaderColor;
  }

  console.log('🔬 Pattern Detection:');

  // For v2.1.x, we patch the component instead of the banner
  if (thinkingComponentInfo) {
    console.log(`   ✅ Thinking component: collapsed view detected (v2.1.x)`);
  } else if (bannerInfo) {
    console.log(`   ✅ Banner function: ${bannerInfo.funcName}() [${bannerInfo.fullFunction.length} chars]`);
  } else {
    console.log('   ⚠️  Banner/component not detected');
  }

  if (thinkingInfo) {
    console.log(`   ✅ Thinking case: component ${thinkingInfo.componentName} (${thinkingInfo.version})`);
  } else {
    console.log('   ⚠️  Thinking case not detected');
  }

  if (expandedHeaderInfo) {
    console.log(`   ✅ Expanded header: "∴ Thinking…" text found`);
  } else {
    console.log('   ⚠️  Expanded header not detected');
  }

  if (thinkingContentInfo) {
    console.log(`   ✅ Thinking content: wrapper found (${thinkingContentInfo.contentComponent})`);
  } else {
    console.log('   ⚠️  Thinking content wrapper not detected');
  }

  if (resolvedHeaderColor || resolvedContentColor) {
    if (resolvedHeaderColor === resolvedContentColor) {
      console.log(`   🎨 Color: ${resolvedHeaderColor}`);
    } else {
      console.log(`   🎨 Header: ${resolvedHeaderColor || 'default'}`);
      console.log(`   🎨 Content: ${resolvedContentColor || 'default'}`);
    }
  }

  // Check what patterns we can work with
  const hasUnpatchedPatterns = (bannerInfo || (thinkingComponentInfo && !thinkingComponentInfo.isPatched)) || thinkingInfo;
  const hasAlreadyPatched = (thinkingComponentInfo?.isPatched) || (expandedHeaderInfo?.isPatched) || (thinkingContentInfo?.isPatched);
  const hasContentToColor = resolvedContentColor && thinkingContentInfo && !thinkingContentInfo.isPatched;

  if (CHECK_ONLY) {
    const patchable = hasUnpatchedPatterns || hasContentToColor;
    console.log(`\n${patchable ? '✅ Version is patchable!' : hasAlreadyPatched ? '⚠️  Already patched (use --restore to reset)' : '❌ Version may not be fully patchable'}`);
    process.exit(patchable ? 0 : 1);
  }

  if (!hasUnpatchedPatterns && !hasContentToColor) {
    if (hasAlreadyPatched) {
      console.log('\n⚠️  File appears already patched. Use --restore to reset, then re-patch.');
    } else {
      console.error('\n❌ No patchable patterns found.');
    }
    process.exit(1);
  }

  // Apply patches
  let patched = content;
  let patchCount = 0;

  console.log('\n📝 Applying patches:');

  // Patch 1a: v2.1.x component patch - change if(!(B||G)) to if(!1) to never show collapsed
  if (thinkingComponentInfo) {
    if (thinkingComponentInfo.isPatched) {
      console.log('   ⚠️  Component already patched');
    } else {
      const replacement = thinkingComponentInfo.fullMatch.replace(
        `if(!(${thinkingComponentInfo.transcriptVar}||${thinkingComponentInfo.verboseVar}))`,
        'if(!1)'
      );

      if (patched.includes(thinkingComponentInfo.fullMatch)) {
        if (!DRY_RUN) {
          patched = patched.replace(thinkingComponentInfo.fullMatch, replacement);
        }
        patchCount++;
        console.log('   ✅ Component collapsed view disabled' + (DRY_RUN ? ' [DRY RUN]' : ''));
      } else {
        console.log('   ❌ Component patch failed - pattern mismatch');
      }
    }
  }
  // Patch 1b: Legacy banner removal - use exact string replacement
  else if (bannerInfo) {
    const replacement = `function ${bannerInfo.funcName}({streamMode:A}){return null}`;

    if (patched.includes(bannerInfo.fullFunction)) {
      if (!DRY_RUN) {
        patched = patched.replace(bannerInfo.fullFunction, replacement);
      }
      patchCount++;
      console.log('   ✅ Banner removal' + (DRY_RUN ? ' [DRY RUN]' : ''));
    } else if (patched.includes(replacement)) {
      console.log('   ⚠️  Banner already patched');
    } else {
      console.log('   ❌ Banner patch failed - pattern mismatch');
    }
  }

  // Patch 2: Thinking visibility - remove guard and force transcript mode
  if (thinkingInfo) {
    let replacement;
    if (thinkingInfo.version === 'v2.1') {
      // v2.1.x: case"thinking":{...} format with hideInTranscript
      replacement = `case"thinking":{return ${thinkingInfo.reactVar}.createElement(${thinkingInfo.componentName},{addMargin:${thinkingInfo.addMarginVar},param:${thinkingInfo.paramVar},isTranscriptMode:!0,verbose:${thinkingInfo.verboseVar},hideInTranscript:!1}`;
    } else {
      // Legacy format
      replacement = `case"thinking":return ${thinkingInfo.reactVar}.createElement(${thinkingInfo.componentName},{addMargin:${thinkingInfo.addMarginVar},param:${thinkingInfo.paramVar},isTranscriptMode:!0,verbose:${thinkingInfo.verboseVar}})`;
    }

    if (patched.includes(thinkingInfo.fullMatch)) {
      if (!DRY_RUN) {
        patched = patched.replace(thinkingInfo.fullMatch, replacement);
      }
      patchCount++;
      console.log('   ✅ Thinking visibility' + (DRY_RUN ? ' [DRY RUN]' : ''));
    } else if (patched.includes('case"thinking":') && patched.includes('isTranscriptMode:!0')) {
      console.log('   ⚠️  Thinking already patched');
    } else {
      console.log('   ❌ Thinking patch failed - pattern mismatch');
    }
  }

  // Patch 3: Custom color for expanded header (optional)
  if (resolvedHeaderColor && expandedHeaderInfo) {
    if (expandedHeaderInfo.isPatched) {
      console.log('   ⚠️  Header color already patched');
    } else {
      // Remove dimColor and use color directly for vibrant colors
      const colorValue = `"${resolvedHeaderColor}"`;

      // Replace {dimColor:!0,italic:!0} with {italic:!0,color:"<color>"} - remove dimColor!
      const replacement = `${expandedHeaderInfo.reactVar}.default.createElement(${expandedHeaderInfo.textElement},{italic:!0,color:${colorValue}},"∴ Thinking…")`;

      if (patched.includes(expandedHeaderInfo.fullMatch)) {
        if (!DRY_RUN) {
          patched = patched.replace(expandedHeaderInfo.fullMatch, replacement);
        }
        patchCount++;
        console.log(`   ✅ Header color: ${resolvedHeaderColor}` + (DRY_RUN ? ' [DRY RUN]' : ''));
      } else {
        console.log('   ❌ Header color patch failed - pattern mismatch');
      }
    }
  }

  // Patch 4: Custom color for thinking content
  // We pass color as a prop to uV, then uV passes it to each t3 (Text) element
  // This uses Ink's native color prop which works reliably across line wraps
  if (resolvedContentColor && thinkingContentInfo) {
    if (thinkingContentInfo.isPatched) {
      console.log('   ⚠️  Content color already patched');
    } else {
      const colorValue = resolvedContentColor;

      // Step 4a: Modify uV to accept color prop and pass it to t3 elements
      // Find: function uV({children:A})
      // Replace: function uV({children:A,color:$TC})
      const uVSignatureRegex = /function uV\(\{children:([A-Z])\}\)/;
      const uVMatch = patched.match(uVSignatureRegex);

      if (uVMatch) {
        const childrenVar = uVMatch[1];
        const newSignature = `function uV({children:${childrenVar},color:$TC})`;
        patched = patched.replace(uVMatch[0], newSignature);

        // Step 4b: Wrap t3 in C (Text) which accepts color prop
        // t3 is a custom component that ignores color prop, but C cascades it
        // Exact pattern from uV: Y.push(XV1.default.createElement(t3,{key:Y.length},J.trim()))
        // Replace with: Y.push(XV1.default.createElement(C,{key:Y.length,color:$TC},XV1.default.createElement(t3,null,J.trim())))

        // Match the exact flush pattern - variables may differ but structure is consistent
        // Pattern: ARRAY.push(REACT.default.createElement(t3,{key:ARRAY.length},TEXT.trim()))
        const flushRegex = /([A-Z])\.push\(([A-Za-z0-9$]+)\.default\.createElement\(t3,\{key:\1\.length\},([A-Z])\.trim\(\)\)\)/g;

        patched = patched.replace(flushRegex, (match, arrayVar, reactVar, textVar) => {
          // Wrap t3 in C with color prop
          return `${arrayVar}.push(${reactVar}.default.createElement(C,{key:${arrayVar}.length,color:$TC},${reactVar}.default.createElement(t3,null,${textVar}.trim())))`;
        });

        // Step 4c: Modify NbA to pass color to uV
        // Find: createElement(uV,null,A) in the thinking content context
        // Replace: createElement(uV,{color:'#ff69b4'},A)
        const callPattern = `${thinkingContentInfo.reactVar}.default.createElement(${thinkingContentInfo.contentComponent},null,${thinkingContentInfo.contentVar})`;
        const callReplacement = `${thinkingContentInfo.reactVar}.default.createElement(${thinkingContentInfo.contentComponent},{color:'${colorValue}'},${thinkingContentInfo.contentVar})`;

        if (patched.includes(callPattern)) {
          patched = patched.replace(callPattern, callReplacement);
          patchCount++;
          console.log(`   ✅ Content color: ${resolvedContentColor} (via Ink color prop)` + (DRY_RUN ? ' [DRY RUN]' : ''));
        } else {
          console.log('   ❌ Content color patch failed - uV call pattern mismatch');
        }
      } else {
        console.log('   ❌ Content color patch failed - uV signature not found');
      }
    }
  }

  if (patchCount === 0) {
    console.log('\n⚠️  No patches applied. File may already be patched.');
    return;
  }

  // Write changes
  if (!DRY_RUN) {
    // Create backup if doesn't exist
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(cliPath, backupPath);
      console.log(`\n💾 Backup created: ${backupPath}`);
    } else {
      console.log(`\n💾 Backup exists: ${backupPath}`);
    }

    fs.writeFileSync(cliPath, patched);
    console.log('✅ Patches applied successfully!');
    console.log('\n🔄 Restart Claude Code for changes to take effect.');
  } else {
    console.log('\n🔍 Dry run complete. Run without --dry-run to apply patches.');
  }
}

main();

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
  'watermelon': { header: '#32cd32', content: '#FF77FF' },
  'emerald-saffron': { header: '#00C853', content: '#F4C24D' },
  'bubblegum': { header: '#87ceeb', content: '#FF77FF' },
  'carrot': { header: '#ff8c00', content: '#32cd32' },
  'autumn': { header: '#FFBF00', content: '#D2691E' },
  'ocean': { header: '#98D8C8', content: '#20B2AA' },
  'forest': { header: '#90EE90', content: '#228B22' },
  'cherry-blossom': { header: '#FF69B4', content: '#FFB6C1' },
  'cyberpunk': { header: '#FCE300', content: '#00F0FF' },
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

// ============================================
// ANCHOR-BASED PATTERN UTILITIES
// These functions use stable string anchors and
// bracket balancing instead of hardcoded minified names
// ============================================

/**
 * Find matching closing paren/bracket/brace starting from an opening one
 * Handles nested structures and skips string literals
 * @param {string} code - Source code
 * @param {number} start - Index of opening paren/bracket/brace
 * @returns {number} Index of matching closer, or -1 if not found
 */
function findMatchingClose(code, start) {
  const openers = '([{';
  const closers = ')]}';
  const opener = code[start];
  const openerIdx = openers.indexOf(opener);
  if (openerIdx === -1) return -1;
  const closer = closers[openerIdx];

  let depth = 1;
  let i = start + 1;
  let inString = false;
  let stringChar = null;

  while (i < code.length && depth > 0) {
    const ch = code[i];
    const prev = code[i - 1];

    // Handle string literals (skip content inside strings)
    if (!inString && (ch === '"' || ch === "'" || ch === '`')) {
      inString = true;
      stringChar = ch;
    } else if (inString && ch === stringChar && prev !== '\\') {
      inString = false;
      stringChar = null;
    } else if (!inString) {
      if (ch === opener) depth++;
      else if (ch === closer) depth--;
    }
    i++;
  }

  return depth === 0 ? i - 1 : -1;
}

/**
 * Find a createElement call that contains a given index position
 * Searches backward for ".createElement(" then verifies containment
 * @param {string} code - Source code
 * @param {number} containsIdx - Index that must be inside the call
 * @param {number} searchWindow - How far back to search (default 500)
 * @returns {object|null} {start, end, callText, reactVar} or null
 */
function findCreateElementContaining(code, containsIdx, searchWindow = 500) {
  const windowStart = Math.max(0, containsIdx - searchWindow);
  const searchRegion = code.substring(windowStart, containsIdx);

  // Find all ".createElement(" occurrences in the search region
  let searchIdx = searchRegion.length;

  while (searchIdx > 0) {
    const relativeStart = searchRegion.lastIndexOf('.createElement(', searchIdx - 1);
    if (relativeStart === -1) break;

    const absoluteStart = windowStart + relativeStart;
    const parenStart = absoluteStart + '.createElement'.length;
    const parenEnd = findMatchingClose(code, parenStart);

    // Check if containsIdx is within this createElement call
    if (parenEnd !== -1 && absoluteStart <= containsIdx && containsIdx <= parenEnd) {
      // Extract the React variable name before .createElement
      const preCall = code.substring(Math.max(0, absoluteStart - 50), absoluteStart);
      const reactVarMatch = preCall.match(/([A-Za-z0-9$_]+)\.default$/);

      return {
        start: absoluteStart,
        end: parenEnd,
        callText: code.substring(absoluteStart, parenEnd + 1),
        reactVar: reactVarMatch ? reactVarMatch[1] : null
      };
    }
    searchIdx = relativeStart;
  }

  return null;
}

/**
 * Detect thinking content wrapper using stable anchors
 * Uses "∴ Thinking…" and "paddingLeft:2" as anchors to find the content component
 * @param {string} content - CLI.js file content
 * @returns {object|null} Detection result with extracted variable names
 */
function detectThinkingContentAnchored(content) {
  // Find the "∴ Thinking…" header anchor (expanded view header)
  const headerAnchor = '"∴ Thinking…"';
  const headerIdx = content.indexOf(headerAnchor);
  if (headerIdx === -1) return null;

  // The structure is:
  // createElement(Box, {flexDirection:..., ...},
  //   createElement(Text, {dimColor:!0,italic:!0}, "∴ Thinking…"),
  //   createElement(Box, {paddingLeft:2},
  //     createElement(ContentComp, null, contentVar)
  //   )
  // )

  // Find paddingLeft:2 near the header (within 300 chars after)
  const searchRegion = content.substring(headerIdx, headerIdx + 300);
  const paddingIdx = searchRegion.indexOf('paddingLeft:2');
  if (paddingIdx === -1) return null;

  const absolutePaddingIdx = headerIdx + paddingIdx;

  // Find the createElement call containing paddingLeft:2
  const paddingCreateElement = findCreateElementContaining(content, absolutePaddingIdx);
  if (!paddingCreateElement) return null;

  // Inside this call, find the inner createElement for the content component
  // Pattern: REACT.default.createElement(COMP,null,VAR) or REACT.default.createElement(COMP,{...},VAR)
  const innerRegex = /([A-Za-z0-9$_]+)\.default\.createElement\(([A-Za-z0-9$_]+),(null|\{[^}]*\}),([A-Z])\)/;
  const innerMatch = paddingCreateElement.callText.match(innerRegex);
  if (!innerMatch) return null;

  // Determine if patched by checking if props is not null
  const isPatched = innerMatch[3] !== 'null';

  return {
    fullMatch: paddingCreateElement.callText,
    reactVar: innerMatch[1],
    wrapperElement: null, // We don't need this for the new approach
    contentComponent: innerMatch[2],
    contentProps: innerMatch[3],
    contentVar: innerMatch[4],
    callStart: paddingCreateElement.start,
    callEnd: paddingCreateElement.end,
    isPatched
  };
}

/**
 * Detect the content component function signature using the component name
 * @param {string} content - CLI.js file content
 * @param {string} componentName - Name of the content component (e.g., 'oO')
 * @returns {object|null} Function info with extracted variable names
 */
function detectContentComponentFunction(content, componentName) {
  // v2.1.17+: function COMP(A){...{children:VAR}=A...}
  const signatureRegexNew = new RegExp(
    `function ${componentName}\\(([A-Z])\\)\\{[^}]*\\{children:([A-Za-z])\\}=\\1`
  );
  // Legacy: function COMP({children:VAR}){
  const signatureRegexLegacy = new RegExp(
    `function ${componentName}\\(\\{children:([A-Z])\\}\\)\\{`
  );

  let signatureMatch = content.match(signatureRegexNew);
  let childrenVar, funcStart, signatureStr;

  if (signatureMatch) {
    // New format: function oO(A){...{children:q}=A
    childrenVar = signatureMatch[2];
    funcStart = content.indexOf(`function ${componentName}(${signatureMatch[1]})`);
    signatureStr = signatureMatch[0];
  } else {
    signatureMatch = content.match(signatureRegexLegacy);
    if (!signatureMatch) return null;
    childrenVar = signatureMatch[1];
    funcStart = content.indexOf(signatureMatch[0]);
    signatureStr = signatureMatch[0];
  }

  // Search within ~1500 chars of the function start for the push pattern
  const funcRegion = content.substring(funcStart, funcStart + 1500);

  // Generic push pattern that captures the actual variable names
  const pushRegex = /([A-Z])\.push\(([A-Za-z0-9$_]+)\.default\.createElement\(([A-Za-z0-9$_]+),\{key:\1\.length\},([A-Z])\.trim\(\)\)\)/;
  const pushMatch = funcRegion.match(pushRegex);

  return {
    signatureMatch: signatureStr,
    childrenVar,
    funcStart,
    isNewFormat: !!content.match(signatureRegexNew),
    pushInfo: pushMatch ? {
      fullMatch: pushMatch[0],
      arrayVar: pushMatch[1],
      reactVar: pushMatch[2],
      textElement: pushMatch[3],
      stringVar: pushMatch[4]
    } : null
  };
}

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
  watermelon       Green header + magenta content 🍉
  emerald-saffron  Emerald header + gold content 🌿
  bubblegum        Sky blue header + magenta content 🫧
  carrot           Orange header + green content 🥕
  autumn           Amber header + burnt orange content 🍂
  ocean            Seafoam header + teal content 🌊
  forest           Moss header + emerald content 🌲
  cherry-blossom   Pink header + soft rose content 🌸
  cyberpunk        Yellow header + cyan content 🤖

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

// Extract the thinking component that shows collapsed/expanded view
function extractThinkingComponent(content) {
  // v2.1.17+: Block-based structure with memoization
  // Unpatched: if(!(z||w)){...,"∴ Thinking ("...}
  // Patched: if(!1){...}
  const collapsedRegex = /if\(!\(([a-zA-Z])\|\|([a-zA-Z])\)\)\{[^"]*"∴ Thinking \(/;
  const patchedRegex = /if\(!1\)\{[^"]*"∴ Thinking \(/;

  let match = content.match(collapsedRegex);
  if (match) {
    return {
      fullMatch: `if(!(${match[1]}||${match[2]})){`,
      transcriptVar: match[1],
      verboseVar: match[2],
      isPatched: false
    };
  }

  if (content.match(patchedRegex)) {
    return {
      fullMatch: 'if(!1){',
      isPatched: true
    };
  }

  return null;
}

// v2.1.32: Extract thinking component from Cj6 function
// The collapsed view is controlled by: let D=z,j; where z=isTranscriptMode
// Patching: change "let D=z,j;" to "let D=!0,j;" to force expanded view
function extractThinkingComponentV219(content) {
  // v2.1.32 pattern: function Cj6 with 4-param destructuring (no verbose)
  // {param:K,addMargin:Y,isTranscriptMode:z,hideInTranscript:w}=A
  const funcMatch = content.match(/function ([A-Za-z0-9]+)\(([A-Z])\)\{let ([a-z])=A1\(\d+\),\{param:([A-Z]),addMargin:([A-Z]),isTranscriptMode:([a-z]),hideInTranscript:([a-z])\}=\2/);

  if (!funcMatch) return null;

  const funcName = funcMatch[1];
  const transcriptVar = funcMatch[6]; // 'z' in current build

  // Find the guard pattern: let D=z,j;
  const guardPattern = new RegExp(`let ([A-Z])=${transcriptVar},([a-z]);`);
  const guardMatch = content.match(guardPattern);

  if (guardMatch) {
    return {
      fullMatch: `let ${guardMatch[1]}=${transcriptVar},${guardMatch[2]};`,
      expandedVar: guardMatch[1],      // 'D'
      transcriptVar: transcriptVar,    // 'z'
      secondVar: guardMatch[2],        // 'j'
      funcName,
      isPatched: false,
      version: 'v2.1.32'
    };
  }

  // Check for already patched: let D=!0,j;
  const patchedPattern = /let ([A-Z])=!0,([a-z]);/;
  const patchedMatch = content.match(patchedPattern);

  if (patchedMatch) {
    return {
      fullMatch: `let ${patchedMatch[1]}=!0,${patchedMatch[2]};`,
      funcName,
      isPatched: true,
      version: 'v2.1.32'
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

// v2.1.32: Detect the thinking case pattern with 2-variable guard and memo flag
// Pattern: V=!1,q[0]=V;else V=q[0];let Z=V;...case"thinking":{if(!j&&!Z)return null;
// Patching: change V=!1 to V=!0 to make Z=true, bypassing the guard
function detectThinkingPatternV219(content) {
  // Find the memo flag initialization: V=!1,q[0]=V;else V=q[0];let Z=V;
  const memoPattern = /if\(q\[0\]===Symbol\.for\("react\.memo_cache_sentinel"\)\)([A-Z])=!1,q\[0\]=\1;else \1=q\[0\];let ([A-Z])=\1;switch\([A-Z]\.type\)\{/;
  const memoMatch = content.match(memoPattern);

  if (memoMatch) {
    // Also find the case"thinking" to get component info
    const casePattern = /case"thinking":\{if\(!([a-z])&&!([A-Z])\)return null;let ([A-Z])=[^;]+;[^}]*?([A-Za-z0-9]+)\.createElement\(([A-Za-z0-9]+),\{addMargin:([A-Z]),param:([A-Z]),isTranscriptMode:([a-z]),hideInTranscript:([A-Z])\}/;
    const caseMatch = content.match(casePattern);

    return {
      fullMatch: memoMatch[0],
      memoVar: memoMatch[1],      // 'V'
      guardVar: memoMatch[2],     // 'Z'
      componentName: caseMatch ? caseMatch[5] : 'unknown',
      isPatched: false,
      version: 'v2.1.32'
    };
  }

  // Check for already patched: V=!0
  const patchedPattern = /if\(q\[0\]===Symbol\.for\("react\.memo_cache_sentinel"\)\)([A-Z])=!0,q\[0\]=\1;else \1=q\[0\];let ([A-Z])=\1;switch\([A-Z]\.type\)\{/;
  const patchedMatch = content.match(patchedPattern);

  if (patchedMatch) {
    return { isPatched: true, version: 'v2.1.32' };
  }

  return null;
}

// Detect the thinking case pattern
function detectThinkingPatternV2(content) {
  // Pattern: case"thinking":{if(!D&&!H)return null;...createElement(YW1,{addMargin:Y,param:q,isTranscriptMode:D,verbose:H,hideInTranscript:T})...}
  const regex = /case"thinking":\{if\(!([A-Za-z])&&!([A-Za-z])\)return null;.*?([A-Za-z0-9$]+)\.createElement\(([A-Za-z0-9]+),\{addMargin:([A-Za-z]),param:([A-Za-z]),isTranscriptMode:([A-Za-z]),verbose:([A-Za-z]),hideInTranscript:([A-Za-z])\}/;

  // Check for already patched (no guard, forced values)
  const patchedRegex = /case"thinking":\{(?:let [A-Za-z]=)?[^}]*\.createElement\([A-Za-z0-9]+,\{addMargin:[A-Za-z],param:[A-Za-z],isTranscriptMode:!0,verbose:[A-Za-z],hideInTranscript:!1\}/;

  const match = content.match(regex);
  if (match) {
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
      hideInTranscriptVar: match[9]
    };
  }

  if (content.match(patchedRegex)) {
    return { isPatched: true };
  }

  return null;
}

// Detect the expanded thinking header (v2.1.x) for color patching
function detectExpandedHeader(content) {
  // Match: createElement($,{dimColor:!0,italic:!0},"∴ Thinking…") or createElement(C,...)
  // Also match if already patched with color (different prop order)
  // Unpatched: {dimColor:!0,italic:!0}
  // Patched: {italic:!0,color:"..."}
  // Note: Text element can be $ or single letter like C
  const regexUnpatched = /([\$A-Za-z0-9]+)\.default\.createElement\(([$A-Z]),\{dimColor:!0,italic:!0\},"∴ Thinking…"\)/;
  const regexPatched = /([\$A-Za-z0-9]+)\.default\.createElement\(([$A-Z]),\{italic:!0,color:"[^"]+"\},"∴ Thinking…"\)/;

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

// v2.1.19+: Detect expanded header with variable text reference
// Pattern: createElement(f,{dimColor:!0,italic:!0},D,"…") where D holds "∴ Thinking"
function detectExpandedHeaderV219(content) {
  // Unpatched: {dimColor:!0,italic:!0},VAR,"…"
  const regexUnpatched = /([\$A-Za-z0-9]+)\.default\.createElement\(([a-zA-Z]),\{dimColor:!0,italic:!0\},([A-Z]),"…"\)/;
  // Patched: {italic:!0,color:"..."},VAR,"…"
  const regexPatched = /([\$A-Za-z0-9]+)\.default\.createElement\(([a-zA-Z]),\{italic:!0,color:"[^"]+"\},([A-Z]),"…"\)/;

  let match = content.match(regexUnpatched);
  if (match) {
    return {
      fullMatch: match[0],
      reactVar: match[1],
      textElement: match[2],
      textVar: match[3],
      isPatched: false,
      version: 'v2.1.19'
    };
  }

  match = content.match(regexPatched);
  if (match) {
    return {
      fullMatch: match[0],
      reactVar: match[1],
      textElement: match[2],
      textVar: match[3],
      isPatched: true,
      version: 'v2.1.19'
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

// v2.1.32: Detect thinking content wrapper - two patterns exist
// Pattern A: createElement(I,{paddingLeft:2},createElement(f,null,createElement(R3,null,z)))
// Pattern B: createElement(I,{paddingLeft:2},createElement($J,{dimColor:!0},H))
function detectThinkingContentV219(content) {
  // Pattern B: $J with dimColor (this is the main thinking content pattern)
  // Unpatched: createElement($J,{dimColor:!0},VAR)
  const regexBUnpatched = /([\$A-Za-z0-9]+)\.default\.createElement\(I,\{paddingLeft:2\},\1\.default\.createElement\(\$J,\{dimColor:!0\},([A-Z])\)\)/;
  // Patched: createElement($J,{dimColor:!0,color:'...'},VAR)
  const regexBPatched = /([\$A-Za-z0-9]+)\.default\.createElement\(I,\{paddingLeft:2\},\1\.default\.createElement\(\$J,\{dimColor:!0,color:'[^']+'\},([A-Z])\)\)/;

  let match = content.match(regexBUnpatched);
  if (match) {
    return {
      fullMatch: match[0],
      reactVar: match[1],
      contentComponent: '$J',
      contentVar: match[2],
      patternType: 'B',
      isPatched: false,
      version: 'v2.1.32'
    };
  }

  match = content.match(regexBPatched);
  if (match) {
    return {
      fullMatch: match[0],
      reactVar: match[1],
      contentComponent: '$J',
      contentVar: match[2],
      patternType: 'B',
      isPatched: true,
      version: 'v2.1.32'
    };
  }

  // Pattern A: Triple nesting f->R3 (fallback)
  // Unpatched: createElement(f,null,createElement(R3,null,VAR))
  const regexAUnpatched = /([\$A-Za-z0-9]+)\.(?:default\.)?createElement\(I,\{paddingLeft:2\},\1\.(?:default\.)?createElement\(f,null,\1\.(?:default\.)?createElement\(R3,null,([a-z])\)\)\)/;
  // Patched: createElement(f,{color:'...'},createElement(R3,null,VAR))
  const regexAPatched = /([\$A-Za-z0-9]+)\.(?:default\.)?createElement\(I,\{paddingLeft:2\},\1\.(?:default\.)?createElement\(f,\{color:'[^']+'\},\1\.(?:default\.)?createElement\(R3,null,([a-z])\)\)\)/;

  match = content.match(regexAUnpatched);
  if (match) {
    return {
      fullMatch: match[0],
      reactVar: match[1],
      contentComponent: 'f',
      innerComponent: 'R3',
      contentVar: match[2],
      patternType: 'A',
      isPatched: false,
      version: 'v2.1.32'
    };
  }

  match = content.match(regexAPatched);
  if (match) {
    return {
      fullMatch: match[0],
      reactVar: match[1],
      contentComponent: 'f',
      innerComponent: 'R3',
      contentVar: match[2],
      patternType: 'A',
      isPatched: true,
      version: 'v2.1.32'
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

  // Detect patterns - v2.1.19 only
  const thinkingComponentInfo = extractThinkingComponentV219(content);
  const thinkingInfo = detectThinkingPatternV219(content);
  const expandedHeaderInfo = detectExpandedHeaderV219(content);
  const thinkingContentInfo = detectThinkingContentV219(content);

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

  if (thinkingComponentInfo) {
    console.log(`   ✅ Collapsed view: guard detected`);
  } else {
    console.log('   ⚠️  Collapsed view not detected');
  }

  if (thinkingInfo) {
    console.log(`   ✅ Thinking case: component ${thinkingInfo.componentName}`);
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
  const hasUnpatchedPatterns = (thinkingComponentInfo && !thinkingComponentInfo.isPatched) || (thinkingInfo && !thinkingInfo.isPatched);
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

  // Patch 1: Disable collapsed view - change "let D=z,j;" to "let D=!0,j;"
  if (thinkingComponentInfo) {
    if (thinkingComponentInfo.isPatched) {
      console.log('   ⚠️  Component already patched');
    } else {
      // v2.1.32: Replace "let D=z,j;" with "let D=!0,j;"
      const replacement = `let ${thinkingComponentInfo.expandedVar}=!0,${thinkingComponentInfo.secondVar};`;

      if (patched.includes(thinkingComponentInfo.fullMatch)) {
        if (!DRY_RUN) {
          patched = patched.replace(thinkingComponentInfo.fullMatch, replacement);
        }
        patchCount++;
        console.log('   ✅ Collapsed view disabled' + (DRY_RUN ? ' [DRY RUN]' : ''));
      } else {
        console.log('   ❌ Component patch failed - pattern mismatch');
      }
    }
  }

  // Patch 2: Thinking visibility - change memo flag V=!1 to V=!0
  if (thinkingInfo) {
    if (thinkingInfo.isPatched) {
      console.log('   ⚠️  Thinking already patched');
    } else {
      // v2.1.32: Change V=!1 to V=!0 to make Z=true, bypassing guard
      const replacement = thinkingInfo.fullMatch.replace(
        `${thinkingInfo.memoVar}=!1,q[0]=${thinkingInfo.memoVar}`,
        `${thinkingInfo.memoVar}=!0,q[0]=${thinkingInfo.memoVar}`
      );

      if (patched.includes(thinkingInfo.fullMatch)) {
        if (!DRY_RUN) {
          patched = patched.replace(thinkingInfo.fullMatch, replacement);
        }
        patchCount++;
        console.log('   ✅ Thinking visibility forced' + (DRY_RUN ? ' [DRY RUN]' : ''));
      } else {
        console.log('   ❌ Thinking patch failed - pattern mismatch');
      }
    }
  }

  // Patch 3: Custom color for expanded header (optional)
  // v2.1.19: createElement(f,{dimColor:!0,italic:!0},D,"…") where D is variable
  if (resolvedHeaderColor && expandedHeaderInfo) {
    if (expandedHeaderInfo.isPatched) {
      console.log('   ⚠️  Header color already patched');
    } else {
      const colorValue = `"${resolvedHeaderColor}"`;
      const replacement = `${expandedHeaderInfo.reactVar}.default.createElement(${expandedHeaderInfo.textElement},{italic:!0,color:${colorValue}},${expandedHeaderInfo.textVar},"…")`;

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
  // v2.1.32: Thread color through $J → R3
  if (resolvedContentColor && thinkingContentInfo) {
    if (thinkingContentInfo.isPatched) {
      console.log('   ⚠️  Content color already patched');
    } else {
      const colorValue = resolvedContentColor;
      const contentComp = thinkingContentInfo.contentComponent;
      const reactVar = thinkingContentInfo.reactVar;
      const contentVar = thinkingContentInfo.contentVar;
      let colorPatchCount = 0;

      if (thinkingContentInfo.patternType === 'B') {
        // Pattern B: $J component with dimColor
        // Step 1: Add color to $J call site
        // createElement($J,{dimColor:!0},H) → createElement($J,{dimColor:!0,color:'HEX'},H)
        const callPattern = `${reactVar}.default.createElement($J,{dimColor:!0},${contentVar})`;
        const callReplacement = `${reactVar}.default.createElement($J,{dimColor:!0,color:'${colorValue}'},${contentVar})`;

        if (patched.includes(callPattern)) {
          if (!DRY_RUN) {
            patched = patched.replace(callPattern, callReplacement);
          }
          colorPatchCount++;
        }

        // Step 2: Modify $J function to accept color prop
        // Find: {children:K,dimColor:Y}=A
        // Change to: {children:K,dimColor:Y,color:$cc}=A
        const djPattern = /(function \$J\([A-Z]\)\{let [a-z]=A1\(\d+\),\{children:)([A-Z])(,dimColor:)([A-Z])(\}=[A-Z])/;
        const djMatch = patched.match(djPattern);
        if (djMatch) {
          if (!DRY_RUN) {
            patched = patched.replace(djMatch[0], `${djMatch[1]}${djMatch[2]}${djMatch[3]}${djMatch[4]},color:$cc${djMatch[5]}`);
          }
          colorPatchCount++;
        }

        // Step 3: Forward color to R3 text segments in $J
        // Find: R3,{key:_.length,dimColor:Y},J.trim())
        // Change to: R3,{key:_.length,dimColor:Y,color:$cc},J.trim())
        if (!DRY_RUN) {
          const before = patched;
          patched = patched.replace(
            /R3,\{key:([A-Z_])\.length,dimColor:([A-Z])\},([A-Z])\.trim\(\)\)/g,
            'R3,{key:$1.length,dimColor:$2,color:$cc},$3.trim())'
          );
          if (patched !== before) colorPatchCount++;
        } else {
          if (/R3,\{key:[A-Z_]\.length,dimColor:[A-Z]\},[A-Z]\.trim\(\)\)/.test(patched)) colorPatchCount++;
        }

        // Step 4: Patch R3 component to accept and use color prop
        // R3 renders to a_ (Text) elements - we need to forward color there
        // Find: R3=REACT.default.memo(function(q){let K=A1(12),{children:Y,dimColor:z}=q;
        // Change to: {children:Y,dimColor:z,color:$rc}=q;
        const r3Pattern = /(R3=[A-Za-z0-9]+\.default\.memo\(function\([a-z]\)\{let [A-Z]=A1\(\d+\),\{children:)([A-Z])(,dimColor:)([a-z])(\}=[a-z])/;
        const r3Match = patched.match(r3Pattern);
        if (r3Match) {
          if (!DRY_RUN) {
            patched = patched.replace(r3Match[0], `${r3Match[1]}${r3Match[2]}${r3Match[3]}${r3Match[4]},color:$rc${r3Match[5]}`);
          }
          colorPatchCount++;
        }

        // Step 5: Forward color to a_ (Text) elements in R3
        // R3 has multiple createElement(a_,...) calls that need color added
        // Pattern: createElement(a_,{dim:!0},... → createElement(a_,{dim:!0,color:$rc},...
        // Pattern: createElement(a_,null,... → createElement(a_,{color:$rc},...
        // Search for R3 component definition (not array assignments)
        const r3MemoMarker = 'R3=mP.default.memo(function';
        const r3Start = patched.indexOf(r3MemoMarker);
        if (r3Start !== -1) {
          // Find end of R3 memo function by counting parens from the memo( opening
          const memoOpenParen = r3Start + 'R3=mP.default.memo'.length;
          let depth = 0, r3End = memoOpenParen;
          for (let i = memoOpenParen; i < patched.length && i < memoOpenParen + 3000; i++) {
            if (patched[i] === '(') depth++;
            if (patched[i] === ')') { depth--; if (depth === 0) { r3End = i + 1; break; } }
          }

          let r3Body = patched.substring(r3Start, r3End);
          const beforeR3 = r3Body;

          if (!DRY_RUN) {
            // Add color to a_ elements with {dim:!0}
            r3Body = r3Body.replace(
              /createElement\(a_,\{dim:!0\},/g,
              'createElement(a_,{dim:!0,color:$rc},'
            );
            // Add color to a_ elements with null props
            r3Body = r3Body.replace(
              /createElement\(a_,null,/g,
              'createElement(a_,{color:$rc},'
            );
          }

          if (r3Body !== beforeR3) {
            patched = patched.substring(0, r3Start) + r3Body + patched.substring(r3End);
            colorPatchCount++;
          }
        }

      } else if (thinkingContentInfo.patternType === 'A') {
        // Pattern A: Triple nesting f->R3
        // Add color to f: createElement(f,null,...) → createElement(f,{color:'HEX'},...)
        const callPattern = new RegExp(
          `(${reactVar}\\.(?:default\\.)?createElement\\(f,)null(,${reactVar}\\.(?:default\\.)?createElement\\(R3,null,${contentVar}\\)\\))`,
          'g'
        );

        if (!DRY_RUN) {
          const before = patched;
          patched = patched.replace(callPattern, `$1{color:'${colorValue}'}$2`);
          if (patched !== before) colorPatchCount++;
        } else {
          if (callPattern.test(patched)) colorPatchCount++;
        }
      }

      if (colorPatchCount > 0) {
        patchCount++;
        console.log(`   ✅ Content color: ${resolvedContentColor} (${colorPatchCount} modifications)` + (DRY_RUN ? ' [DRY RUN]' : ''));
      } else {
        console.log(`   ❌ Content color: no patterns matched`);
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

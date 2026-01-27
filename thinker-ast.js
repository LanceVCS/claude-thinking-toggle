#!/usr/bin/env node
/**
 * Claude Code Thinking Visibility Patch - "Thinker" (AST-based)
 *
 * Uses AST parsing with stable string anchors instead of fragile regex.
 * More robust against minifier changes.
 *
 * Usage:
 *   node thinker-ast.js           # Apply patch
 *   node thinker-ast.js --dry-run # Preview changes
 *   node thinker-ast.js --restore # Restore from backup
 *   node thinker-ast.js --check   # Check if patchable
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const acorn = require('acorn');
const walk = require('acorn-walk');
const MagicString = require('magic-string');

// ============================================
// PHASE 1: FOUNDATION - CLI & CONFIGURATION
// ============================================

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESTORE = args.includes('--restore');
const CHECK_ONLY = args.includes('--check');
const HELP = args.includes('--help') || args.includes('-h');
const DEBUG = args.includes('--debug');

// Parse --color=<value> argument (for header)
const colorArg = args.find(a => a.startsWith('--color='));
const CUSTOM_COLOR = colorArg ? colorArg.split('=')[1] : null;

// Parse --content-color=<value> argument (for thinking body)
const contentColorArg = args.find(a => a.startsWith('--content-color='));
const CONTENT_COLOR = contentColorArg ? contentColorArg.split('=')[1] : null;

// Parse --theme=<value> argument (for preset theme combos)
const themeArg = args.find(a => a.startsWith('--theme='));
const THEME = themeArg ? themeArg.split('=')[1] : null;

// Theme presets (header + content)
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

// Color presets
const COLOR_PRESETS = {
  'dim': null,
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

/**
 * Validate and normalize a color value
 * Security: Prevents code injection through color values
 * @param {string} color - Color name or hex value
 * @returns {string} - Validated color value
 * @throws {Error} - If color is invalid
 */
function validateColor(color) {
  if (color === null || color === undefined) return null;

  // Check preset colors (use hasOwnProperty to avoid prototype pollution)
  if (Object.prototype.hasOwnProperty.call(COLOR_PRESETS, color)) {
    return COLOR_PRESETS[color];
  }

  // Only allow valid hex: #RGB or #RRGGBB (not #RGBA or #RRGGBBAA)
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
    return color;
  }

  throw new Error(`Invalid color "${color}". Use a preset name or hex value (#RGB or #RRGGBB).`);
}

// Exit codes
const EXIT = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  AMBIGUOUS: 2,
  VERIFICATION_FAILED: 3,
  ALREADY_PATCHED: 4,
};

function debug(...args) {
  if (DEBUG) console.log('[DEBUG]', ...args);
}

if (HELP) {
  console.log(`
🧠 Thinker (AST) - Claude Code Thinking Visibility Patch

Usage:
  node thinker-ast.js                       Apply the patch (default dim gray)
  node thinker-ast.js --theme=watermelon    Apply preset theme
  node thinker-ast.js --color=green         Apply with custom header color
  node thinker-ast.js --content-color=pink  Apply with custom content color
  node thinker-ast.js --dry-run             Preview changes without applying
  node thinker-ast.js --restore             Restore from backup
  node thinker-ast.js --check               Check if current version is patchable
  node thinker-ast.js --debug               Show debug output

Theme presets:
  watermelon, emerald-saffron, bubblegum, carrot, autumn,
  ocean, forest, cherry-blossom, cyberpunk

Color options:
  Named:  cyan, green, magenta, yellow, blue, red, white
  Presets: pink, orange, purple, teal, gold, lime, coral, sky
  Hex:    #ff69b4, #4ecdc4, etc.

What it does:
  1. Removes the collapsed "∴ Thinking..." banner
  2. Forces thinking content to display inline automatically
  3. Optionally applies custom colors to header and content
  `);
  process.exit(EXIT.SUCCESS);
}

// ============================================
// PHASE 1: FILE DISCOVERY
// ============================================

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

function getVersion(content) {
  const match = content.match(/\/\/ Version: ([\d.]+)/);
  return match ? match[1] : 'unknown';
}

// ============================================
// PHASE 1: SAFETY UTILITIES
// ============================================

function atomicWrite(targetPath, content, backupPath) {
  // Step 1: Create backup if doesn't exist
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(targetPath, backupPath);
    console.log(`💾 Backup created: ${backupPath}`);
  } else {
    console.log(`💾 Backup exists: ${backupPath}`);
  }

  // Step 2: Preserve original file permissions
  const originalStats = fs.statSync(targetPath);
  const originalMode = originalStats.mode;

  // Step 3: Write to temp file in same directory
  const tempPath = targetPath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  const fd = fs.openSync(tempPath, 'w');
  fs.writeSync(fd, content);
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  // Step 4: Restore original permissions on temp file
  fs.chmodSync(tempPath, originalMode);

  // Step 5: Atomic rename
  fs.renameSync(tempPath, targetPath);
  return true;
}

function restoreFromBackup(cliPath, backupPath) {
  if (!fs.existsSync(backupPath)) {
    console.error('❌ No backup found at:', backupPath);
    return false;
  }
  fs.copyFileSync(backupPath, cliPath);
  console.log('✅ Restored from backup');
  return true;
}

// ============================================
// PHASE 2: AST DETECTION ENGINE
// ============================================

function parseWithAcorn(code) {
  try {
    return acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: 'script',
      allowHashBang: true,
      allowReserved: true,
    });
  } catch (e) {
    debug('Standard parse failed, trying with module type:', e.message);
    try {
      return acorn.parse(code, {
        ecmaVersion: 2022,
        sourceType: 'module',
        allowHashBang: true,
        allowReserved: true,
      });
    } catch (e2) {
      console.error('❌ Failed to parse cli.js:', e2.message);
      return null;
    }
  }
}

// ============================================
// PHASE 2A: AST HELPER FUNCTIONS
// ============================================

/**
 * Check if a CallExpression is a createElement call
 * Handles various minified forms:
 * - a.createElement(...)
 * - a.default.createElement(...)
 * - (0, a.createElement)(...)
 * - a["createElement"](...)
 */
function isCreateElementCall(node) {
  if (node.type !== 'CallExpression') return false;
  let callee = node.callee;

  // Unwrap SequenceExpression: (0, a.createElement)(...)
  if (callee.type === 'SequenceExpression') {
    callee = callee.expressions[callee.expressions.length - 1];
  }

  // Handle MemberExpression: a.createElement or a["createElement"]
  if (callee.type === 'MemberExpression') {
    const prop = callee.property;
    // Check for .createElement
    if (prop.type === 'Identifier' && prop.name === 'createElement') return true;
    // Check for ["createElement"]
    if (prop.type === 'Literal' && prop.value === 'createElement') return true;

    // Check for .default.createElement (nested MemberExpression)
    // e.g., React.default.createElement
    if (callee.object.type === 'MemberExpression') {
      const innerProp = callee.object.property;
      if (innerProp.type === 'Identifier' && innerProp.name === 'default') {
        if (prop.type === 'Identifier' && prop.name === 'createElement') return true;
      }
    }
  }

  return false;
}

/**
 * Get property from ObjectExpression by key name (order-independent)
 * Returns the Property node or null if not found
 */
function findObjectProperty(objExpr, keyName) {
  if (!objExpr || objExpr.type !== 'ObjectExpression') return null;

  for (const prop of objExpr.properties) {
    if (prop.type !== 'Property') continue;

    // Handle identifier keys: { dimColor: true }
    if (prop.key.type === 'Identifier' && prop.key.name === keyName) {
      return prop;
    }
    // Handle string literal keys: { "dimColor": true }
    if (prop.key.type === 'Literal' && prop.key.value === keyName) {
      return prop;
    }
  }
  return null;
}

/**
 * Walk ancestors array to find specific node type (nearest first)
 * Returns { node, index } or null
 */
function findAncestorOfType(ancestors, type) {
  // Walk from end (closest to target) to beginning
  for (let i = ancestors.length - 2; i >= 0; i--) {
    if (ancestors[i].type === type) {
      return { node: ancestors[i], index: i };
    }
  }
  return null;
}

/**
 * Determine which argument index contains a given node position
 * Returns the index (0-based) or -1 if not found
 */
function containingArgIndex(callExpr, nodeStart, nodeEnd) {
  if (!callExpr.arguments) return -1;

  for (let i = 0; i < callExpr.arguments.length; i++) {
    const arg = callExpr.arguments[i];
    if (nodeStart >= arg.start && nodeEnd <= arg.end) {
      return i;
    }
  }
  return -1;
}

/**
 * Extract the React variable name from a createElement call
 * e.g., "lZ1" from "lZ1.default.createElement(...)"
 */
function getReactVarFromCall(callExpr) {
  let callee = callExpr.callee;

  // Unwrap SequenceExpression
  if (callee.type === 'SequenceExpression') {
    callee = callee.expressions[callee.expressions.length - 1];
  }

  if (callee.type !== 'MemberExpression') return null;

  // Navigate to the root object
  let obj = callee.object;
  while (obj.type === 'MemberExpression') {
    obj = obj.object;
  }

  if (obj.type === 'Identifier') {
    return obj.name;
  }
  return null;
}

/**
 * Find all string literals matching a value using walk.simple
 * @param {object} ast - Parsed AST
 * @param {string|RegExp|function} matcher - Exact string, regex, or predicate function
 */
function findStringLiterals(ast, matcher) {
  const matches = [];
  const matchFn = createMatcher(matcher);
  walk.simple(ast, {
    Literal(node) {
      if (typeof node.value === 'string' && matchFn(node.value)) {
        matches.push(node);
      }
    }
  });
  return matches;
}

/**
 * Find string literals with ancestor information using walk.ancestor
 * @param {object} ast - Parsed AST
 * @param {string|RegExp|function} matcher - Exact string, regex, or predicate function
 */
function findStringLiteralsWithAncestors(ast, matcher) {
  const matches = [];
  const matchFn = createMatcher(matcher);
  walk.ancestor(ast, {
    Literal(node, ancestors) {
      if (typeof node.value === 'string' && matchFn(node.value)) {
        matches.push({ node, ancestors: [...ancestors] });
      }
    }
  });
  return matches;
}

/**
 * Create a matcher function from various input types
 * @param {string|RegExp|function} matcher - Exact string, regex, or predicate
 * @returns {function} - Predicate function (value) => boolean
 */
function createMatcher(matcher) {
  if (typeof matcher === 'function') {
    return matcher;
  }
  if (matcher instanceof RegExp) {
    return (value) => matcher.test(value);
  }
  // Exact string match
  return (value) => value === matcher;
}

/**
 * Fuzzy matcher for "∴ Thinking" variants
 * Matches: "∴ Thinking", "∴ Thinking…", "∴ Thinking (" etc.
 */
function thinkingHeaderMatcher(value) {
  return typeof value === 'string' && value.startsWith('∴ Thinking');
}

/**
 * Matcher for collapsed view text "∴ Thinking (" or just "∴ Thinking"
 * In v2.1.20+, the " (" part may be separate
 */
function thinkingCollapsedMatcher(value) {
  return typeof value === 'string' &&
    (value.startsWith('∴ Thinking (') || value === '∴ Thinking');
}

/**
 * Find the expanded header "∴ Thinking" createElement call
 * Uses fuzzy matching to handle variants: "∴ Thinking", "∴ Thinking…", etc.
 * Returns: { callExpr, propsNode, reactVar, textElement, propsStart, propsEnd, isPatched }
 */
function findExpandedHeader(ast, code) {
  // Use fuzzy matcher to find "∴ Thinking" variants
  const matches = findStringLiteralsWithAncestors(ast, thinkingHeaderMatcher);
  debug(`Found ${matches.length} "∴ Thinking*" literals (fuzzy match)`);

  if (matches.length === 0) {
    return { error: 'NOT_FOUND', count: 0 };
  }

  // Find matches that are children of createElement calls
  // Strategy 1: Literal directly in createElement
  // Strategy 2: Literal assigned to variable, variable used in createElement (v2.1.20+)
  const validMatches = [];

  for (const { node: literal, ancestors } of matches) {
    // Strategy 1: Walk up ancestors to find first CallExpression that is a createElement call
    let callExpr = null;
    for (let i = ancestors.length - 2; i >= 0; i--) {
      if (ancestors[i].type === 'CallExpression' && isCreateElementCall(ancestors[i])) {
        callExpr = ancestors[i];
        break;
      }
    }

    // Strategy 2: If not in createElement, check if assigned to variable
    // Pattern: W="∴ Thinking" ... createElement(f, {...}, D, "…") where D=W
    if (!callExpr) {
      // Check if literal is in an AssignmentExpression
      const assignmentAncestor = findAncestorOfType(ancestors, 'AssignmentExpression');
      if (assignmentAncestor) {
        const assignment = assignmentAncestor.node;
        // Get the variable name being assigned to
        if (assignment.left?.type === 'Identifier') {
          const varName = assignment.left.name;
          debug(`Literal assigned to variable: ${varName}`);
          // For v2.1.20+, we found the variable - mark this as a valid indirect match
          // The actual createElement will be found via contentWrapper using paddingLeft anchor
          validMatches.push({
            literal,
            callExpr: null,  // No direct createElement
            propsNode: null,
            reactVar: null,
            textElement: null,
            isPatched: false,
            isIndirect: true,
            variableName: varName
          });
        }
      }
      continue;
    }

    // Verify the literal is in a child position (arguments[2+])
    // The literal should be the text content, not the type or props
    const argIndex = containingArgIndex(callExpr, literal.start, literal.end);

    // For createElement(Type, props, ...children), children start at index 2
    // Reject if in type (0) or props (1) position - must be in children
    if (argIndex < 2) continue;

    // Get the props node (arguments[1])
    const propsNode = callExpr.arguments[1];
    if (!propsNode) continue;

    // Extract the text element type (arguments[0])
    const typeArg = callExpr.arguments[0];
    let textElement = null;
    if (typeArg.type === 'Identifier') {
      textElement = typeArg.name;
    }

    // Extract React variable name
    const reactVar = getReactVarFromCall(callExpr);

    // Determine if already patched by checking for 'color' property in props
    let isPatched = false;
    if (propsNode.type === 'ObjectExpression') {
      const colorProp = findObjectProperty(propsNode, 'color');
      isPatched = colorProp !== null;
    }

    validMatches.push({
      literal,
      callExpr,
      propsNode,
      reactVar,
      textElement,
      isPatched
    });
  }

  if (validMatches.length === 0) {
    debug('No valid createElement calls found containing "∴ Thinking*"');
    return { error: 'PATTERN_MISMATCH' };
  }

  // Prefer direct matches over indirect ones
  const directMatches = validMatches.filter(m => !m.isIndirect);
  const indirectMatches = validMatches.filter(m => m.isIndirect);

  if (directMatches.length > 1) {
    debug(`Ambiguous: found ${directMatches.length} potential header locations`);
    return { error: 'AMBIGUOUS', count: directMatches.length };
  }

  // Use direct match if available, otherwise use indirect
  const match = directMatches[0] || indirectMatches[0];

  if (match.isIndirect) {
    // v2.1.20+ style: literal assigned to variable
    debug(`Using indirect match via variable: ${match.variableName}`);
    return {
      success: true,
      literal: match.literal,
      callExpr: null,
      propsNode: null,
      reactVar: null,
      textElement: null,
      propsStart: null,
      propsEnd: null,
      isPatched: false,
      isIndirect: true,
      variableName: match.variableName
    };
  }

  return {
    success: true,
    literal: match.literal,
    callExpr: match.callExpr,
    propsNode: match.propsNode,
    reactVar: match.reactVar,
    textElement: match.textElement,
    propsStart: match.propsNode.start,
    propsEnd: match.propsNode.end,
    isPatched: match.isPatched
  };
}

/**
 * Find the collapsed view with the guard condition
 * Uses multiple anchor strategies:
 * - v2.1.19: Single string "∴ Thinking ("
 * - v2.1.20+: Separate strings, use " to expand)" as anchor
 * Returns: { ifStmt, conditionStart, conditionEnd, isPatched }
 */
function findCollapsedView(ast, code) {
  // Combine multiple anchor strategies:
  // - v2.1.19: "∴ Thinking (" as single string (literal directly in if block)
  // - v2.1.20+: " to expand)" as anchor (literal is a variable, but this string is in if block)
  let matches = findStringLiteralsWithAncestors(ast, thinkingCollapsedMatcher);
  debug(`Found ${matches.length} "∴ Thinking*" collapsed literals`);

  // Also try " to expand)" anchor - in v2.1.20+ this is inside the if block
  const expandMatches = findStringLiteralsWithAncestors(ast, ' to expand)');
  debug(`Found ${expandMatches.length} " to expand)" literals`);

  // Combine both sets of matches
  matches = [...matches, ...expandMatches];

  if (matches.length === 0) {
    return { error: 'NOT_FOUND', count: 0 };
  }

  // Find the IfStatement guard for each match
  const validMatches = [];

  for (const { node: literal, ancestors } of matches) {
    // Walk up ancestors to find ALL IfStatements (could be nested)
    // We want the one with !G or !(A||B) pattern, not cache-check ifs like if(K[3]!==...)
    const allIfStatements = [];
    for (let i = ancestors.length - 2; i >= 0; i--) {
      if (ancestors[i].type === 'IfStatement') {
        allIfStatements.push(ancestors[i]);
      }
    }
    if (allIfStatements.length === 0) continue;

    // Find the if with our guard pattern (!G or !(A||B) or already patched !1)
    let ifStmt = null;
    let test = null;
    for (const candidate of allIfStatements) {
      const t = candidate.test;
      // Check for !VAR, !(A||B), or !1 (patched)
      if (t.type === 'UnaryExpression' && t.operator === '!') {
        const arg = t.argument;
        if (arg.type === 'Identifier' ||
            (arg.type === 'LogicalExpression' && arg.operator === '||') ||
            (arg.type === 'Literal' && arg.value === 1)) {
          ifStmt = candidate;
          test = t;
          break;
        }
      }
    }
    if (!ifStmt) continue;

    // Check if already patched: if(!1) - UnaryExpression with Literal 1
    if (test.type === 'UnaryExpression' && test.operator === '!' &&
        test.argument.type === 'Literal' && test.argument.value === 1) {
      validMatches.push({
        literal,
        ifStmt,
        isPatched: true
      });
      continue;
    }

    // Check for unpatched guard: !(VAR||VAR)
    // Structure: UnaryExpression(!) -> LogicalExpression(||)
    if (test.type === 'UnaryExpression' && test.operator === '!') {
      const arg = test.argument;

      // Could be !(A||B) or !A (simpler form)
      if (arg.type === 'LogicalExpression' && arg.operator === '||') {
        // Extract variable names (for debugging, not for assumptions)
        let transcriptVar = null, verboseVar = null;
        if (arg.left.type === 'Identifier') transcriptVar = arg.left.name;
        if (arg.right.type === 'Identifier') verboseVar = arg.right.name;

        validMatches.push({
          literal,
          ifStmt,
          conditionStart: test.start,
          conditionEnd: test.end,
          transcriptVar,
          verboseVar,
          isPatched: false
        });
        continue;
      }

      // Handle simpler form: !VAR
      if (arg.type === 'Identifier') {
        validMatches.push({
          literal,
          ifStmt,
          conditionStart: test.start,
          conditionEnd: test.end,
          transcriptVar: arg.name,
          verboseVar: null,
          isPatched: false
        });
        continue;
      }
    }
  }

  if (validMatches.length === 0) {
    debug('No valid guard patterns found for collapsed view');
    return { error: 'PATTERN_MISMATCH' };
  }

  if (validMatches.length > 1) {
    // If all matches are patched, that's fine - return the first
    const unpatchedMatches = validMatches.filter(m => !m.isPatched);
    if (unpatchedMatches.length > 1) {
      debug(`Ambiguous: found ${unpatchedMatches.length} unpatched collapsed view guards`);
      return { error: 'AMBIGUOUS', count: unpatchedMatches.length };
    }
    // Either 1 unpatched or all patched - use first unpatched or first patched
    const match = unpatchedMatches[0] || validMatches[0];
    return {
      success: true,
      ifStmt: match.ifStmt,
      conditionStart: match.conditionStart,
      conditionEnd: match.conditionEnd,
      transcriptVar: match.transcriptVar,
      verboseVar: match.verboseVar,
      isPatched: match.isPatched
    };
  }

  const match = validMatches[0];

  return {
    success: true,
    ifStmt: match.ifStmt,
    conditionStart: match.conditionStart,
    conditionEnd: match.conditionEnd,
    transcriptVar: match.transcriptVar,
    verboseVar: match.verboseVar,
    isPatched: match.isPatched
  };
}

/**
 * Find the switch case for "thinking" in the message renderer
 * Uses proper AST traversal to find SwitchCase with test.value === "thinking"
 * Disambiguates by checking for isTranscriptMode property in the consequent
 * Returns: { switchCase, guardNode, propsNode, isPatched }
 */
function findSwitchCase(ast, code) {
  // Find all SwitchCase nodes with test value "thinking"
  const thinkingCases = [];

  walk.simple(ast, {
    SwitchCase(node) {
      // Check if this is case "thinking":
      if (node.test && node.test.type === 'Literal' && node.test.value === 'thinking') {
        thinkingCases.push(node);
      }
    }
  });

  debug(`Found ${thinkingCases.length} case "thinking" statements`);

  if (thinkingCases.length === 0) {
    return { error: 'NOT_FOUND' };
  }

  // Find the right one by looking for isTranscriptMode property
  const validCases = [];

  for (const switchCase of thinkingCases) {
    // The consequent is an array of statements
    let statements = switchCase.consequent;
    if (!statements || statements.length === 0) continue;

    // Unwrap BlockStatement if the case body is wrapped: case "thinking": { ... }
    if (statements.length === 1 && statements[0].type === 'BlockStatement') {
      statements = statements[0].body;
    }

    // Look for IfStatement guard and ReturnStatement with createElement
    let guardNode = null;
    let returnNode = null;
    let propsNode = null;
    let hasIsTranscriptMode = false;

    for (const stmt of statements) {
      // Look for guard: if(!VAR&&!VAR)return null;
      if (stmt.type === 'IfStatement') {
        guardNode = stmt;
      }

      // Look for return with createElement
      if (stmt.type === 'ReturnStatement' && stmt.argument) {
        const arg = stmt.argument;
        if (isCreateElementCall(arg)) {
          returnNode = stmt;

          // Get props node (arguments[1])
          if (arg.arguments && arg.arguments[1]) {
            propsNode = arg.arguments[1];

            // Check for isTranscriptMode property
            if (propsNode.type === 'ObjectExpression') {
              const transcriptProp = findObjectProperty(propsNode, 'isTranscriptMode');
              if (transcriptProp) {
                hasIsTranscriptMode = true;
              }
            }
          }
        }
      }
    }

    // We want the case that has isTranscriptMode
    if (hasIsTranscriptMode && returnNode) {
      // Check if already patched by examining isTranscriptMode value
      // Patched = isTranscriptMode:!0 (forced true)
      // Don't assume missing guard means patched - check actual value
      let isPatched = false;

      if (propsNode?.type === 'ObjectExpression') {
        const transcriptProp = findObjectProperty(propsNode, 'isTranscriptMode');
        if (transcriptProp && transcriptProp.value.type === 'UnaryExpression' &&
            transcriptProp.value.operator === '!' &&
            transcriptProp.value.argument.type === 'Literal' &&
            transcriptProp.value.argument.value === 0) {
          // isTranscriptMode:!0 means forced true = patched
          isPatched = true;
        }
      }

      validCases.push({
        switchCase,
        guardNode,
        returnNode,
        propsNode,
        hasIsTranscriptMode,
        isPatched
      });
    }
  }

  if (validCases.length === 0) {
    debug('No switch case with isTranscriptMode property found');
    return { error: 'PATTERN_MISMATCH' };
  }

  if (validCases.length > 1) {
    const unpatchedCases = validCases.filter(c => !c.isPatched);
    if (unpatchedCases.length > 1) {
      debug(`Ambiguous: found ${unpatchedCases.length} unpatched thinking switch cases`);
      return { error: 'AMBIGUOUS', count: unpatchedCases.length };
    }
    // Use first unpatched or first if all patched
    const selected = unpatchedCases[0] || validCases[0];
    return buildSwitchCaseResult(selected);
  }

  return buildSwitchCaseResult(validCases[0]);
}

/**
 * Helper to build switch case result object
 */
function buildSwitchCaseResult(match) {
  const result = {
    success: true,
    switchCase: match.switchCase,
    propsNode: match.propsNode,
    isPatched: match.isPatched
  };

  if (match.guardNode && !match.isPatched) {
    result.guardStart = match.guardNode.start;
    result.guardEnd = match.guardNode.end;
    result.guardNode = match.guardNode;
  }

  if (match.propsNode) {
    result.propsStart = match.propsNode.start;
    result.propsEnd = match.propsNode.end;
  }

  return result;
}

/**
 * Find the content wrapper with paddingLeft property near the thinking header
 * Uses AST navigation instead of regex
 * Returns: { wrapperCall, contentCall, contentComponent, isPatched }
 */
function findContentWrapper(ast, code) {
  // Find "∴ Thinking*" header first as anchor (fuzzy match)
  const headerResult = findExpandedHeader(ast, code);
  if (!headerResult.success) {
    return { error: 'HEADER_NOT_FOUND' };
  }

  // Find all createElement calls with paddingLeft in props that are after the header
  const headerEnd = headerResult.literal.end;
  const candidateWrappers = [];

  walk.simple(ast, {
    CallExpression(node) {
      // Must be after header and within reasonable distance
      if (node.start < headerEnd || node.start > headerEnd + 500) return;

      // Must be a createElement call
      if (!isCreateElementCall(node)) return;

      // Must have props with paddingLeft
      const propsArg = node.arguments[1];
      if (!propsArg || propsArg.type !== 'ObjectExpression') return;

      const paddingLeftProp = findObjectProperty(propsArg, 'paddingLeft');
      if (!paddingLeftProp) return;

      // Look for nested createElement call in children (arguments[2+])
      for (let i = 2; i < node.arguments.length; i++) {
        const childArg = node.arguments[i];
        if (isCreateElementCall(childArg)) {
          // This is the content component createElement
          const contentCall = childArg;
          const contentPropsArg = contentCall.arguments[1];

          // Extract content component name
          let contentComponent = null;
          const typeArg = contentCall.arguments[0];
          if (typeArg?.type === 'Identifier') {
            contentComponent = typeArg.name;
          }

          // Extract content variable (the children of content component)
          let contentVar = null;
          if (contentCall.arguments[2]?.type === 'Identifier') {
            contentVar = contentCall.arguments[2].name;
          }

          // Check if patched - content component has color prop
          let isPatched = false;
          if (contentPropsArg?.type === 'ObjectExpression') {
            const colorProp = findObjectProperty(contentPropsArg, 'color');
            isPatched = colorProp !== null;
          }

          candidateWrappers.push({
            wrapperCall: node,
            contentCall,
            contentComponent,
            contentVar,
            contentPropsNode: contentPropsArg,
            reactVar: getReactVarFromCall(node),
            isPatched
          });
        }
      }
    }
  });

  if (candidateWrappers.length === 0) {
    debug('No content wrapper with paddingLeft found near header');
    return { error: 'PATTERN_MISMATCH' };
  }

  if (candidateWrappers.length > 1) {
    debug(`Ambiguous: found ${candidateWrappers.length} content wrappers near header`);
    return { error: 'AMBIGUOUS', count: candidateWrappers.length };
  }

  const match = candidateWrappers[0];

  return {
    success: true,
    wrapperCall: match.wrapperCall,
    contentCall: match.contentCall,
    contentComponent: match.contentComponent,
    contentVar: match.contentVar,
    contentPropsNode: match.contentPropsNode,
    reactVar: match.reactVar,
    callStart: match.wrapperCall.start,
    callEnd: match.wrapperCall.end,
    isPatched: match.isPatched
  };
}

/**
 * Find the content component function to inject color prop
 * Uses AST to find the function declaration by name
 */
function findContentComponentFunction(ast, code, componentName) {
  let funcNode = null;
  let childrenVar = null;

  walk.simple(ast, {
    FunctionDeclaration(node) {
      if (node.id?.name === componentName) {
        funcNode = node;

        // Extract children parameter name from destructuring
        // function COMP({children:VAR}){
        if (node.params[0]?.type === 'ObjectPattern') {
          for (const prop of node.params[0].properties) {
            if (prop.key?.name === 'children' && prop.value?.type === 'Identifier') {
              childrenVar = prop.value.name;
              break;
            }
          }
        }
      }
    }
  });

  if (!funcNode) {
    debug(`Content component function ${componentName} not found`);
    return null;
  }

  return {
    funcNode,
    childrenVar,
    paramsNode: funcNode.params[0],
    paramsStart: funcNode.params[0]?.start,
    paramsEnd: funcNode.params[0]?.end,
    bodyStart: funcNode.body?.start,
    bodyEnd: funcNode.body?.end
  };
}

/**
 * Find the push pattern inside content component for color wrapping
 * Uses AST to find .push() CallExpressions with createElement arguments
 */
function findPushPattern(ast, code, componentName) {
  // First find the function
  const funcInfo = findContentComponentFunction(ast, code, componentName);
  if (!funcInfo) return null;

  const funcNode = funcInfo.funcNode;
  const pushPatterns = [];

  // Walk the function body to find .push() calls
  walk.simple(funcNode.body, {
    CallExpression(node) {
      // Check if this is a .push() call
      if (node.callee?.type !== 'MemberExpression') return;
      if (node.callee.property?.type !== 'Identifier') return;
      if (node.callee.property.name !== 'push') return;

      // Get the array variable name
      let arrayVar = null;
      if (node.callee.object?.type === 'Identifier') {
        arrayVar = node.callee.object.name;
      }
      if (!arrayVar) return;

      // The argument should be a createElement call
      const pushArg = node.arguments[0];
      if (!pushArg || !isCreateElementCall(pushArg)) return;

      // Extract information from the createElement call
      const createCall = pushArg;
      const reactVar = getReactVarFromCall(createCall);

      // Get the text element type
      let textElement = null;
      if (createCall.arguments[0]?.type === 'Identifier') {
        textElement = createCall.arguments[0].name;
      }

      // Get props - should have key property
      const propsArg = createCall.arguments[1];
      if (!propsArg || propsArg.type !== 'ObjectExpression') return;

      const keyProp = findObjectProperty(propsArg, 'key');
      if (!keyProp) return;

      // Get the string variable (should be in the children, calling .trim())
      let stringVar = null;
      const childArg = createCall.arguments[2];
      if (childArg?.type === 'CallExpression' &&
          childArg.callee?.type === 'MemberExpression' &&
          childArg.callee.property?.name === 'trim' &&
          childArg.callee.object?.type === 'Identifier') {
        stringVar = childArg.callee.object.name;
      }

      // Skip patterns where extraction failed - prevents null interpolation in generated code
      if (!reactVar || !textElement || !stringVar) return;

      pushPatterns.push({
        callNode: node,
        createElementNode: createCall,
        arrayVar,
        reactVar,
        textElement,
        stringVar,
        propsNode: propsArg,
        position: node.start,
        end: node.end
      });
    }
  });

  if (pushPatterns.length === 0) {
    debug('No push pattern found in content component');
    return null;
  }

  if (pushPatterns.length > 1) {
    debug(`Ambiguous: found ${pushPatterns.length} push patterns in ${componentName}`);
    return { error: 'AMBIGUOUS', count: pushPatterns.length, componentName };
  }

  debug(`Found ${pushPatterns.length} push pattern(s) in ${componentName}`);
  return { patterns: pushPatterns, funcInfo };
}

/**
 * Check if a CallExpression is a React.memo() call
 * Handles: REACT.default.memo(...) or REACT.memo(...)
 */
function isMemoCall(node) {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;

  if (callee.type !== 'MemberExpression') return false;

  // Check for .memo property
  if (callee.property?.type === 'Identifier' && callee.property.name === 'memo') {
    return true;
  }

  return false;
}

/**
 * Find the M8 ANSI parser component definition
 * M8 is a memo'd component with {children:X} param and multiple createElement(DF, null, ...) calls
 * Returns: { funcNode, childrenVar, rootElement, paramsStart, paramsEnd, dfCreateCalls[], reactVar }
 */
function findM8Component(ast, code) {
  const memoedComponents = [];

  walk.simple(ast, {
    CallExpression(node) {
      // Look for REACT.default.memo(...) or REACT.memo(...) pattern
      if (!isMemoCall(node)) return;

      // The argument should be a function with {children:X} destructuring
      const funcArg = node.arguments[0];
      if (!funcArg || funcArg.type !== 'FunctionExpression') return;

      const param = funcArg.params[0];
      if (!param || param.type !== 'ObjectPattern') return;

      // Check for children property in destructuring
      const childrenProp = param.properties.find(p =>
        (p.key?.type === 'Identifier' && p.key.name === 'children') ||
        (p.key?.type === 'Literal' && p.key.value === 'children')
      );
      if (!childrenProp) return;

      const childrenVar = childrenProp.value?.type === 'Identifier' ? childrenProp.value.name : null;
      if (!childrenVar) return;

      // Search function body for createElement calls with null props (DF root element)
      const dfCreateCalls = [];
      let rootElement = null;

      walk.simple(funcArg.body, {
        CallExpression(innerNode) {
          if (!isCreateElementCall(innerNode)) return;

          const typeArg = innerNode.arguments[0];
          const propsArg = innerNode.arguments[1];

          // Track calls where props is 'null' literal (these need patching)
          if (propsArg?.type === 'Literal' && propsArg.value === null) {
            // Capture root element name from first call
            if (!rootElement && typeArg?.type === 'Identifier') {
              rootElement = typeArg.name;
            }

            // Only track calls to the same root element
            if (typeArg?.type === 'Identifier' && typeArg.name === rootElement) {
              dfCreateCalls.push({
                node: innerNode,
                typeArg,
                propsArg,
                start: innerNode.start,
                end: innerNode.end,
                propsStart: propsArg.start,
                propsEnd: propsArg.end
              });
            }
          }
        }
      });

      // M8 has exactly 3 DF createElement calls with null props
      if (dfCreateCalls.length >= 3) {
        memoedComponents.push({
          memoNode: node,
          funcNode: funcArg,
          childrenVar,
          rootElement,
          dfCreateCalls,
          paramsNode: param,
          paramsStart: param.start,
          paramsEnd: param.end,
          reactVar: getReactVarFromCall(node)
        });
      }
    }
  });

  // Disambiguate by checking for ANSI-related content patterns
  const validMatches = memoedComponents.filter(m => {
    const funcCode = code.substring(m.funcNode.start, m.funcNode.end);
    // M8 contains specific patterns: length checks, Object.keys, type checks
    return funcCode.includes('.length===1') &&
           funcCode.includes('Object.keys') &&
           funcCode.includes('typeof');
  });

  if (validMatches.length === 0) {
    debug('No M8 component found');
    return { error: 'NOT_FOUND' };
  }

  if (validMatches.length > 1) {
    debug(`Ambiguous: found ${validMatches.length} potential M8 components`);
    return { error: 'AMBIGUOUS', count: validMatches.length };
  }

  const match = validMatches[0];

  // Check if already patched (signature has color param)
  const paramsCode = code.substring(match.paramsStart, match.paramsEnd);
  const isPatched = paramsCode.includes('color');

  return {
    success: true,
    funcNode: match.funcNode,
    childrenVar: match.childrenVar,
    rootElement: match.rootElement,
    reactVar: match.reactVar,
    paramsStart: match.paramsStart,
    paramsEnd: match.paramsEnd,
    dfCreateCalls: match.dfCreateCalls,
    isPatched
  };
}

// ============================================
// PHASE 3: PATCHING ENGINE
// ============================================

function resolveColors() {
  let headerColor, contentColor;

  if (THEME && THEME_PRESETS[THEME]) {
    // Theme presets are pre-validated, but validate anyway for safety
    headerColor = validateColor(THEME_PRESETS[THEME].header);
    contentColor = validateColor(THEME_PRESETS[THEME].content);
  } else {
    // Validate user-provided colors (throws on invalid input)
    headerColor = CUSTOM_COLOR ? validateColor(CUSTOM_COLOR) : null;
    contentColor = CONTENT_COLOR
      ? validateColor(CONTENT_COLOR)
      : headerColor;
  }

  return { headerColor, contentColor };
}

function applyPatches(code, ast, detections, colors) {
  const ms = new MagicString(code);
  const patches = [];

  // Patch 1: Disable collapsed view guard
  if (detections.collapsedView.success && !detections.collapsedView.isPatched) {
    const cv = detections.collapsedView;
    // Replace !(VAR||VAR) with !1
    ms.overwrite(cv.conditionStart, cv.conditionEnd, '!1');
    patches.push('Collapsed view guard disabled');
  } else if (detections.collapsedView.isPatched) {
    patches.push('Collapsed view guard (already patched)');
  }

  // Patch 2: Force transcript mode in switch case
  if (detections.switchCase.success && !detections.switchCase.isPatched) {
    const sc = detections.switchCase;

    // Remove the guard: if(!VAR&&!VAR)return null;
    if (sc.guardStart && sc.guardEnd) {
      ms.remove(sc.guardStart, sc.guardEnd);
    }

    // Use AST to modify props - find isTranscriptMode and hideInTranscript properties
    if (sc.propsNode?.type === 'ObjectExpression') {
      const transcriptProp = findObjectProperty(sc.propsNode, 'isTranscriptMode');
      const hideProp = findObjectProperty(sc.propsNode, 'hideInTranscript');

      if (transcriptProp) {
        // Replace the value with !0 (true)
        ms.overwrite(transcriptProp.value.start, transcriptProp.value.end, '!0');
      }
      if (hideProp) {
        // Replace the value with !1 (false)
        ms.overwrite(hideProp.value.start, hideProp.value.end, '!1');
      }
    }

    patches.push('Switch case: transcript mode forced');
  } else if (detections.switchCase.isPatched) {
    patches.push('Switch case (already patched)');
  }

  // Patch 3: Header color (optional)
  if (colors.headerColor && detections.expandedHeader.success && !detections.expandedHeader.isPatched) {
    const eh = detections.expandedHeader;

    if (eh.isIndirect) {
      // v2.1.20+: Literal is assigned to variable, find createElement via "…" anchor
      // Pattern: createElement(f, {dimColor:!0,italic:!0}, D, "…")
      const ellipsisMatches = findStringLiteralsWithAncestors(ast, '…');
      let headerPatched = false;
      for (const { node: ellipsis, ancestors } of ellipsisMatches) {
        if (headerPatched) break;
        // Find containing createElement
        for (let i = ancestors.length - 2; i >= 0; i--) {
          if (ancestors[i].type === 'CallExpression' && isCreateElementCall(ancestors[i])) {
            const callExpr = ancestors[i];
            const propsNode = callExpr.arguments[1];
            if (propsNode?.type === 'ObjectExpression') {
              // Check if this has dimColor prop (confirms it's the header)
              const dimColorProp = findObjectProperty(propsNode, 'dimColor');
              if (dimColorProp) {
                const newProps = `{italic:!0,color:"${colors.headerColor}"}`;
                ms.overwrite(propsNode.start, propsNode.end, newProps);
                patches.push(`Header color: ${colors.headerColor} (v2.1.20+)`);
                headerPatched = true;
                break;
              }
            }
            break;
          }
        }
      }
    } else {
      // Direct match: literal is inside createElement
      const newProps = `{italic:!0,color:"${colors.headerColor}"}`;
      ms.overwrite(eh.propsStart, eh.propsEnd, newProps);
      patches.push(`Header color: ${colors.headerColor}`);
    }
  } else if (colors.headerColor && detections.expandedHeader.isPatched) {
    patches.push('Header color (already patched)');
  }

  // Patch 4: Content color via Fix A Improved - thread color to Text components
  // Box doesn't propagate 'color' to children - must reach actual <Text> elements
  // Thread: ContentWrapper → ContentComponent → M8 → DF (Text elements)
  if (colors.contentColor && detections.m8Component.success && !detections.m8Component.isPatched) {
    const m8 = detections.m8Component;
    const cw = detections.contentWrapper;

    // Step 4a: Patch M8's signature to accept color prop
    // Change: {children:Q} -> {children:Q,color:$MC}
    const newM8Params = `{children:${m8.childrenVar},color:$MC}`;
    ms.overwrite(m8.paramsStart, m8.paramsEnd, newM8Params);
    patches.push('M8 component: signature updated');

    // Step 4b: Forward color to all DF createElement calls in M8
    // Change: createElement(DF, null, ...) -> createElement(DF, {color:$MC}, ...)
    for (const call of m8.dfCreateCalls) {
      ms.overwrite(call.propsStart, call.propsEnd, '{color:$MC}');
    }
    patches.push(`M8 component: ${m8.dfCreateCalls.length} createElement calls patched`);

    // Step 4c: Update content component to pass color to M8
    if (cw?.success && cw.contentComponent) {
      // Pass color prop to content component invocation
      if (cw.contentPropsNode?.type === 'Literal' && cw.contentPropsNode.value === null) {
        ms.overwrite(cw.contentPropsNode.start, cw.contentPropsNode.end, `{color:"${colors.contentColor}"}`);
      }

      // Modify content component signature to accept and forward color
      const funcInfo = findContentComponentFunction(ast, code, cw.contentComponent);
      if (funcInfo?.paramsNode && funcInfo.childrenVar) {
        const newParams = `{children:${funcInfo.childrenVar},color:$TC}`;
        ms.overwrite(funcInfo.paramsStart, funcInfo.paramsEnd, newParams);
        patches.push('Content component: signature updated');

        // Step 4d: Update push pattern to pass color to M8
        const pushResult = findPushPattern(ast, code, cw.contentComponent);
        if (pushResult?.error === 'AMBIGUOUS') {
          console.error(`\n❌ Ambiguous: found ${pushResult.count} push patterns in ${pushResult.componentName}.`);
          process.exit(EXIT.AMBIGUOUS);
        }
        if (pushResult?.patterns?.length > 0) {
          for (const push of pushResult.patterns) {
            if (!push.reactVar || !push.textElement || !push.stringVar) continue;

            // Pass color prop to M8 (the text element)
            // Original: X.push(React.createElement(M8, {key:X.length}, str.trim()))
            // Patched:  X.push(React.createElement(M8, {key:X.length,color:$TC}, str.trim()))
            const keyProp = findObjectProperty(push.propsNode, 'key');
            if (keyProp) {
              // Insert color prop after existing props
              const insertPos = push.propsNode.end - 1;
              ms.appendLeft(insertPos, ',color:$TC');
            }
          }
          patches.push(`Push patterns: color prop added (${pushResult.patterns.length})`);
        }
      }
    }

    patches.push(`Content color: ${colors.contentColor}`);
  } else if (colors.contentColor && detections.m8Component.isPatched) {
    patches.push('Content color (already patched)');
  } else if (colors.contentColor && !detections.m8Component.success) {
    console.warn(`⚠️  Content color requested but M8 component not found: ${detections.m8Component.error}`);
  }

  return {
    code: ms.toString(),
    patches
  };
}

// ============================================
// PHASE 4: VERIFICATION & MAIN
// ============================================

function verifyPatchedCode(patchedCode, colors, expectedPatches) {
  // Re-parse to ensure valid JS
  let ast;
  try {
    ast = parseWithAcorn(patchedCode);
    if (!ast) {
      return { valid: false, error: 'Failed to parse patched code' };
    }
  } catch (e) {
    return { valid: false, error: e.message };
  }

  // Verify patches using AST-based detection
  const checks = [];
  const failures = [];

  // Check 1: Collapsed guard is disabled
  const collapsedResult = findCollapsedView(ast, patchedCode);
  if (collapsedResult.success && collapsedResult.isPatched) {
    checks.push('collapsed_guard');
  } else if (expectedPatches?.collapsedView) {
    failures.push('collapsed_guard: expected isPatched=true');
  }

  // Check 2: Switch case is forced
  const switchResult = findSwitchCase(ast, patchedCode);
  if (switchResult.success && switchResult.isPatched) {
    checks.push('transcript_mode');
  } else if (expectedPatches?.switchCase) {
    failures.push('transcript_mode: expected isPatched=true');
  }

  // Check 3: Header color (if requested)
  if (colors.headerColor) {
    const headerResult = findExpandedHeader(ast, patchedCode);
    if (headerResult.success && headerResult.isPatched) {
      checks.push('header_color');
    } else if (expectedPatches?.headerColor) {
      failures.push('header_color: expected isPatched=true');
    }
  }

  // Check 4: Content color via M8 (if requested)
  // Fix A Improved: Color is threaded through M8 component
  if (colors.contentColor) {
    const m8Result = findM8Component(ast, patchedCode);
    if (m8Result.success && m8Result.isPatched) {
      checks.push('m8_color');
    } else if (expectedPatches?.contentColor) {
      failures.push('m8_color: expected M8 signature to have color param');
    }

    // Also verify content wrapper passes color
    const contentResult = findContentWrapper(ast, patchedCode);
    if (contentResult.success && contentResult.contentPropsNode) {
      // Check if content component is called with color prop
      const propsNode = contentResult.contentPropsNode;
      if (propsNode?.type === 'ObjectExpression') {
        const colorProp = findObjectProperty(propsNode, 'color');
        if (colorProp) {
          checks.push('content_color');
        }
      }
    }
  }

  if (failures.length > 0) {
    return { valid: false, error: `Patch verification failed: ${failures.join(', ')}`, checks };
  }

  return { valid: true, checks };
}

function main() {
  console.log('🧠 Thinker (AST) - Claude Code Thinking Visibility Patch\n');
  console.log('🔍 Finding Claude Code installation...');

  const cliPath = findClaudeCode();
  if (!cliPath) {
    console.error('❌ Could not find Claude Code installation');
    console.error('   Searched common locations. Is Claude Code installed?');
    process.exit(EXIT.GENERAL_ERROR);
  }

  console.log(`📁 Found: ${cliPath}`);
  const backupPath = cliPath + '.backup';

  // Handle restore
  if (RESTORE) {
    if (DRY_RUN) {
      console.log('🔄 [DRY RUN] Would restore from backup');
    } else {
      if (restoreFromBackup(cliPath, backupPath)) {
        console.log('🔄 Restart Claude Code for changes to take effect.');
      }
    }
    process.exit(EXIT.SUCCESS);
  }

  // Read file
  const content = fs.readFileSync(cliPath, 'utf8');
  const version = getVersion(content);
  console.log(`📦 Version: ${version}\n`);

  // Parse AST
  console.log('🔬 Parsing with Acorn...');
  const ast = parseWithAcorn(content);
  if (!ast) {
    process.exit(EXIT.GENERAL_ERROR);
  }
  console.log('   ✅ Parse successful\n');

  // Detect patterns
  console.log('🔍 Pattern Detection:');

  const detections = {
    expandedHeader: findExpandedHeader(ast, content),
    collapsedView: findCollapsedView(ast, content),
    switchCase: findSwitchCase(ast, content),
    contentWrapper: findContentWrapper(ast, content),
    m8Component: findM8Component(ast, content)
  };

  // Report detection results
  for (const [name, result] of Object.entries(detections)) {
    if (result.success) {
      const status = result.isPatched ? '(already patched)' : '';
      console.log(`   ✅ ${name} ${status}`);
    } else {
      console.log(`   ⚠️  ${name}: ${result.error}`);
    }
  }

  // Resolve colors
  const colors = resolveColors();
  if (colors.headerColor || colors.contentColor) {
    console.log(`\n🎨 Colors:`);
    if (colors.headerColor === colors.contentColor) {
      console.log(`   Both: ${colors.headerColor}`);
    } else {
      if (colors.headerColor) console.log(`   Header: ${colors.headerColor}`);
      if (colors.contentColor) console.log(`   Content: ${colors.contentColor}`);
    }
  }

  // Check if anything is patchable
  const hasPatchablePatterns =
    (detections.expandedHeader.success && !detections.expandedHeader.isPatched) ||
    (detections.collapsedView.success && !detections.collapsedView.isPatched) ||
    (detections.switchCase.success && !detections.switchCase.isPatched) ||
    (colors.contentColor && detections.m8Component.success && !detections.m8Component.isPatched);

  const allPatched =
    detections.expandedHeader.isPatched &&
    detections.collapsedView.isPatched &&
    detections.switchCase.isPatched;

  if (CHECK_ONLY) {
    if (hasPatchablePatterns) {
      console.log('\n✅ Version is patchable!');
      process.exit(EXIT.SUCCESS);
    } else if (allPatched) {
      console.log('\n⚠️  Already fully patched. Use --restore to reset.');
      process.exit(EXIT.ALREADY_PATCHED);
    } else {
      console.log('\n❌ Version may not be patchable.');
      process.exit(EXIT.GENERAL_ERROR);
    }
  }

  if (!hasPatchablePatterns) {
    if (allPatched) {
      console.log('\n⚠️  File appears already patched. Use --restore to reset, then re-patch.');
      process.exit(EXIT.ALREADY_PATCHED);
    } else {
      console.error('\n❌ No patchable patterns found.');
      process.exit(EXIT.GENERAL_ERROR);
    }
  }

  // Apply patches
  console.log('\n📝 Applying patches...');
  const { code: patchedCode, patches } = applyPatches(content, ast, detections, colors);

  for (const patch of patches) {
    console.log(`   ✅ ${patch}`);
  }

  // Verify
  console.log('\n🔍 Verifying patched code...');
  const verification = verifyPatchedCode(patchedCode, colors);
  if (!verification.valid) {
    console.error(`❌ Verification failed: ${verification.error}`);
    process.exit(EXIT.VERIFICATION_FAILED);
  }
  console.log(`   ✅ Valid JS, patches confirmed: ${verification.checks.join(', ')}`);

  // Write changes
  if (DRY_RUN) {
    console.log('\n🔍 Dry run complete. Run without --dry-run to apply patches.');
    process.exit(EXIT.SUCCESS);
  }

  atomicWrite(cliPath, patchedCode, backupPath);
  console.log('\n✅ Patches applied successfully!');
  console.log('🔄 Restart Claude Code for changes to take effect.');
  process.exit(EXIT.SUCCESS);
}

main();

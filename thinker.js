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

if (HELP) {
  console.log(`
🧠 Thinker - Claude Code Thinking Visibility Patch

Usage:
  node thinker.js           Apply the patch
  node thinker.js --dry-run Preview changes without applying
  node thinker.js --restore Restore from backup
  node thinker.js --check   Check if current version is patchable

What it does:
  1. Removes the collapsed "∴ Thinking..." banner
  2. Forces thinking content to display inline automatically
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

// Extract the full banner function using precise pattern matching
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

// Detect the thinking case pattern
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
    verboseVar: match[8]
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

  // Detect patterns
  const bannerInfo = extractBannerFunction(content);
  const thinkingInfo = detectThinkingPattern(content);

  console.log('🔬 Pattern Detection:');
  if (bannerInfo) {
    console.log(`   ✅ Banner function: ${bannerInfo.funcName}() [${bannerInfo.fullFunction.length} chars]`);
  } else {
    console.log('   ⚠️  Banner function not detected');
  }

  if (thinkingInfo) {
    console.log(`   ✅ Thinking case: component ${thinkingInfo.componentName}`);
  } else {
    console.log('   ⚠️  Thinking case not detected');
  }

  if (CHECK_ONLY) {
    const patchable = bannerInfo && thinkingInfo;
    console.log(`\n${patchable ? '✅ Version is patchable!' : '❌ Version may not be fully patchable'}`);
    process.exit(patchable ? 0 : 1);
  }

  if (!bannerInfo && !thinkingInfo) {
    console.error('\n❌ No patchable patterns found.');
    process.exit(1);
  }

  // Apply patches
  let patched = content;
  let patchCount = 0;

  console.log('\n📝 Applying patches:');

  // Patch 1: Banner removal - use exact string replacement
  if (bannerInfo) {
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

  // Patch 2: Thinking visibility
  if (thinkingInfo) {
    const replacement = `case"thinking":return ${thinkingInfo.reactVar}.createElement(${thinkingInfo.componentName},{addMargin:${thinkingInfo.addMarginVar},param:${thinkingInfo.paramVar},isTranscriptMode:!0,verbose:${thinkingInfo.verboseVar}})`;

    if (patched.includes(thinkingInfo.fullMatch)) {
      if (!DRY_RUN) {
        patched = patched.replace(thinkingInfo.fullMatch, replacement);
      }
      patchCount++;
      console.log('   ✅ Thinking visibility' + (DRY_RUN ? ' [DRY RUN]' : ''));
    } else if (patched.includes('case"thinking":return') && patched.includes('isTranscriptMode:!0')) {
      console.log('   ⚠️  Thinking already patched');
    } else {
      console.log('   ❌ Thinking patch failed - pattern mismatch');
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

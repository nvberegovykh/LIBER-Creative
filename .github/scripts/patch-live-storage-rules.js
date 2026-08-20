'use strict';

const fs = require('node:fs');

const START = 'REVEX_SECURE_STORAGE_ACCESS_BEGIN';
const END = 'REVEX_SECURE_STORAGE_ACCESS_END';

function matchingBrace(source, opening) {
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = opening; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1] || '';
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('The live Storage rules have an unmatched object block.');
}

function injectRules(liveSource, fragmentSource) {
  if (!fragmentSource.includes(START) || !fragmentSource.includes(END))
    throw new Error('The REVEX Storage fragment is missing its integrity markers.');
  if (/\bservice\s+firebase\.storage\s*\{/.test(fragmentSource.replace(/\/\*[\s\S]*?\*\//g, '')))
    throw new Error('The Storage access input must be a merge fragment, not a replacement ruleset.');

  const oldBlock = new RegExp(`/\\*\\s*${START}[\\s\\S]*?${END}\\s*\\*/`, 'g');
  const clean = liveSource.replace(oldBlock, '').replace(/[ \t]+\n/g, '\n');
  const serviceMatches = [...clean.matchAll(/service\s+firebase\.storage\s*\{/g)];
  if (serviceMatches.length !== 1)
    throw new Error(`Expected exactly one Firebase Storage service; found ${serviceMatches.length}.`);
  const objectMatches = [...clean.matchAll(/match\s+\/b\/\{bucket\}\/o\s*\{/g)];
  if (objectMatches.length !== 1)
    throw new Error(`Expected exactly one Storage object match; found ${objectMatches.length}.`);

  const opening = objectMatches[0].index + objectMatches[0][0].lastIndexOf('{');
  const closing = matchingBrace(clean, opening);
  const beforeClosing = clean.slice(0, closing);
  const closingIndent = (beforeClosing.match(/(?:^|\n)([ \t]*)$/) || [])[1] || '';
  const bodyIndent = `${closingIndent}  `;
  const prefix = beforeClosing.slice(0, beforeClosing.length - closingIndent.length).replace(/\s*$/, '');
  const fragment = fragmentSource.trim().split('\n').map((line) => `${bodyIndent}${line}`).join('\n');
  const output = `${prefix}\n\n${fragment}\n${closingIndent}${clean.slice(closing)}`;
  if ((output.match(new RegExp(START, 'g')) || []).length !== 1)
    throw new Error('The generated Storage ruleset did not contain exactly one REVEX access block.');
  return output.endsWith('\n') ? output : `${output}\n`;
}

if (require.main === module) {
  const [livePath, fragmentPath, outputPath] = process.argv.slice(2);
  if (!livePath || !fragmentPath || !outputPath) {
    console.error('Usage: node patch-live-storage-rules.js LIVE.rules FRAGMENT.rules OUTPUT.rules');
    process.exit(2);
  }
  const output = injectRules(fs.readFileSync(livePath, 'utf8'), fs.readFileSync(fragmentPath, 'utf8'));
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log(`Prepared preserved live Storage rules with ${START}.`);
}

module.exports = { injectRules, matchingBrace, START, END };

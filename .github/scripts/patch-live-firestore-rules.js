'use strict';

const fs = require('node:fs');

const START = 'REVEX_PROJECT_ACCESS_R43_BEGIN';
const END = 'REVEX_PROJECT_ACCESS_R43_END';

function matchingBrace(source, opening) {
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  let escaped = false;

  for (let index = opening; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1] || '';

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
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
  throw new Error('The live Firestore rules have an unmatched database block.');
}

function injectRules(liveSource, fragmentSource) {
  if (!fragmentSource.includes(START) || !fragmentSource.includes(END))
    throw new Error('The r43 access fragment is missing its integrity markers.');

  const oldBlock = new RegExp(
    `/\\*\\s*${START}[\\s\\S]*?${END}\\s*\\*/`,
    'g'
  );
  const clean = liveSource.replace(oldBlock, '').replace(/[ \t]+\n/g, '\n');
  const databaseMatch = /match\s+\/databases\/\{database\}\/documents\s*\{/g;
  const matches = [...clean.matchAll(databaseMatch)];
  if (matches.length !== 1)
    throw new Error(`Expected exactly one Firestore database match; found ${matches.length}.`);

  const opening = matches[0].index + matches[0][0].lastIndexOf('{');
  const closing = matchingBrace(clean, opening);
  const beforeClosing = clean.slice(0, closing);
  const closingIndent = (beforeClosing.match(/(?:^|\n)([ \t]*)$/) || [])[1] || '';
  const bodyIndent = `${closingIndent}  `;
  const prefix = beforeClosing.slice(0, beforeClosing.length - closingIndent.length).replace(/\s*$/, '');
  const fragment = fragmentSource.trim().split('\n').map((line) => `${bodyIndent}${line}`).join('\n');
  const output = `${prefix}\n\n${fragment}\n${closingIndent}${clean.slice(closing)}`;

  if ((output.match(new RegExp(START, 'g')) || []).length !== 1)
    throw new Error('The generated ruleset did not contain exactly one r43 access block.');
  return output.endsWith('\n') ? output : `${output}\n`;
}

if (require.main === module) {
  const [livePath, fragmentPath, outputPath] = process.argv.slice(2);
  if (!livePath || !fragmentPath || !outputPath) {
    console.error('Usage: node patch-live-firestore-rules.js LIVE.rules FRAGMENT.rules OUTPUT.rules');
    process.exit(2);
  }
  const output = injectRules(
    fs.readFileSync(livePath, 'utf8'),
    fs.readFileSync(fragmentPath, 'utf8')
  );
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log(`Prepared preserved live rules with ${START}.`);
}

module.exports = { injectRules, matchingBrace, START, END };


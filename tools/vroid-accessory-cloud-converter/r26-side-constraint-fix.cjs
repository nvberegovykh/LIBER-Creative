const fs = require('fs');

const file = process.argv[2];
if (!file) throw new Error('Usage: node r26-side-constraint-fix.cjs <cleanroom-xwear.js>');
let s = fs.readFileSync(file, 'utf8');

const oldText = "function variantAllowsBone(name,variant){const sd=sideOf(name);return variant==='Pair'||!sd||(variant==='Left'&&sd==='L')||(variant==='Right'&&sd==='R')}";
const newText = `function springSideOf(name){
  const n=String(name||'');
  // Creator bone names use both EarringR## and EarringRU## spellings.  The
  // generic mesh-side classifier intentionally did not know about the RU/LU
  // rig convention, which made the right RU chain leak into the Left variant.
  if(/^EarringL(?:U)?\\d+/i.test(n))return 'L';
  if(/^EarringR(?:U)?\\d+/i.test(n))return 'R';
  return sideOf(n);
}
function variantAllowsBone(name,variant){const sd=springSideOf(name);return variant==='Pair'||!sd||(variant==='Left'&&sd==='L')||(variant==='Right'&&sd==='R')}`;

if (!s.includes(oldText)) throw new Error('R2.6.2 spring-side anchor missing');
s = s.replace(oldText, newText);
s = s.replace("log('[+] LIBER clean-room XWear v2 R2.6 adaptive');", "log('[+] LIBER clean-room XWear v2 R2.6.2 adaptive constrained');");
fs.writeFileSync(file, s);
console.log('Applied VRoid Accessory Converter R2.6.2 side/constraint fix');

const fs = require('fs');
const file = process.argv[2];
if (!file) throw new Error('Usage: node r26-adaptive-patch-fix.cjs <cleanroom-xwear.js>');
let s = fs.readFileSync(file, 'utf8');
const bad = 'function buildXwear\nfunction buildXwear(';
if (!s.includes(bad)) throw new Error('R2.6 post-patch repair anchor missing');
s = s.replace(bad, 'function buildXwear(');
fs.writeFileSync(file, s);
console.log('Applied VRoid Accessory Converter R2.6 adaptive post-patch repair');

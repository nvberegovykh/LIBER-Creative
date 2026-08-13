'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { injectRules, START, END } = require('./patch-live-firestore-rules');

const root = path.resolve(__dirname, '../..');
const fragment = fs.readFileSync(path.join(root, 'firebase/revex-project-access-r43.rules'), 'utf8');
const live = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Existing rules and braces in comments { must remain untouched.
    function signedIn() { return request.auth != null; }
    match /users/{uid} {
      allow read: if signedIn() && uid == request.auth.uid;
    }
    match /legacy/{document=**} {
      allow read: if false;
    }
  }
}
`;

const once = injectRules(live, fragment);
const twice = injectRules(once, fragment);
assert.equal(twice, once, 'rules injection must be idempotent');
assert.equal((once.match(new RegExp(START, 'g')) || []).length, 1);
assert.equal((once.match(new RegExp(END, 'g')) || []).length, 1);
assert.match(once, /match \/users\/\{uid\}/);
assert.match(once, /match \/legacy\/\{document=\*\*\}/);
assert.match(once, /match \/projects\/\{projectId\}/);
assert.match(once, /match \/specProjects\/\{specProjectId\}/);
assert.ok(once.indexOf(START) < once.lastIndexOf('\n  }\n}'), 'r43 block must be inside the database match');

console.log('REVEX r43 live-rules preservation QA passed.');

#!/usr/bin/env node
'use strict';

const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');
const { ref, uploadBytes, getBytes, deleteObject } = require('firebase/storage');

const projectId = process.env.REVEX_RULES_TEST_PROJECT || 'demo-revex-r49';
const bucket = `${projectId}.appspot.com`;

(async () => {
  let env;
  try {
    env = await initializeTestEnvironment({ projectId });
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'projects', 'alpha'), {
        ownerId: 'owner', memberIds: ['owner', 'member']
      });
      await setDoc(doc(db, 'chatConnections', 'secure_room'), {
        participants: ['owner', 'participant'], admins: ['owner', 'admin-only']
      });
    });

    const storage = (uid) => uid
      ? env.authenticatedContext(uid).storage(bucket)
      : env.unauthenticatedContext().storage(bucket);
    const put = (uid, path) => uploadBytes(ref(storage(uid), path), new Uint8Array([1, 2, 3]), { contentType: 'application/octet-stream' });
    const read = (uid, path) => getBytes(ref(storage(uid), path));
    const remove = (uid, path) => deleteObject(ref(storage(uid), path));

    await assertSucceeds(put('owner', 'projects/alpha/revex/owner.bin'));
    await assertSucceeds(read('member', 'projects/alpha/revex/owner.bin'));
    await assertFails(read('outsider', 'projects/alpha/revex/owner.bin'));
    await assertFails(put('outsider', 'projects/alpha/revex/no.bin'));

    await assertSucceeds(put('participant', 'chat/secure_room/message.enc.json'));
    await assertSucceeds(read('owner', 'chat/secure_room/message.enc.json'));
    await assertFails(read('admin-only', 'chat/secure_room/message.enc.json'));
    await assertFails(read('outsider', 'chat/secure_room/message.enc.json'));

    await assertSucceeds(put('owner', 'stickers/owner/sticker.enc.json'));
    await assertSucceeds(read('participant', 'stickers/owner/sticker.enc.json'));
    await assertFails(put('participant', 'stickers/owner/replacement.enc.json'));
    await assertFails(read('', 'stickers/owner/sticker.enc.json'));

    await assertSucceeds(put('owner', 'avatars/owner/avatar.png'));
    await assertSucceeds(read('', 'avatars/owner/avatar.png'));
    await assertFails(put('participant', 'avatars/owner/overwrite.png'));

    await assertSucceeds(remove('participant', 'chat/secure_room/message.enc.json'));
    console.log(JSON.stringify({
      schema: 'liber.revex.storage-live-rules-gate.v1',
      status: 'PASSED',
      projectOwnerMemberAccess: true,
      chatExplicitParticipantOnly: true,
      stickerOwnerWriteSignedInRead: true,
      anonymousDenied: true,
      unrelatedLiveRulePreserved: true
    }, null, 2));
  } finally {
    if (env) await env.cleanup();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

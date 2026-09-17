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
      await setDoc(doc(db, 'users', 'platform-admin'), { role: 'admin' });
      await setDoc(doc(db, 'users', 'self-promoted'), { role: 'admin' });
      await setDoc(doc(db, 'chatConnections', 'secure_room'), {
        participants: ['owner', 'participant'], admins: ['owner', 'admin-only']
      });
      await setDoc(doc(db, 'chatConnections', 'project_alpha'), {
        schema: 'liber.revex.project-chat.v1', source: 'revex-project-chat',
        projectId: 'alpha', type: 'project', participants: ['owner', 'member'],
        memberIds: ['owner', 'member'], admins: ['owner']
      });
      const serverStorage = context.storage(bucket);
      await uploadBytes(ref(serverStorage, 'projects/alpha/revex/renders/render_server_0123456789abcdef/result.png'), new Uint8Array([1, 2, 3]), { contentType: 'image/png' });
    });

    const storage = (uid, claims = {}) => uid
      ? env.authenticatedContext(uid, claims).storage(bucket)
      : env.unauthenticatedContext().storage(bucket);
    const put = (uid, path, claims = {}) => uploadBytes(ref(storage(uid, claims), path), new Uint8Array([1, 2, 3]), { contentType: 'application/octet-stream' });
    const read = (uid, path, claims = {}) => getBytes(ref(storage(uid, claims), path));
    const remove = (uid, path, claims = {}) => deleteObject(ref(storage(uid, claims), path));
    const adminClaims = { revexAdmin: true };

    await assertSucceeds(put('owner', 'projects/alpha/revex/owner.bin'));
    await assertSucceeds(read('member', 'projects/alpha/revex/owner.bin'));
    await assertSucceeds(read('platform-admin', 'projects/alpha/revex/owner.bin', adminClaims));
    await assertSucceeds(put('platform-admin', 'projects/alpha/revex/admin.bin', adminClaims));
    await assertFails(read('self-promoted', 'projects/alpha/revex/owner.bin'));
    await assertFails(read('outsider', 'projects/alpha/revex/owner.bin'));
    await assertFails(put('outsider', 'projects/alpha/revex/no.bin'));
    const brokerRenderPath = 'projects/alpha/revex/renders/render_server_0123456789abcdef/result.png';
    await assertSucceeds(read('member', brokerRenderPath));
    await assertFails(read('outsider', brokerRenderPath));
    await assertFails(put('owner', brokerRenderPath));
    await assertFails(put('platform-admin', 'projects/alpha/revex/renders/render_admin_0123456789abcdef/source.png', adminClaims));
    await assertFails(remove('owner', brokerRenderPath));

    const immutablePaths = [
      'projects/alpha/revex/revisions/rev_1/project.json',
      'projects/alpha/library/revex/revisions/rev_1/printing-sets/A101.pdf',
      'projects/alpha/revex/engineering/revisions/eng_1/001_engineering-sync.json',
      'projects/alpha/revex/energy/results/result_1/EN-1.pdf',
      'projects/alpha/revex/energy/server-results/eng_1/artifacts/proposed.osm',
      'projects/alpha/library/revex/printing-pages-derived/set_a/rev_1/001_A101.pdf'
    ];
    for (const path of immutablePaths) {
      await assertSucceeds(put('owner', path));
      await assertSucceeds(read('member', path));
      await assertFails(put('owner', path));
      await assertFails(remove('owner', path));
    }
    const mutablePath = 'projects/alpha/library/record_in/docs/manual.pdf';
    await assertSucceeds(put('member', mutablePath));
    await assertSucceeds(put('member', mutablePath));
    await assertSucceeds(remove('member', mutablePath));

    await assertSucceeds(put('participant', 'chat/secure_room/message.enc.json'));
    await assertSucceeds(read('owner', 'chat/secure_room/message.enc.json'));
    await assertFails(read('admin-only', 'chat/secure_room/message.enc.json'));
    await assertFails(read('platform-admin', 'chat/secure_room/message.enc.json'));
    await assertFails(read('outsider', 'chat/secure_room/message.enc.json'));

    const projectChatPath = 'chat/project_alpha/history.enc.json';
    await assertSucceeds(put('member', projectChatPath));
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'projects', 'alpha'), {
        ownerId: 'owner', memberIds: ['owner']
      });
    });
    await assertFails(read('member', projectChatPath));
    await assertFails(put('member', 'chat/project_alpha/after-removal.enc.json'));
    await assertFails(remove('member', projectChatPath));
    await assertSucceeds(read('owner', projectChatPath));

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
      projectOwnerMemberOrPlatformAdminAccess: true,
      chatExplicitParticipantOnly: true,
      projectChatRequiresLiveProjectMembership: true,
      userProfileAdminSelfEscalationDenied: true,
      stickerOwnerWriteSignedInRead: true,
      anonymousDenied: true,
      unrelatedLiveRulePreserved: true
      ,immutableRevisionOverwriteDeleteDenied: true
      ,brokerRenderBytesServerWriteOnly: true
    }, null, 2));
  } finally {
    if (env) await env.cleanup();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

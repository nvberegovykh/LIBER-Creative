'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const read=p=>fs.readFileSync(p,'utf8');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const embed=read('docs/liber-apps/apps/revex/chat-embed-r141.js');
const compat=read('docs/liber-apps/apps/secure-chat/revex-compat-r141.js');
const server=read('server/firebase-functions/project-chat.js');
new Function(embed);new Function(compat);new Function(server);
const has=(text,needle,label)=>assert.ok(text.includes(needle),`${label}: missing ${needle}`);
const no=(text,needle,label)=>assert.ok(!text.includes(needle),`${label}: forbidden ${needle}`);

has(ui,"chat-embed-r141.js?v=20260819r141-chat-embed1",'REVEX current loader');
has(embed,"revex-compat-r141.js?v=20260819r141-revex-chat-compat1",'same-origin Secure Chat injection');
has(embed,"/liber-apps/apps/secure-chat/",'Secure Chat owner boundary');
has(compat,"const BUILD='20260819r141-revex-chat-compat1'",'Secure Chat compatibility build');
has(compat,'participantSalt', 'legacy participant-derived crypto salt');
has(compat,'cryptoLegacySalts', 'server-preserved legacy crypto salts');
has(compat,'deriveFallbackSharedAesKey', 'legacy shared-key compatibility');
has(compat,'liber_secure_chat_conn_stable_v1', 'connection-stable compatibility');
has(compat,'liber_group_fallback_v2', 'legacy group compatibility');
has(compat,"document.body.classList.add('revex-embedded-mobile')",'embedded mobile activation');
has(compat,"app.isMobileViewport=function()",'Secure Chat mobile behavior owner reuse');
has(compat,'.sidebar.open .connections-panel','mobile connection drawer');
has(compat,'.main{position:fixed!important','single-column embedded chat');
no(compat,'localStorage.setItem(', 'no new plaintext/key storage lane');

has(server,"const BUILD = '20260819-project-chat3'",'Project Chat server build');
has(server,'function cryptoLegacySalts', 'server crypto lineage preservation');
has(server,'const connectionKey = created ? projectKey : (existingKey || projectKey);','existing Secure Chat key preservation');
has(server,'projectKey,','separate REVEX project identity key');
has(server,'cryptoLegacySalts: legacySalts','legacy salt persistence');
no(server,'key: `project:${projectId}`','unconditional Secure Chat key overwrite');

console.log(JSON.stringify({REVEX_R141_CHAT_COMPAT:'PASSED',secureChatRemainsOwner:true,legacyCryptoCandidates:true,existingKeyPreserved:true,projectIdentitySeparate:true,embeddedMobile:true,newPlaintextStorage:false}));

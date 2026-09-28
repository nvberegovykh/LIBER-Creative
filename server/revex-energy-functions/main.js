'use strict';

// Keep existing Energy broker source intact and compose the bounded Project Chat
// connection resolver beside it. Firebase discovers exports through this file.
const energy = require('./index');
const projectChat = require('./project-chat');

module.exports = {
  ...energy,
  ensureProjectChatHttp: projectChat.ensureProjectChatHttp
};

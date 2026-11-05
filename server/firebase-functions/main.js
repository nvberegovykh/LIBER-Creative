'use strict';

// Keep existing Energy broker source intact and compose bounded service surfaces beside it.
// Firebase discovers exports through this file.
const energy = require('./index');
const projectChat = require('./project-chat');
const observerAgent = require('./observer-agent-broker');
const jerichoIdentity = require('./jericho-identity');

module.exports = {
  ...jerichoIdentity,
  ...energy,
  ensureProjectChatHttp: projectChat.ensureProjectChatHttp,
  issueRevexObserverAnonymousClaim: observerAgent.issueRevexObserverAnonymousClaim,
  issueRevexObserverAgentClaim: observerAgent.issueRevexObserverAgentClaim,
  issueRevexObserverPairCode: observerAgent.issueRevexObserverPairCode,
  claimRevexObserverAgentSession: observerAgent.claimRevexObserverAgentSession,
  pullRevexObserverAgentRequests: observerAgent.pullRevexObserverAgentRequests,
  completeRevexObserverAgentRequest: observerAgent.completeRevexObserverAgentRequest,
  revexObserverMcp: observerAgent.revexObserverMcp
};

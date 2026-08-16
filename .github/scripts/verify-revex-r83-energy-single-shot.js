'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const bridgePath = path.join(root, 'src', 'Liber.Revex.Revit', 'Engineering', 'Companion', 'native-managed-energy-bridge.js');
const hostPath = path.join(root, 'src', 'Liber.Revex.Revit', 'Services', 'EngineeringCompanionWebBridge.cs');

const bridge = fs.readFileSync(bridgePath, 'utf8');
const host = fs.readFileSync(hostPath, 'utf8');

function requireMarker(text, marker, label) {
  if (!text.includes(marker)) throw new Error(`${label} missing: ${marker}`);
}

requireMarker(bridge, "const VERSION = '20260816r83';", 'managed bridge version');
requireMarker(bridge, 'priorBridge?.version === VERSION', 'same-document reinjection guard');
requireMarker(bridge, 'window.__revexManagedEnergyActive instanceof Map', 'global revision execution owner');
requireMarker(bridge, 'function ownTask(key, factory)', 'single-flight revision primitive');
requireMarker(bridge, 'return ownTask(key, () => authorizeAndRun', 'explicit authorization single-flight');
requireMarker(bridge, 'authorizeButton.onclick = handler;', 'single authorization button owner');
if (bridge.includes("authorizeButton.addEventListener('click'"))
  throw new Error('authorization button must not accumulate click listeners');

requireMarker(host, 'private const string ManagedBridgeVersion = "20260816r83";', 'native host bridge version');
const ensureStart = host.indexOf('public static async Task<(bool ok, string message)> EnsureManagedEnergyBridgeAsync');
const coreStart = host.indexOf('private static async Task<(bool ok, string message)> EnsureManagedEnergyBridgeCoreAsync');
if (ensureStart < 0 || coreStart <= ensureStart) throw new Error('could not isolate bridge ensure method');
const ensureBody = host.slice(ensureStart, coreStart);
if (ensureBody.includes('TryResumeLatestEngineeringRevisionAsync'))
  throw new Error('bridge initialization still executes preserved Engineering revisions');
requireMarker(ensureBody, 'return await EnsureManagedEnergyBridgeCoreAsync(web);', 'bridge initialization-only contract');
requireMarker(host, 'var installed = await EnsureManagedEnergyBridgeCoreAsync(web);', 'manual Engineering handoff still ensures bridge');
requireMarker(host, 'const task = bridge.processInput(files);', 'manual Engineering handoff still starts managed chain');

console.log('PASS: r83 Energy is single-shot per project/revision, bridge initialization is non-executing, and explicit SYNC/authorization paths remain wired.');

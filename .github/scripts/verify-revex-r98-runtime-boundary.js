'use strict';
const fs=require('fs');
const helper=fs.readFileSync('server/revex-energy-worker/revex_cloud_project.py','utf8');
const app=fs.readFileSync('server/revex-energy-worker/app.py','utf8');
const agent=fs.readFileSync('server/revex-energy-worker/revex_identity_content_agent.py','utf8');
if(!helper.includes('Application-level REVEX project ids are intentionally never accepted as fallback'))throw new Error('REVEX/GCP identity boundary missing');
if(!agent.includes('project = resolve_vertex_project()'))throw new Error('content agent not bound to cloud resolver');
// app still receives REVEX projectId for Firestore/storage revision identity; deployment explicitly supplies
// the separate Vertex project environment so this application id is never the intended cloud routing source.
if(!app.includes('project_id = str(data.get("projectId")'))throw new Error('REVEX application identity contract moved unexpectedly');
console.log('REVEX_R98_RUNTIME_IDENTITY_BOUNDARY=PASSED');

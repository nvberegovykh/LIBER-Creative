'use strict';
const fs=require('fs');
const agent=fs.readFileSync('server/revex-energy-worker/revex_identity_content_agent.py','utf8');
const region=agent.split('def _run_content_agent',2)[1].split('page_summary =',1)[0];
if(region.includes('or ""'))throw new Error('content agent still silently disables itself when cloud project is missing');
if(region.includes('project_id'))throw new Error('content agent still routes Vertex through REVEX application project identity');
if(!region.includes('resolve_vertex_project()'))throw new Error('authoritative resolver missing');
console.log('REVEX_R98_NO_APPLICATION_ID_VERTEX_FALLBACK=PASSED');

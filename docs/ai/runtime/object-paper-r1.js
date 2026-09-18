/* LIBER/AI Object Paper Runtime r1
 * Model-agnostic spatial reasoning layer.
 * No renderer. No image synthesis. No hidden Euler rotation sequence.
 * Object geometry is expressed in one explicit basis and observed through explicit projections.
 */
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory();
  else root.LiberObjectPaper=Object.freeze(factory());
})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';

const VERSION='20260918r1-object-paper';
const EPS=1e-9;
const AXON_TOL=1e-5;

const finite=n=>Number.isFinite(Number(n));
const num=n=>{n=Number(n);if(!Number.isFinite(n))throw new Error('Expected finite number.');return n;};
const v3=a=>{
  if(!Array.isArray(a)||a.length!==3||!a.every(finite))throw new Error('Expected finite vec3.');
  return [Number(a[0]),Number(a[1]),Number(a[2])];
};
const v2=a=>{
  if(!Array.isArray(a)||a.length!==2||!a.every(finite))throw new Error('Expected finite vec2.');
  return [Number(a[0]),Number(a[1])];
};
const add=(a,b)=>a.map((x,i)=>x+b[i]);
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const mul=(a,s)=>a.map(x=>x*s);
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a,b)=>[
  a[1]*b[2]-a[2]*b[1],
  a[2]*b[0]-a[0]*b[2],
  a[0]*b[1]-a[1]*b[0]
];
const len=a=>Math.hypot(...a);
const unit=a=>{a=v3(a);const l=len(a);if(l<EPS)throw new Error('Zero-length vector.');return mul(a,1/l);};
const dist2=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const clone=v=>JSON.parse(JSON.stringify(v));

function assertOrthonormalFrame(frame,label='frame',tol=1e-6){
  if(!frame||typeof frame!=='object')throw new Error(label+' missing.');
  const origin=v3(frame.origin||[0,0,0]);
  const x=unit(frame.x||frame.axes?.x);
  const y=unit(frame.y||frame.axes?.y);
  const z=unit(frame.z||frame.axes?.z);
  const checks=[
    Math.abs(dot(x,y))<=tol,
    Math.abs(dot(x,z))<=tol,
    Math.abs(dot(y,z))<=tol,
    Math.abs(dot(cross(x,y),z)-1)<=tol
  ];
  if(!checks.every(Boolean))throw new Error(label+' must be a right-handed orthonormal basis.');
  return {origin,x,y,z};
}

function localToWorld(point,frame){
  const p=v3(point),f=assertOrthonormalFrame(frame,'object.frame');
  return add(f.origin,add(mul(f.x,p[0]),add(mul(f.y,p[1]),mul(f.z,p[2]))));
}

function viewBasis(view){
  if(!view||typeof view!=='object')throw new Error('View missing.');
  if(view.type==='perspective'){
    const camera=v3(view.camera),target=v3(view.target),upHint=unit(view.up||[0,0,1]);
    const forward=unit(sub(target,camera));
    let right=unit(cross(forward,upHint));
    const up=unit(cross(right,forward));
    return {type:'perspective',camera,target,forward,right,up};
  }
  const origin=v3(view.origin||[0,0,0]);
  const normal=unit(view.normal);
  const u=unit(view.u);
  const v=unit(view.v);
  if(Math.abs(dot(u,v))>1e-6||Math.abs(dot(u,normal))>1e-6||Math.abs(dot(v,normal))>1e-6)
    throw new Error('Parallel view basis must be orthonormal.');
  const handed=dot(cross(u,v),normal);
  if(Math.abs(Math.abs(handed)-1)>1e-6)throw new Error('Parallel view basis is degenerate.');
  const direction=unit(view.direction||mul(normal,-1));
  if(Math.abs(dot(direction,normal))<EPS)throw new Error('Projection direction is parallel to receiving plane.');
  return {type:'parallel',origin,normal,u,v,direction};
}

function applyViewport(xy,view){
  let out=[xy[0],xy[1]];
  const vp=view.viewport;
  if(!vp)return out;
  const scale=Array.isArray(vp.scale)?v2(vp.scale):[num(vp.scale??1),num(vp.scale??1)];
  const offset=v2(vp.offset||[0,0]);
  out=[out[0]*scale[0]+offset[0],out[1]*scale[1]+offset[1]];
  if(vp.yDown)out[1]=offset[1]-(xy[1]*scale[1]);
  return out;
}

function projectWorldPoint(worldPoint,view){
  const p=v3(worldPoint),b=viewBasis(view);
  if(b.type==='perspective'){
    const rel=sub(p,b.camera);
    const depth=dot(rel,b.forward);
    if(depth<=EPS)return {xy:[NaN,NaN],depth,behind:true};
    const fov=Number(view.verticalFovDeg||50)*Math.PI/180;
    const f=1/Math.tan(fov/2);
    const aspect=Number(view.aspect||1);
    const x=dot(rel,b.right)/depth*f/aspect;
    const y=dot(rel,b.up)/depth*f;
    return {xy:applyViewport([x,y],view),depth,behind:false};
  }
  const denom=dot(b.direction,b.normal);
  const t=dot(sub(b.origin,p),b.normal)/denom;
  const q=add(p,mul(b.direction,t));
  const rel=sub(q,b.origin);
  return {xy:applyViewport([dot(rel,b.u),dot(rel,b.v)],view),depth:dot(sub(p,b.origin),b.normal),behind:false};
}

function projectLocalPoint(localPoint,paper,view){
  const frame=paper.object?.frame;
  return projectWorldPoint(localToWorld(localPoint,frame),view);
}

function indexGeometry(paper){
  const vertices=new Map();
  for(const row of paper.object?.geometry?.vertices||[]){
    if(!row?.id)throw new Error('Every vertex needs id.');
    if(vertices.has(row.id))throw new Error('Duplicate vertex '+row.id);
    vertices.set(row.id,v3(row.p));
  }
  const segments=[];
  for(const row of paper.object?.geometry?.segments||[]){
    if(!row?.id)throw new Error('Every segment needs id.');
    if(!vertices.has(row.a)||!vertices.has(row.b))throw new Error('Segment '+row.id+' references unknown vertex.');
    segments.push({...row,aPoint:vertices.get(row.a),bPoint:vertices.get(row.b)});
  }
  return {vertices,segments};
}

function projectSegment(segment,paper,view){
  const a=projectLocalPoint(segment.aPoint,paper,view);
  const b=projectLocalPoint(segment.bPoint,paper,view);
  return {...segment,a2:a.xy,b2:b.xy,depthA:a.depth,depthB:b.depth};
}

function projectedSegments(paper,viewOrId,filter={}){
  const view=typeof viewOrId==='string'
    ?(paper.observations||[]).find(v=>v.id===viewOrId)
    :viewOrId;
  if(!view)throw new Error('Unknown view '+viewOrId);
  const {segments}=indexGeometry(paper);
  return segments.filter(s=>{
    if(filter.kind&&s.kind!==filter.kind)return false;
    if(Array.isArray(filter.kinds)&&!filter.kinds.includes(s.kind))return false;
    if(Array.isArray(filter.ids)&&!filter.ids.includes(s.id))return false;
    return true;
  }).map(s=>projectSegment(s,paper,view));
}

function segmentDistance2(a,b,c,d){
  function pointSeg(p,x,y){
    const vx=y[0]-x[0],vy=y[1]-x[1],wx=p[0]-x[0],wy=p[1]-x[1];
    const vv=vx*vx+vy*vy;
    const t=vv<EPS?0:Math.max(0,Math.min(1,(wx*vx+wy*vy)/vv));
    return Math.hypot(p[0]-(x[0]+t*vx),p[1]-(x[1]+t*vy));
  }
  function orient(p,q,r){return (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);}
  const o1=orient(a,b,c),o2=orient(a,b,d),o3=orient(c,d,a),o4=orient(c,d,b);
  if(((o1===0||o2===0||o1*o2<0)&&(o3===0||o4===0||o3*o4<0)))return 0;
  return Math.min(pointSeg(a,c,d),pointSeg(b,c,d),pointSeg(c,a,b),pointSeg(d,a,b));
}

function polylineSegments(points){
  const ps=(points||[]).map(v2),out=[];
  for(let i=0;i+1<ps.length;i++)out.push([ps[i],ps[i+1]]);
  return out;
}

function projectedCoincidenceGroups(paper,viewId,filter={},tolerance=1e-5){
  const segs=projectedSegments(paper,viewId,filter);
  const parent=segs.map((_,i)=>i);
  const find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
  const join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
  for(let i=0;i<segs.length;i++)for(let j=i+1;j<segs.length;j++){
    const a=segs[i],b=segs[j];
    const direct=Math.max(dist2(a.a2,b.a2),dist2(a.b2,b.b2));
    const reverse=Math.max(dist2(a.a2,b.b2),dist2(a.b2,b.a2));
    if(Math.min(direct,reverse)<=tolerance)join(i,j);
  }
  const groups=new Map();
  segs.forEach((s,i)=>{const k=find(i);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(s.id);});
  return [...groups.values()];
}

function measureAxonometry(paper,viewId,tolerance=AXON_TOL){
  const view=(paper.observations||[]).find(v=>v.id===viewId);
  if(!view||view.type==='perspective')throw new Error('Axonometry classification requires a parallel view.');
  const f=assertOrthonormalFrame(paper.object.frame,'object.frame');
  const b=viewBasis(view);
  const projectVector=axis=>{
    const p0=projectWorldPoint(f.origin,view).xy;
    const p1=projectWorldPoint(add(f.origin,axis),view).xy;
    return dist2(p0,p1);
  };
  const scales=[projectVector(f.x),projectVector(f.y),projectVector(f.z)];
  const max=Math.max(...scales,EPS),eq=(a,b)=>Math.abs(a-b)<=tolerance*max;
  let classification='trimetric';
  if(eq(scales[0],scales[1])&&eq(scales[1],scales[2]))classification='isometric';
  else if(eq(scales[0],scales[1])||eq(scales[0],scales[2])||eq(scales[1],scales[2]))classification='dimetric';
  return {viewId,classification,foreshortening:{x:scales[0],y:scales[1],z:scales[2]},isAxonometric:true,note:'Isometry is the equal-foreshortening special case of axonometry.'};
}

function correctionCandidates(paper,correction){
  const scope=correction.scope||{};
  return projectedSegments(paper,correction.viewId,{
    kind:scope.featureKind,
    kinds:scope.featureKinds,
    ids:scope.featureIds
  });
}

function correctionDistance(segment,geometry){
  if(!geometry)return Infinity;
  const pts=geometry.points||[];
  if(geometry.type==='point'&&pts[0]){
    return Math.min(segmentDistance2(segment.a2,segment.b2,v2(pts[0]),v2(pts[0])));
  }
  const lines=polylineSegments(pts);
  if(!lines.length)return Infinity;
  return Math.min(...lines.map(([a,b])=>segmentDistance2(segment.a2,segment.b2,a,b)));
}

function evaluateVectorCorrections(paper){
  const results=[];
  for(const c of paper.vectorCorrections||[]){
    if(!c.id||!c.viewId||!c.intent)throw new Error('Vector correction requires id, viewId and intent.');
    const tol=Number(c.tolerance2d??0.02);
    const candidates=correctionCandidates(paper,c);
    const distances=candidates.map(s=>({id:s.id,distance:correctionDistance(s,c.geometry)}));
    const nearest=distances.length?Math.min(...distances.map(x=>x.distance)):Infinity;
    let pass=true;
    if(c.intent==='forbid')pass=nearest>tol;
    else if(c.intent==='expected'||c.intent==='preserve')pass=nearest<=tol;
    else if(c.intent==='note')pass=true;
    else throw new Error('Unknown vector correction intent '+c.intent);
    results.push({id:c.id,viewId:c.viewId,intent:c.intent,pass,tolerance2d:tol,nearest,candidates:distances});
  }
  return results;
}

function evaluateInvariant(paper,inv){
  const {segments}=indexGeometry(paper);
  if(inv.type==='feature-count'){
    const count=segments.filter(s=>s.kind===inv.kind).length;
    return {id:inv.id,type:inv.type,pass:count===Number(inv.expected),observed:count,expected:Number(inv.expected)};
  }
  if(inv.type==='feature-presence'){
    const ids=new Set(segments.map(s=>s.id));
    const missing=(inv.ids||[]).filter(id=>!ids.has(id));
    return {id:inv.id,type:inv.type,pass:missing.length===0,missing};
  }
  if(inv.type==='no-feature'){
    const hits=segments.filter(s=>(inv.kind&&s.kind===inv.kind)||(inv.ids||[]).includes(s.id)).map(s=>s.id);
    return {id:inv.id,type:inv.type,pass:hits.length===0,hits};
  }
  if(inv.type==='frame-orthonormal'){
    try{assertOrthonormalFrame(paper.object.frame);return {id:inv.id,type:inv.type,pass:true};}
    catch(error){return {id:inv.id,type:inv.type,pass:false,error:error.message};}
  }
  if(inv.type==='projection-coincidence-groups'){
    const groups=projectedCoincidenceGroups(paper,inv.viewId,{kind:inv.kind,kinds:inv.kinds,ids:inv.ids},Number(inv.tolerance2d??1e-5));
    return {id:inv.id,type:inv.type,pass:groups.length===Number(inv.expectedGroups),observedGroups:groups.length,expectedGroups:Number(inv.expectedGroups),groups};
  }
  if(inv.type==='axonometry-class'){
    const result=measureAxonometry(paper,inv.viewId,Number(inv.tolerance??AXON_TOL));
    return {id:inv.id,type:inv.type,pass:result.classification===inv.expected,observed:result.classification,expected:inv.expected,detail:result};
  }
  if(inv.type==='manual'){
    return {id:inv.id,type:inv.type,pass:inv.status==='PASS',status:inv.status||'UNRESOLVED',note:inv.note||null};
  }
  return {id:inv.id,type:inv.type,pass:false,error:'Unsupported invariant type'};
}

function validatePaper(paper){
  const errors=[];
  try{
    if(paper?.schema!=='liber.ai.object-paper.v1')errors.push('schema must be liber.ai.object-paper.v1');
    assertOrthonormalFrame(paper.object?.frame,'object.frame');
    indexGeometry(paper);
    const ids=new Set();
    for(const v of paper.observations||[]){
      if(!v.id)errors.push('observation missing id');
      if(ids.has(v.id))errors.push('duplicate observation '+v.id);
      ids.add(v.id);
      try{viewBasis(v);}catch(e){errors.push('view '+(v.id||'?')+': '+e.message);}
    }
  }catch(e){errors.push(e.message);}
  return {ok:errors.length===0,errors};
}

function evaluatePaperReady(paper){
  const structural=validatePaper(paper);
  if(!structural.ok)return {paperReady:false,structural,invariants:[],corrections:[],gatingUnresolved:[],reasons:structural.errors};
  const invariants=(paper.hardInvariants||[]).map(inv=>evaluateInvariant(paper,inv));
  const corrections=evaluateVectorCorrections(paper);
  const gatingUnresolved=(paper.unresolved||[]).filter(x=>x.gating!==false);
  const reasons=[
    ...invariants.filter(x=>!x.pass).map(x=>'Invariant failed: '+(x.id||x.type)),
    ...corrections.filter(x=>!x.pass).map(x=>'Vector correction failed: '+x.id),
    ...gatingUnresolved.map(x=>'Unresolved gating item: '+(x.id||x.note||'unknown'))
  ];
  return {
    schema:'liber.ai.paper-readiness.v1',
    paperReady:reasons.length===0,
    structural,
    invariants,
    corrections,
    gatingUnresolved:clone(gatingUnresolved),
    reasons,
    next:reasons.length?'Return to paper/object processing. Do not render.':'Stop and request explicit human launch authorization before rendering.'
  };
}

function ingestVectorCorrections(paper,corrections){
  const out=clone(paper);
  out.vectorCorrections=Array.isArray(out.vectorCorrections)?out.vectorCorrections:[];
  const seen=new Set(out.vectorCorrections.map(x=>x.id));
  for(const raw of corrections||[]){
    if(!raw?.id||seen.has(raw.id))throw new Error('Vector correction id missing or duplicate: '+raw?.id);
    if(!['forbid','expected','preserve','note'].includes(raw.intent))throw new Error('Unsupported vector correction intent.');
    if(!raw.viewId)throw new Error('Vector correction requires viewId.');
    if(raw.intent!=='note'){
      if(!raw.geometry||!['point','line','polyline'].includes(raw.geometry.type))throw new Error('Vector correction requires point/line/polyline geometry.');
      (raw.geometry.points||[]).forEach(v2);
    }
    out.vectorCorrections.push(clone(raw));seen.add(raw.id);
  }
  return out;
}

return Object.freeze({
  version:VERSION,
  assertOrthonormalFrame,
  localToWorld,
  projectWorldPoint,
  projectLocalPoint,
  projectedSegments,
  projectedCoincidenceGroups,
  measureAxonometry,
  ingestVectorCorrections,
  evaluateVectorCorrections,
  evaluateInvariant,
  evaluatePaperReady,
  validatePaper
});
});

/* REVEX elevator stop observer r149
 * Derives the existing landing-stop ladder from native Family Editor evidence.
 * No mutation: this only converts repeated source door-leaf geometry into a
 * bounded, ordered set of stop elevations and visibility semantics for S7.
 */
(function(root){
'use strict';
if(root.RevexElevatorStops?.version==='20260915r149-stops1')return;

const VERSION='20260915r149-stops1';
const clean=v=>String(v??'').trim();
const clone=v=>{try{return structuredClone(v)}catch(_){try{return JSON.parse(JSON.stringify(v))}catch(__){return null}}};
const round=v=>Math.round(v*192)/192; // 1/16 inch in feet

function bbox(node){
  const a=node?.bboxMinFt,b=node?.bboxMaxFt;
  if(!Array.isArray(a)||!Array.isArray(b)||a.length<3||b.length<3)return null;
  const min=a.map(Number),max=b.map(Number);
  if([...min,...max].some(v=>!Number.isFinite(v)))return null;
  return {min,max,dx:max[0]-min[0],dy:max[1]-min[1],dz:max[2]-min[2]};
}
function text(node){
  return [node?.name,node?.class,node?.kind,node?.category,
    ...Object.keys(node?.parameters||{}),...Object.values(node?.parameters||{}),
    ...Object.keys(node?.associations||{}),...Object.values(node?.associations||{})]
    .map(clean).join(' ').toLowerCase();
}
function visibility(node){
  const values=Object.values(node?.associations||{}).map(clean);
  return values.find(v=>/^visibility for \d+ stops$/i.test(v))||null;
}
function mode(values){
  const counts=new Map();
  for(const value of values.filter(Boolean))counts.set(value,(counts.get(value)||0)+1);
  return [...counts.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]||null;
}

function derive(inspection,plan){
  const nodes=Array.isArray(inspection?.nodes)?inspection.nodes:[];
  const doorHeight=Number(plan?.proposed?.doorHeightFt);
  if(!(doorHeight>0))return {status:'WAITING_EVIDENCE',reason:'S7 stop derivation requires the proven native door height.'};

  const candidates=nodes.filter(node=>{
    if(node?.kind!=='generic-form')return false;
    if(clean(node?.parameters?.IsSolid).toLowerCase()!=='true')return false;
    const b=bbox(node);if(!b)return false;
    const thin=Math.min(b.dx,b.dy),wide=Math.max(b.dx,b.dy);
    if(thin>0.20||wide<1.0||wide>4.5)return false;
    if(b.dz<doorHeight-0.10||b.dz>doorHeight+0.60)return false;
    const t=text(node);
    return /door|lobby|elevator/.test(t)||/_elevator door finish|_elevator cab doors/.test(t)||/visibility for \d+ stops/.test(t);
  });

  const groups=new Map();
  for(const node of candidates){
    const b=bbox(node);const key=round(b.min[2]);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(node);
  }

  const stops=[...groups.entries()]
    .map(([baseZFt,rows])=>({
      baseZFt:Number(baseZFt),
      sourceElementIds:rows.map(row=>row.id).filter(Boolean),
      sourceCount:rows.length,
      visibilityParameter:mode(rows.map(visibility)),
      sourceKinds:[...new Set(rows.map(row=>clean(row?.parameters?.Material)||clean(row?.associations?.Material)).filter(Boolean))]
    }))
    .filter(row=>row.sourceCount>=2)
    .sort((a,b)=>a.baseZFt-b.baseZFt);

  if(stops.length<2)return {status:'WAITING_EVIDENCE',reason:`S7 found only ${stops.length} credible landing elevations.`};
  if(stops.length>10)return {status:'WAITING_EVIDENCE',reason:`S7 found ${stops.length} credible landing elevations; expected at most 10.`};

  const gaps=stops.slice(1).map((row,i)=>row.baseZFt-stops[i].baseZFt);
  if(gaps.some(gap=>gap<6||gap>25))return {status:'WAITING_EVIDENCE',reason:'S7 landing elevations do not form a credible elevator stop ladder.',stops:clone(stops),gapsFt:gaps};

  return {
    status:'READY_FOR_LANDING_STOPS',
    stopCount:stops.length,
    stops:stops.map((row,index)=>({...row,stopIndex:index+1})),
    gapsFt:gaps,
    sourceCandidateCount:candidates.length,
    rule:'Each stop is a distinct native transaction and checkpoint; stop 1 reuses the S5 frame, later stops add a matching frame plus one landing panel.'
  };
}

root.RevexElevatorStops=Object.freeze({version:VERSION,derive});
try{root.__revexBrowserDiagnostics?.emit?.('INFO','ELEVATOR_STOPS_READY','Elevator native stop observer r149 ready',{initiator:'observer-elevator-stops-r149'});}catch(_){}
})(window);

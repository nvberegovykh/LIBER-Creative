/* LIBER/AI Dependency Graph Runtime r1
 * Deterministic, traceable formula DAG for paper/object reasoning.
 * No renderer. No arbitrary eval. No project mutation.
 */
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory(
    (()=>{try{return require('./object-paper-r1.js')}catch(_){return null}})()
  );
  else root.LiberDependencyGraph=Object.freeze(factory(root.LiberObjectPaper||null));
})(typeof globalThis!=='undefined'?globalThis:this,function(ObjectPaper){
'use strict';

const VERSION='20260918r1-dependency-graph';
const EPS=1e-9;
const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
const finite=n=>Number.isFinite(Number(n));
const num=n=>{const x=Number(n);if(!Number.isFinite(x))throw new Error('Expected finite number.');return x;};
const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);

function refs(expr,out=new Set()){
  if(!expr||typeof expr!=='object')return out;
  if(Object.prototype.hasOwnProperty.call(expr,'ref'))out.add(String(expr.ref));
  if(Array.isArray(expr))expr.forEach(x=>refs(x,out));
  else Object.values(expr).forEach(x=>refs(x,out));
  return out;
}

function nodeDeps(node){
  return [...new Set([...(node.deps||[]).map(String),...refs(node.expr)])];
}

function index(graph){
  if(graph?.schema!=='liber.ai.dependency-graph.v1')throw new Error('Graph schema must be liber.ai.dependency-graph.v1.');
  if(!Array.isArray(graph.nodes))throw new Error('Graph nodes missing.');
  const byId=new Map();
  for(const node of graph.nodes){
    const id=String(node?.id||'').trim();
    if(!id)throw new Error('Graph node missing id.');
    if(byId.has(id))throw new Error('Duplicate graph node '+id);
    if(!['input','formula','invariant','output'].includes(node.kind))throw new Error('Unsupported node kind '+node.kind+' for '+id);
    byId.set(id,{...clone(node),id});
  }
  for(const node of byId.values()){
    for(const dep of nodeDeps(node))if(!byId.has(dep))throw new Error('Node '+node.id+' references unknown dependency '+dep);
  }
  return byId;
}

function topologicalOrder(graph){
  const byId=index(graph);
  const state=new Map(),order=[],stack=[];
  function visit(id){
    const s=state.get(id)||0;
    if(s===2)return;
    if(s===1){
      const i=stack.indexOf(id);
      throw new Error('Dependency cycle: '+[...stack.slice(i),id].join(' -> '));
    }
    state.set(id,1);stack.push(id);
    const node=byId.get(id);
    for(const dep of nodeDeps(node))visit(dep);
    stack.pop();state.set(id,2);order.push(id);
  }
  for(const id of byId.keys())visit(id);
  return order;
}

function vec(a,n){
  if(!Array.isArray(a)||a.length!==n||!a.every(finite))throw new Error('Expected vec'+n+'.');
  return a.map(Number);
}
const vadd=(a,b)=>a.map((x,i)=>x+b[i]);
const vsub=(a,b)=>a.map((x,i)=>x-b[i]);
const vmul=(a,s)=>a.map(x=>x*s);
const vdot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const vcross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const vlen=a=>Math.hypot(...a);
const vunit=a=>{const l=vlen(a);if(l<EPS)throw new Error('Cannot normalize zero vector.');return vmul(a,1/l);};

function valueAt(obj,path){
  if(path===undefined||path===null||path==='')return obj;
  const keys=Array.isArray(path)?path:String(path).split('.').filter(Boolean);
  let cur=obj;
  for(const key of keys){
    if(cur==null)return undefined;
    cur=cur[key];
  }
  return cur;
}

function equal(a,b){return JSON.stringify(a)===JSON.stringify(b);}

function evaluateExpr(expr,values,context={}){
  if(expr===null||typeof expr==='string'||typeof expr==='number'||typeof expr==='boolean')return expr;
  if(Array.isArray(expr))return expr.map(x=>evaluateExpr(x,values,context));
  if(!isObj(expr))return expr;
  if(Object.prototype.hasOwnProperty.call(expr,'const'))return clone(expr.const);
  if(Object.prototype.hasOwnProperty.call(expr,'ref')){
    const id=String(expr.ref);
    if(!values.has(id))throw new Error('Dependency '+id+' has no value.');
    return clone(values.get(id));
  }
  const op=String(expr.op||'');
  const args=(expr.args||[]).map(x=>evaluateExpr(x,values,context));
  switch(op){
    case 'get': return valueAt(args[0],args[1]);
    case 'eq': return equal(args[0],args[1]);
    case 'neq': return !equal(args[0],args[1]);
    case 'approxEq': return Math.abs(num(args[0])-num(args[1]))<=num(args[2]??1e-6);
    case 'gt': return num(args[0])>num(args[1]);
    case 'gte': return num(args[0])>=num(args[1]);
    case 'lt': return num(args[0])<num(args[1]);
    case 'lte': return num(args[0])<=num(args[1]);
    case 'not': return !Boolean(args[0]);
    case 'and': return args.every(Boolean);
    case 'or': return args.some(Boolean);
    case 'if': return args[0]?args[1]:args[2];
    case 'add': return args.reduce((s,x)=>s+num(x),0);
    case 'sub': return num(args[0])-num(args[1]);
    case 'mul': return args.reduce((p,x)=>p*num(x),1);
    case 'div': {const d=num(args[1]);if(Math.abs(d)<EPS)throw new Error('Division by zero.');return num(args[0])/d;}
    case 'min': return Math.min(...args.map(num));
    case 'max': return Math.max(...args.map(num));
    case 'sum': return (args[0]||[]).reduce((s,x)=>s+num(x),0);
    case 'count': return Array.isArray(args[0])?args[0].length:(isObj(args[0])?Object.keys(args[0]).length:0);
    case 'vec2': return vec(args,2);
    case 'vec3': return vec(args,3);
    case 'vadd': return vadd(vec(args[0],3),vec(args[1],3));
    case 'vsub': return vsub(vec(args[0],3),vec(args[1],3));
    case 'vscale': return vmul(vec(args[0],3),num(args[1]));
    case 'dot': return vdot(vec(args[0],3),vec(args[1],3));
    case 'cross': return vcross(vec(args[0],3),vec(args[1],3));
    case 'length': return vlen(vec(args[0],3));
    case 'normalize': return vunit(vec(args[0],3));
    case 'objectPaperReady': {
      const api=context.objectPaper||ObjectPaper;
      if(!api?.evaluatePaperReady)throw new Error('Object Paper runtime unavailable.');
      return api.evaluatePaperReady(args[0]);
    }
    case 'coincidenceGroups': {
      const api=context.objectPaper||ObjectPaper;
      if(!api?.projectedCoincidenceGroups)throw new Error('Object Paper runtime unavailable.');
      return api.projectedCoincidenceGroups(args[0],args[1],args[2]||{},args[3]??1e-5);
    }
    case 'axonometry': {
      const api=context.objectPaper||ObjectPaper;
      if(!api?.measureAxonometry)throw new Error('Object Paper runtime unavailable.');
      return api.measureAxonometry(args[0],args[1],args[2]??1e-5);
    }
    default: throw new Error('Unsupported formula op '+op);
  }
}

function evaluateGraph(graph,overrides={},context={}){
  const byId=index(graph),order=topologicalOrder(graph),values=new Map(),results=new Map();
  for(const id of order){
    const node=byId.get(id),deps=nodeDeps(node);
    try{
      if(node.kind==='input'){
        const value=Object.prototype.hasOwnProperty.call(overrides,id)?overrides[id]:clone(node.value);
        values.set(id,value);results.set(id,{id,kind:node.kind,deps,value:clone(value),ok:true});
        continue;
      }
      const raw=evaluateExpr(node.expr,values,context);
      if(node.kind==='invariant'){
        const pass=Boolean(raw);
        values.set(id,pass);
        results.set(id,{id,kind:node.kind,deps,value:pass,pass,severity:node.severity||'hard',message:node.message||null,ok:true});
      }else{
        values.set(id,raw);results.set(id,{id,kind:node.kind,deps,value:clone(raw),ok:true});
      }
    }catch(error){
      values.set(id,undefined);results.set(id,{id,kind:node.kind,deps,value:undefined,ok:false,error:error.message});
    }
  }
  const hardFailures=[...results.values()].filter(r=>r.kind==='invariant'&&r.severity!=='soft'&&(!r.ok||!r.pass));
  const errors=[...results.values()].filter(r=>!r.ok);
  return {
    schema:'liber.ai.dependency-evaluation.v1',
    graphId:graph.id||null,
    order,
    ok:errors.length===0,
    hardPass:hardFailures.length===0,
    hardFailures:hardFailures.map(clone),
    errors:errors.map(clone),
    nodes:Object.fromEntries([...results.entries()].map(([k,v])=>[k,clone(v)]))
  };
}

function downstream(graph,startIds){
  const byId=index(graph),reverse=new Map([...byId.keys()].map(id=>[id,new Set()]));
  for(const node of byId.values())for(const dep of nodeDeps(node))reverse.get(dep).add(node.id);
  const out=new Set((startIds||[]).map(String)),queue=[...out];
  while(queue.length){
    const id=queue.shift();
    for(const next of reverse.get(id)||[])if(!out.has(next)){out.add(next);queue.push(next);}
  }
  return [...out];
}

function dependencyClosure(graph,targetIds){
  const byId=index(graph),out=new Set(),queue=(targetIds||[]).map(String);
  while(queue.length){
    const id=queue.shift();if(out.has(id))continue;out.add(id);
    const node=byId.get(id);if(!node)throw new Error('Unknown target '+id);
    queue.push(...nodeDeps(node));
  }
  return [...out];
}

function trace(graph,evaluation,targetId){
  const closure=dependencyClosure(graph,[targetId]);
  return closure.map(id=>clone(evaluation.nodes[id]));
}

return Object.freeze({
  version:VERSION,
  refs,
  topologicalOrder,
  evaluateExpr,
  evaluateGraph,
  downstream,
  dependencyClosure,
  trace
});
});

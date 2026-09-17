/* REVEX Observer AI session relay r152
 * Executes only the existing read-only window.RevexObserver surface inside an authorized REVEX browser session.
 * The public AI counter never receives Firebase credentials. Project authorization happens here through Pair AI.
 */
(function(root){
'use strict';
if(root.__revexObserverAgentBridgeR151)return;
root.__revexObserverAgentBridgeR151=true;

const BUILD='20260917r152-public-counter1';
const CLIENT_KEY='liber.revex.observer.agent.bridge.client.v1';
let stopped=false;
let timer=0;
let busy=false;

function clean(v){return String(v??'').trim();}
function state(){return root.__revexState||{};}
function observer(){return root.RevexObserver||null;}
function fs(){return root.firebaseService||null;}
function clientId(){
  try{
    let value=localStorage.getItem(CLIENT_KEY)||'';
    if(!value){value=`bridge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`;localStorage.setItem(CLIENT_KEY,value);}
    return value;
  }catch(_){return `bridge_${Date.now().toString(36)}`;}
}
function projectId(){const s=state();return clean(s.projectId||s.currentProjectId||s.project?.id||s.currentProject?.id);}
function revision(){const s=state();return clean(s.revision||s.currentRevision||s.viewerData?.revision||s.viewerData?.rev||s.project?.revision);}
function activeView(){const s=state();return clean(s.activeView||s.viewName||s.viewerData?.source?.viewName);}
function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'REVEX Observer AI bridge r152',build:BUILD,...detail});}catch(_){}}

function argsFor(method,args){
  switch(method){
    case 'snapshot': case 'getSelection': case 'listFocus': return [];
    case 'getElement': return [args?.id];
    case 'query': return [args?.filter||{}];
    case 'graph': return [args?.id,Number(args?.depth||1)];
    case 'createFocus': return [args?.spec||{}];
    case 'getFocus': return [args?.focusId];
    case 'updateFocus': return [args?.focusId,args?.patch||{}];
    case 'recordStep': return [args?.focusId,args?.step||{}];
    case 'closeFocus': return [args?.focusId,args?.status||'CLOSED'];
    case 'preview': return [args?.operation||{}];
    default: throw new Error(`Unsupported Observer relay method: ${method}`);
  }
}
async function complete(project,requestId,success,result,error){
  const service=fs();
  if(!service?.callFunction)throw new Error('Firebase callable bridge unavailable.');
  const response=await service.callFunction('completeRevexObserverAgentRequest',{projectId:project,requestId,success,result:success?result:null,error:success?null:clean(error)});
  if(!response?.ok)throw new Error('Observer request completion was not acknowledged.');
}
async function execute(project,request){
  const api=observer();
  if(!api)throw new Error('REVEX Observer API is not ready.');
  const method=clean(request?.method);
  const fn=api[method];
  if(typeof fn!=='function')throw new Error(`REVEX Observer method unavailable: ${method}`);
  const result=await Promise.resolve(fn.apply(api,argsFor(method,request?.args||{})));
  return result===undefined?null:result;
}
async function issuePairCode(options={}){
  const service=fs(),project=projectId();
  if(!service?.callFunction)throw new Error('Firebase callable bridge unavailable.');
  if(!project)throw new Error('Choose a REVEX project before pairing an AI.');
  const response=await service.callFunction('issueRevexObserverPairCode',{projectId:project,focusId:clean(options.focusId)||null});
  if(!response?.pairCode)throw new Error('Pairing service returned no code.');
  try{await navigator.clipboard.writeText(response.pairCode);}catch(_){}
  diag('INFO','OBSERVER_AGENT_PAIR_CODE','Issued one-time AI pairing code.',{projectId:project,expiresAt:response.expiresAt});
  return response;
}
function ensurePairButton(){
  if(document.getElementById('observer-ai-pair-button'))return;
  const select=document.getElementById('project-select'); if(!select)return;
  const anchor=document.getElementById('project-id-badge')||select.closest('.project-picker')||select;
  const button=document.createElement('button');
  button.id='observer-ai-pair-button';button.type='button';button.className='button ghost compact sp-btn sp-btn-ghost sp-btn-sm';button.textContent='Pair AI';button.title='Issue a one-time code that lets one AI Observer session attach to this project.';
  button.addEventListener('click',async()=>{
    const original='Pair AI'; button.disabled=true;button.textContent='Pairing…';
    try{
      const result=await issuePairCode();
      button.textContent=`Copied ${result.pairCode}`;
      setTimeout(()=>{button.textContent=original;button.disabled=false;},7000);
    }catch(error){
      button.textContent='Pair failed';diag('WARN','OBSERVER_AGENT_PAIR_FAILED',error?.message||String(error),{projectId:projectId()});
      setTimeout(()=>{button.textContent=original;button.disabled=false;},4000);
    }
  });
  anchor.insertAdjacentElement('afterend',button);
}
async function poll(){
  if(stopped||busy)return schedule();
  const api=observer(),service=fs(),project=projectId();
  ensurePairButton();
  if(!api||!service?.callFunction||!project)return schedule();
  busy=true;
  try{
    const response=await service.callFunction('pullRevexObserverAgentRequests',{
      projectId:project,
      bridge:{clientId:clientId(),observerVersion:api.version||null,revision:revision()||null,activeView:activeView()||null}
    });
    for(const request of response?.requests||[]){
      try{
        const result=await execute(project,request);
        await complete(project,request.requestId,true,result,null);
        diag('INFO','OBSERVER_AGENT_REQUEST_COMPLETE','Serviced one external Observer request.',{requestId:request.requestId,method:request.method,projectId:project});
      }catch(error){
        try{await complete(project,request.requestId,false,null,error?.message||String(error));}catch(_){}
        diag('WARN','OBSERVER_AGENT_REQUEST_FAILED',error?.message||String(error),{requestId:request?.requestId||null,method:request?.method||null,projectId:project});
      }
    }
  }catch(error){
    diag('WARN','OBSERVER_AGENT_POLL',error?.message||String(error),{projectId:project});
  }finally{busy=false;schedule();}
}
function schedule(){clearTimeout(timer);if(stopped)return;timer=setTimeout(poll,document.visibilityState==='hidden'?2200:900);}
function start(){stopped=false;ensurePairButton();schedule();diag('INFO','OBSERVER_AGENT_BRIDGE_READY','External Observer relay ready.',{clientId:clientId()});return {build:BUILD,clientId:clientId()};}
function stop(){stopped=true;clearTimeout(timer);timer=0;}

root.RevexObserverAgentBridge=Object.freeze({build:BUILD,start,stop,issuePairCode,clientId:clientId()});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
try{root.dispatchEvent(new CustomEvent('revex:observer-agent-bridge-ready',{detail:{build:BUILD}}));}catch(_){}
})(window);

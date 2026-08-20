/* WALLT — shared headless LIBER agent service. */
(function (root) {
  'use strict';
  const DEFAULT_MODEL = 'gpt-4.1';
  const DEFAULT_REGION = 'europe-west1';
  const DEFAULT_PROJECT = 'liber-apps-cca20';
  function sameOriginWindow(candidate) { try { if (!candidate || candidate === root) return null; void candidate.location.href; return candidate; } catch (_) { return null; } }
  function outputText(json) {
    if (!json) return '';
    if (typeof json.output_text === 'string') return json.output_text.trim();
    const chunks = [];
    for (const item of (json.output || [])) for (const part of (item?.content || [])) {
      if (typeof part?.text === 'string') chunks.push(part.text); else if (typeof part?.text?.value === 'string') chunks.push(part.text.value);
    }
    if (chunks.length) return chunks.join('\n').trim();
    if (typeof json?.choices?.[0]?.message?.content === 'string') return json.choices[0].message.content.trim();
    return '';
  }
  function parseJsonLoose(text) {
    const raw = String(text || '').trim(); if (!raw) return null;
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(cleaned); } catch (_) {}
    const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) { try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (_) {} }
    return null;
  }
  class WalltAgent {
    constructor() { this.name='WALLT'; this.model=DEFAULT_MODEL; this.proxyUrl=''; this.proxyAuth=''; this.apiKey=''; this.ready=false; this._initPromise=null; }
    legacyIntegration() {
      const candidates=[root,sameOriginWindow(root.parent),sameOriginWindow(root.top)].filter(Boolean);
      for (const w of candidates) { const agent=w.chatgptIntegration; if (agent?.openaiFetch || agent?.callWALLE) return agent; }
      return null;
    }
    async init() {
      if (this.ready) return this; if (this._initPromise) return this._initPromise;
      this._initPromise=(async()=>{
        const legacy=this.legacyIntegration();
        if (legacy) { this.model=String(legacy.responsesModel||this.model); this.proxyUrl=String(legacy.proxyUrl||''); this.proxyAuth=''; this.apiKey=''; }
        if ((!this.proxyUrl&&!this.apiKey)&&root.secureKeyManager?.getKeys) { try { const keys=await root.secureKeyManager.getKeys(); const region=keys?.firebase?.functionsRegion||DEFAULT_REGION; const projectId=keys?.firebase?.projectId||DEFAULT_PROJECT; this.proxyUrl=`https://${region}-${projectId}.cloudfunctions.net/openaiProxy`; this.proxyAuth=''; this.apiKey=''; } catch(_){} }
        if (!this.proxyUrl&&!this.apiKey) this.proxyUrl=`https://${DEFAULT_REGION}-${DEFAULT_PROJECT}.cloudfunctions.net/openaiProxy`;
        this.ready=true; return this;
      })(); return this._initPromise;
    }
    async openaiFetch(path, init={}) {
      await this.init(); const legacy=this.legacyIntegration(); if (legacy?.openaiFetch) return legacy.openaiFetch(path,init);
      const base=this.proxyUrl||'https://api.openai.com'; const url=path.startsWith('http')?path:`${base}${path}`; const headers={...(init.headers||{})};
      if (init.json!==false&&!headers['Content-Type']) headers['Content-Type']='application/json'; if(root.firebaseService?.auth?.currentUser?.getIdToken){const token=await root.firebaseService.auth.currentUser.getIdToken();if(token)headers.Authorization=`Bearer ${token}`;}
      return fetch(url,{...init,headers});
    }
    async response({instructions,input,model='',timeoutMs=60000}) {
      const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),Math.max(5000,Number(timeoutMs||60000)));
      try { const response=await this.openaiFetch('/v1/responses',{method:'POST',body:JSON.stringify({model:model||this.model||DEFAULT_MODEL,instructions:String(instructions||''),input}),signal:controller.signal}); const json=await response.json().catch(()=>({})); if(!response.ok) throw new Error(json?.error?.message||json?.message||`WALLT request failed (${response.status})`); const text=outputText(json); if(!text) throw new Error('WALLT returned no visible output.'); return text; } finally { clearTimeout(timer); }
    }
    async planRender({message,context={},history=[]}) {
      const capabilities=context.capabilities||{};
      const instructions=[
        'You are WALLT operating the REVEX Render workspace for architects.',
        'Translate the user request into an executable Revit + Rendair plan.',
        'Preserve the current Revit camera, geometry, openings, scale and modeled objects unless the user explicitly requests a design change.',
        'Use Revit materials, selected BIM element, Design Book decisions and project data as authoritative context when supplied.',
        'Do not invent missing model geometry. Do not silently change design intent.',
        'Prefer one render action that directly fulfills the latest request.',
        `Execution capabilities: ${JSON.stringify(capabilities)}`,
        `REVEX project context: ${JSON.stringify(context.project||{})}`,
        `Selected context: ${JSON.stringify(context.selection||{})}`,
        'Return ONLY a JSON object with this exact top-level shape:',
        '{"assistant":"short user-facing response","intent":"render|refine|question|revit|save|none","rendair":{"action":"prepare|refine|none","prompt":"complete Rendair prompt","environment":"Natural daylight|Bright overcast|Warm late-afternoon daylight|Night exterior - physically plausible","staging":"Preserve modeled objects only|Minimal real-estate staging|No loose furniture","people":"None|Very sparse, natural scale"},"revit":{"capture":true,"sync":false},"save":{"designBook":false,"chapterId":null},"needsUser":false}',
        'If the user asked for a render or visual change, rendair.action must be prepare or refine and rendair.prompt must be fully usable without another rewrite.',
        'If nativeAutomation is true, assume REVEX can capture from Revit, attach the capture, fill the Rendair prompt and submit automatically.'
      ].join('\n');
      const input=[...history.slice(-10).map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content||'')})),{role:'user',content:String(message||'')}];
      const text=await this.response({instructions,input}); const plan=parseJsonLoose(text); if(plan) return plan;
      return {assistant:text,intent:'none',rendair:{action:'none',prompt:'',environment:'Natural daylight',staging:'Preserve modeled objects only',people:'None'},revit:{capture:false,sync:false},save:{designBook:false,chapterId:null},needsUser:false};
    }
  }
  root.WalltAgent=WalltAgent; root.walltAgent=root.walltAgent||new WalltAgent();
})(window);

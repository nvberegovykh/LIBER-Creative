(function(root){
  'use strict';
  const BUILD='20260820r145-en1-amendment1';
  const clean=v=>String(v??'').trim().replace(/\s+/g,' ');
  const Store=()=>root.RevexStore;
  const State=()=>root.__revexState||{};
  const diagnostic=(level,stage,message,detail={})=>{try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'EN-1 identity amendment r145',...detail})}catch(_){}};
  let dirty=false,loadedKey='',busy=false;

  const fields={
    applicant:{
      firstName:['a-first','First name','autocomplete="given-name"'],lastName:['a-last','Last name','autocomplete="family-name"'],middleInitial:['a-mi','Middle initial','maxlength="1"'],licenseNumber:['a-license','License number','autocomplete="off"'],businessName:['a-business','Business name','autocomplete="organization"'],businessEmail:['a-business-email','Business email','type="email" autocomplete="email"'],businessAddress:['a-address','Business address','autocomplete="street-address"'],businessTelephone:['a-phone','Business telephone','autocomplete="tel"'],city:['a-city','City','autocomplete="address-level2"'],state:['a-state','State','autocomplete="address-level1" maxlength="32"'],zip:['a-zip','ZIP','autocomplete="postal-code" maxlength="10" inputmode="numeric"'],email:['a-email','Email','type="email" autocomplete="email"']
    },
    modeler:{
      firstName:['m-first','First name','autocomplete="given-name"'],lastName:['m-last','Last name','autocomplete="family-name"'],middleInitial:['m-mi','Middle initial','maxlength="1"'],businessName:['m-business','Business name','autocomplete="organization"'],businessAddress:['m-address','Business address','autocomplete="street-address"'],telephone:['m-phone','Telephone','autocomplete="tel"'],city:['m-city','City','autocomplete="address-level2"'],state:['m-state','State','autocomplete="address-level1" maxlength="32"'],zip:['m-zip','ZIP','autocomplete="postal-code" maxlength="10" inputmode="numeric"'],email:['m-email','Email','type="email" autocomplete="email"']
    }
  };
  const field=([suffix,label,attrs])=>`<label><span>${label}</span><input id="energy-en1-${suffix}" ${attrs||''}></label>`;
  const personFields=group=>Object.values(fields[group]).map(field).join('');

  function installCss(){if(document.getElementById('energy-en1-r145-css'))return;const style=document.createElement('style');style.id='energy-en1-r145-css';style.textContent=`
    #energy-en1-publication{grid-column:1/-1}.energy-en1-scope{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--line-2);border-radius:10px;background:#111821}.energy-en1-scope strong{display:block;font-size:12px}.energy-en1-scope span{display:block;margin-top:3px;color:var(--tx-3);font:9px/1.45 var(--mono)}.energy-en1-people{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.energy-en1-people details{border:1px solid var(--line);border-radius:10px;padding:10px;background:#0e141c}.energy-en1-people summary{cursor:pointer;font-weight:700;font-size:12px}.energy-en1-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px}.energy-en1-fields label{display:grid;gap:4px;color:var(--tx-3);font:9px var(--mono)}.energy-en1-fields input{min-width:0;width:100%;height:36px}.energy-en1-actions{display:flex;align-items:center;gap:10px;margin-top:12px}.energy-en1-actions button{min-height:40px}.energy-en1-actions small{color:var(--tx-3);font:9px/1.45 var(--mono)}#energy-en1-status[data-tone="bad"]{color:var(--bad)}#energy-en1-status[data-tone="good"]{color:var(--good)}
    @media(max-width:860px){.energy-en1-people{grid-template-columns:1fr}.energy-en1-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.energy-en1-actions{align-items:stretch;flex-direction:column}.energy-en1-actions button{width:100%;min-height:44px}}
    @media(max-width:480px){.energy-en1-fields{grid-template-columns:1fr}.energy-en1-scope{display:block}}
  `;document.head.appendChild(style)}

  function ensurePanel(){
    let panel=document.getElementById('energy-en1-publication');if(panel)return panel;
    const layout=document.querySelector('#view-energy .energy-layout');if(!layout)return null;
    panel=document.createElement('section');panel.id='energy-en1-publication';panel.className='energy-card';
    panel.innerHTML=`<div class="eyebrow">EN-1 · PROFESSIONAL IDENTITY</div><h2>Applicant + lead modeler</h2>
      <p class="energy-summary">Fill or update these fields at any time for the exact project and immutable Engineering revision shown below. <b>Apply to EN-1</b> republishes only the EN-1 workbook, EN-1 PDF and review ZIP. GeometryCo, OpenStudio/EnergyPlus and COMcheck do not rerun; project identity, signature and seal remain unchanged.</p>
      <div class="energy-en1-scope"><div><strong id="energy-en1-project">No project selected</strong><span id="energy-en1-revision">No immutable Engineering revision</span></div><span id="energy-en1-parent">Generate a complete Energy package before applying.</span></div>
      <div class="energy-en1-people"><details open><summary>Applicant</summary><div class="energy-en1-fields">${personFields('applicant')}</div></details><details open><summary>Lead modeler</summary><div class="energy-en1-fields">${personFields('modeler')}</div></details></div>
      <div class="energy-en1-actions"><button id="energy-en1-apply" class="button sp-btn" type="button" disabled>Apply to EN-1</button><small id="energy-en1-status" role="status" aria-live="polite">Waiting for a complete Energy package bound to this Engineering revision.</small></div>`;
    const results=layout.querySelector('.energy-results-card');layout.insertBefore(panel,results||null);
    panel.addEventListener('input',event=>{if(event.target.matches('input'))dirty=true});
    panel.querySelector('#energy-en1-apply').addEventListener('click',()=>void apply());
    return panel;
  }

  function setStatus(message,tone=''){const node=document.getElementById('energy-en1-status');if(node){node.textContent=message;node.dataset.tone=tone}}
  function revisionId(value){return clean(value).replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120).replace(/\./g,'_')}
  function value(id){return clean(document.getElementById(id)?.value)}
  function readPerson(group){const out={};for(const [key,[suffix]] of Object.entries(fields[group])){let item=value(`energy-en1-${suffix}`);if(!item)continue;if(key==='middleInitial')item=item.slice(0,1).toUpperCase();if(key==='state')item=item.toUpperCase();out[key]=item.slice(0,200)}return out}
  function validate(person,label){if(person.zip&&!/^\d{5}(?:-\d{4})?$/.test(person.zip))throw new Error(`${label} ZIP must be 5 digits or ZIP+4.`);if(person.state&&!/^[A-Z][A-Z .-]{1,31}$/.test(person.state))throw new Error(`${label} state is invalid.`);for(const key of['email','businessEmail'])if(person[key]&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person[key]))throw new Error(`${label} ${key==='businessEmail'?'business email':'email'} is invalid.`)}
  function populate(group,person){for(const [key,[suffix]] of Object.entries(fields[group])){const input=document.getElementById(`energy-en1-${suffix}`);if(input)input.value=clean(person?.[key])}}
  function amendmentId(){const random=root.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;return `en1_${random}`}

  async function context(){
    const store=Store(),projectId=clean(State().projectId||document.getElementById('project-select')?.value);if(!store||!projectId)return{projectId};
    const [source,result]=await Promise.all([store.getEngineeringState(projectId),store.getEnergyResult(projectId)]);
    const sourceRevision=clean(source?.revision||source?.manifest?.revision),parentResultRevision=clean(result?.revision||result?.manifest?.resultRevision);
    const complete=clean(result?.manifest?.status).toUpperCase()==='COMPLETE'&&clean(result?.manifest?.sourceEngineeringRevision)===sourceRevision&&parentResultRevision===clean(result?.manifest?.resultRevision);
    return{store,projectId,source,sourceRevision,result,parentResultRevision,complete};
  }

  async function hydrate(force=false){
    ensurePanel();let ctx;try{ctx=await context()}catch(error){setStatus(error.message||String(error),'bad');return}
    const project=document.getElementById('energy-en1-project'),revision=document.getElementById('energy-en1-revision'),parent=document.getElementById('energy-en1-parent'),button=document.getElementById('energy-en1-apply');
    if(project)project.textContent=ctx.projectId||'No project selected';if(revision)revision.textContent=ctx.sourceRevision?`Engineering revision · ${ctx.sourceRevision}`:'No immutable Engineering revision';if(parent)parent.textContent=ctx.complete?`Current Energy result · ${ctx.parentResultRevision}`:'Generate a complete Energy package before applying.';if(button)button.disabled=busy||!ctx.complete;
    const key=`${ctx.projectId||''}:${ctx.sourceRevision||''}`;
    if(ctx.store&&ctx.sourceRevision&&(force||key!==loadedKey||!dirty)){const consent=await ctx.store.getEnergyConsent(ctx.projectId,ctx.sourceRevision).catch(()=>null);populate('applicant',consent?.en1Applicant||{});populate('modeler',consent?.en1Modeler||{});loadedKey=key;dirty=false}
    if(!ctx.projectId)setStatus('Choose a REVEX project.');else if(!ctx.sourceRevision)setStatus('Publish an immutable Engineering revision.');else if(!ctx.complete)setStatus('Applicant/modeler fields are ready; generate the first complete Energy package, then Apply to EN-1.');else setStatus('Ready. Apply updates EN-1 only; simulations, COMcheck, signature and seal remain unchanged.');
  }

  async function writeIdentity(ctx,en1Applicant,en1Modeler,authority){
    const store=ctx.store,uid=clean(store.user?.uid),revision=revisionId(ctx.sourceRevision);if(!store.isCloud?.()||!uid||!revision)throw new Error('A signed-in REVEX cloud session is required.');
    const ref=store.api.doc(store.db,'projects',ctx.projectId,'revexEnergyConsents',revision,'approvers',uid);
    const raw={en1Applicant,en1Modeler,en1IdentityAuthority:authority,en1IdentityRecordedAt:new Date().toISOString()};
    const patch=store.toFirestorePlain?store.toFirestorePlain(raw):raw,options=store.toFirestorePlain?store.toFirestorePlain({merge:true}):{merge:true};await store.api.setDoc(ref,patch,options);return patch;
  }

  async function apply(){
    if(busy)return;busy=true;const button=document.getElementById('energy-en1-apply');if(button)button.disabled=true;
    try{
      const ctx=await context();if(!ctx.complete)throw new Error('The exact current Engineering revision has no complete Energy result to amend.');
      const en1Applicant=readPerson('applicant'),en1Modeler=readPerson('modeler');validate(en1Applicant,'Applicant');validate(en1Modeler,'Lead modeler');
      setStatus('Saving revision-scoped identity…');await writeIdentity(ctx,en1Applicant,en1Modeler,'explicit-user-input-publication-only-en1-amendment');
      setStatus('Publishing EN-1 only… GeometryCo, simulation and COMcheck remain untouched.');
      const response=await ctx.store.applyEn1IdentityAmendment(ctx.projectId,ctx.sourceRevision,ctx.parentResultRevision,amendmentId());
      const result=await ctx.store.getEnergyResult(ctx.projectId);if(clean(result?.revision||result?.manifest?.resultRevision)!==clean(response.resultRevision))throw new Error('The EN-1 amendment completed without the exact current result record.');
      try{await ctx.store.appendHistory(ctx.projectId,{sourceRevision:ctx.sourceRevision,kind:'energy-en1-amendment',operation:'apply-to-en1',label:'Applied Applicant/Modeler to EN-1',affectedElementIds:[],affectedUniqueIds:[],affectedLevels:[],before:{resultRevision:ctx.parentResultRevision},after:{resultRevision:response.resultRevision,applicantFields:Object.keys(en1Applicant),modelerFields:Object.keys(en1Modeler)},note:'Publication-only amendment: GeometryCo, OpenStudio/EnergyPlus and COMcheck were not rerun; project identity, signature and seal were unchanged.'})}catch(error){diagnostic('WARN','EN1_AMENDMENT_HISTORY',error.message||String(error))}
      dirty=false;setStatus(`Applied to EN-1 as ${response.resultRevision}. Simulations and COMcheck were reused byte-for-byte.`,'good');root.dispatchEvent(new CustomEvent('revex:managed-energy-result',{detail:{projectId:ctx.projectId,revision:ctx.sourceRevision,resultRevision:response.resultRevision,result,response}}));diagnostic('INFO','EN1_IDENTITY_AMENDMENT_COMPLETE','Applicant/modeler were published through the EN-1-only amendment lane.',{projectId:ctx.projectId,sourceRevision:ctx.sourceRevision,parentResultRevision:ctx.parentResultRevision,resultRevision:response.resultRevision});
      await hydrate(true);
    }catch(error){setStatus(error.message||String(error),'bad');diagnostic('ERROR','EN1_IDENTITY_AMENDMENT_FAILED',error.message||String(error))}
    finally{busy=false;const ctx=await context().catch(()=>({complete:false}));if(button)button.disabled=!ctx.complete}
  }

  function wrapConsent(){
    const store=Store();if(!store?.recordEnergyConsent||store.recordEnergyConsent.__revexEn1IdentityR145)return;
    const original=store.recordEnergyConsent.bind(store);const wrapped=async function(projectId,sourceRevision){const consent=await original(projectId,sourceRevision),en1Applicant=readPerson('applicant'),en1Modeler=readPerson('modeler');validate(en1Applicant,'Applicant');validate(en1Modeler,'Lead modeler');if(!Object.keys(en1Applicant).length&&!Object.keys(en1Modeler).length)return consent;const ctx={store,projectId,sourceRevision};const patch=await writeIdentity(ctx,en1Applicant,en1Modeler,'explicit-user-input-during-revision-scoped-comcheck-authorization');return{...consent,...patch}};wrapped.__revexEn1IdentityR145=true;wrapped.__revexOriginal=original;store.recordEnergyConsent=wrapped;
  }

  function install(){if(root.__revexEn1IdentityR145)return;root.__revexEn1IdentityR145={build:BUILD,publicationOnly:true};installCss();ensurePanel();wrapConsent();for(const event of['revex:energy-open','revex:authoritative-project-bound','revex:source-revision-loaded','revex:managed-energy-result'])root.addEventListener(event,()=>setTimeout(()=>void hydrate(),0));document.getElementById('project-select')?.addEventListener('change',()=>{loadedKey='';dirty=false;setTimeout(()=>void hydrate(true),0)});void hydrate(true);diagnostic('INFO','EN1_IDENTITY_PANEL_READY','Always-visible project/revision-scoped Applicant/Modeler panel installed.',{publicationOnly:true,simulationRerun:false,comcheckRerun:false,signatureSealChanged:false})}
  const wait=()=>{if(Store()&&document.getElementById('view-energy')){install();return}setTimeout(wait,50)};wait();
})(window);

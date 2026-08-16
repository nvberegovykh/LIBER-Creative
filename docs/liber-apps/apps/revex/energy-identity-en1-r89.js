(function(root){
  'use strict';
  const BUILD='20260816r89-en1-identity1';
  const clean=v=>String(v??'').trim().replace(/\s+/g,' ');
  const Store=()=>root.RevexStore;
  const diagnostic=(level,stage,message,detail={})=>{try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'EN-1 identity r89',...detail});}catch(_){}};
  const field=(id,label,attrs='')=>`<label style="display:grid;gap:4px"><span>${label}</span><input id="${id}" ${attrs}></label>`;

  function ensureForm(){
    const dialog=document.getElementById('energy-consent-dialog');
    const form=dialog?.querySelector('form');
    if(!form||document.getElementById('energy-en1-identity'))return;
    const block=document.createElement('fieldset');
    block.id='energy-en1-identity';
    block.style.cssText='margin:14px 0 10px;padding:12px;border:1px solid rgba(255,255,255,.14);border-radius:9px;display:grid;gap:10px';
    block.innerHTML=`<legend style="padding:0 6px">EN-1 applicant + lead modeler</legend>
      <div style="font-size:12px;opacity:.72">Stored only with this immutable Engineering revision for EN-1. These fields are not transmitted to COMcheck.</div>
      <details open><summary>Applicant</summary><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px 10px;margin-top:9px">
        ${field('energy-en1-a-first','First name','autocomplete="given-name"')}
        ${field('energy-en1-a-last','Last name','autocomplete="family-name"')}
        ${field('energy-en1-a-mi','Middle initial','maxlength="1"')}
        ${field('energy-en1-a-license','License number','autocomplete="off"')}
        ${field('energy-en1-a-business','Business name','autocomplete="organization"')}
        ${field('energy-en1-a-business-email','Business email','type="email" autocomplete="email"')}
        ${field('energy-en1-a-address','Business address','autocomplete="street-address"')}
        ${field('energy-en1-a-phone','Business telephone','autocomplete="tel"')}
        ${field('energy-en1-a-city','City','autocomplete="address-level2"')}
        ${field('energy-en1-a-state','State','autocomplete="address-level1" maxlength="32"')}
        ${field('energy-en1-a-zip','ZIP','autocomplete="postal-code" maxlength="10" inputmode="numeric"')}
        ${field('energy-en1-a-email','Email','type="email" autocomplete="email"')}
      </div></details>
      <details open><summary>Lead modeler</summary><div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px 10px;margin-top:9px">
        ${field('energy-en1-m-first','First name','autocomplete="given-name"')}
        ${field('energy-en1-m-last','Last name','autocomplete="family-name"')}
        ${field('energy-en1-m-mi','Middle initial','maxlength="1"')}
        ${field('energy-en1-m-business','Business name','autocomplete="organization"')}
        ${field('energy-en1-m-address','Business address','autocomplete="street-address"')}
        ${field('energy-en1-m-phone','Telephone','autocomplete="tel"')}
        ${field('energy-en1-m-city','City','autocomplete="address-level2"')}
        ${field('energy-en1-m-state','State','autocomplete="address-level1" maxlength="32"')}
        ${field('energy-en1-m-zip','ZIP','autocomplete="postal-code" maxlength="10" inputmode="numeric"')}
        ${field('energy-en1-m-email','Email','type="email" autocomplete="email"')}
      </div></details>`;
    const note=form.querySelector('.energy-consent-note');
    if(note)note.insertAdjacentElement('beforebegin',block);else form.appendChild(block);
    diagnostic('INFO','EN1_IDENTITY_FORM_READY','Applicant and lead-modeler fields are available in the revision authorization step.');
  }

  function value(id){return clean(document.getElementById(id)?.value);}
  function record(prefix,map){
    const out={};
    for(const [key,suffix] of Object.entries(map)){
      let v=value(`${prefix}${suffix}`);
      if(!v)continue;
      if(key==='middleInitial')v=v.slice(0,1).toUpperCase();
      if(key==='state')v=v.toUpperCase();
      out[key]=v.slice(0,200);
    }
    return out;
  }
  function applicant(){return record('energy-en1-a-',{
    firstName:'first',lastName:'last',middleInitial:'mi',licenseNumber:'license',businessName:'business',
    businessEmail:'business-email',businessAddress:'address',businessTelephone:'phone',city:'city',state:'state',zip:'zip',email:'email'
  });}
  function modeler(){return record('energy-en1-m-',{
    firstName:'first',lastName:'last',middleInitial:'mi',businessName:'business',businessAddress:'address',telephone:'phone',city:'city',state:'state',zip:'zip',email:'email'
  });}
  function revisionId(value){return clean(value).replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120).replace(/\./g,'_');}
  function validate(person,label){
    if(person.zip&&!/^\d{5}(?:-\d{4})?$/.test(person.zip))throw new Error(`${label} ZIP must be 5 digits or ZIP+4.`);
    if(person.state&&!/^[A-Z][A-Z .-]{1,31}$/.test(person.state))throw new Error(`${label} state is invalid.`);
  }

  function wrapConsent(){
    const store=Store();
    if(!store?.recordEnergyConsent||store.recordEnergyConsent.__revexEn1IdentityR89)return;
    const original=store.recordEnergyConsent.bind(store);
    const wrapped=async function(projectId,sourceRevision){
      const consent=await original(projectId,sourceRevision);
      const en1Applicant=applicant(),en1Modeler=modeler();
      validate(en1Applicant,'Applicant');validate(en1Modeler,'Lead modeler');
      if(!Object.keys(en1Applicant).length&&!Object.keys(en1Modeler).length)return consent;
      const revision=revisionId(sourceRevision),uid=clean(store.user?.uid);
      if(!store.isCloud?.()||!store.api?.doc||!store.api?.setDoc||!store.db||!uid||!projectId||!revision)
        throw new Error('REVEX cloud session is required to attach EN-1 identity to this authorization.');
      const ref=store.api.doc(store.db,'projects',projectId,'revexEnergyConsents',revision,'approvers',uid);
      const raw={
        en1Applicant,en1Modeler,
        en1IdentityAuthority:'explicit-user-input-during-revision-scoped-comcheck-authorization',
        en1IdentityRecordedAt:new Date().toISOString()
      };
      const patch=store.toFirestorePlain?store.toFirestorePlain(raw):raw;
      const options=store.toFirestorePlain?store.toFirestorePlain({merge:true}):{merge:true};
      await store.api.setDoc(ref,patch,options);
      diagnostic('INFO','EN1_IDENTITY_RECORDED','Applicant/modeler identity was attached to this immutable Engineering revision.',{
        projectId,revision,applicantFields:Object.keys(en1Applicant),modelerFields:Object.keys(en1Modeler)
      });
      return {...consent,...patch};
    };
    wrapped.__revexEn1IdentityR89=true;
    wrapped.__revexOriginal=original;
    store.recordEnergyConsent=wrapped;
  }

  function install(){
    if(root.__revexEn1IdentityR89)return;
    root.__revexEn1IdentityR89={build:BUILD};
    ensureForm();wrapConsent();
    root.addEventListener('revex:managed-energy-status',event=>{
      if(String(event.detail?.stage||'').toUpperCase()==='CONSENT_REQUIRED'){ensureForm();wrapConsent();}
    });
  }
  const wait=()=>{if(Store()&&document.getElementById('energy-consent-dialog')){install();return;}setTimeout(wait,50);};
  wait();
})(window);

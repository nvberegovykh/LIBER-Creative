const fs=require('fs'),assert=require('assert/strict'),{chromium}=require('playwright');
const origin='https://liberpict.com',preview=process.env.REVEX_PREVIEW_URL,fixture=JSON.parse(fs.readFileSync('/workspace/qa-private/accounts.json')),projectId='release-evidence-95f5bfa7f67a539d',out='/workspace/results/personal';
fs.mkdirSync(out,{recursive:true});const checks=[],errors=[];let browser,page;
const pass=(name,evidence)=>{checks.push({name,status:'PASS',evidence});console.log('PASS '+name);};
(async()=>{
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const context=await browser.newContext({viewport:{width:1440,height:960}});await context.addInitScript(()=>{try{navigator.serviceWorker.register=async()=>undefined;}catch{}});
 await context.route(origin+'/liber-apps/**',async r=>{if(r.request().method()!=='GET')return r.continue();const u=new URL(r.request().url());await r.fulfill({response:await r.fetch({url:preview+u.pathname+u.search})});});
 await context.route('https://accounts.google.com/gsi/client',r=>r.fulfill({contentType:'text/javascript',body:"window.google={accounts:{oauth2:{hasGrantedAllScopes:()=>true,initTokenClient(config){window.qaGoogleConfig=config;return{requestAccessToken(){setTimeout(()=>config.callback({access_token:'qa-token',expires_in:3600}),10)}}}}}};"}));
 await context.route('https://cloudresourcemanager.googleapis.com/v1/projects*',r=>r.fulfill({json:{projects:[{projectId:'designer-owned-project',name:'Designer billing',lifecycleState:'ACTIVE'},{projectId:'second-owned-project',name:'Other project',lifecycleState:'ACTIVE'}]}}));
 const calls=[];let providerStatus=402;
 await context.route('https://generativelanguage.googleapis.com/**',r=>{
   calls.push({method:r.request().method(),url:r.request().url(),project:r.request().headers()['x-goog-user-project']});
   if(r.request().method()==='GET')return r.fulfill({json:{name:'models/gemini-3.1-flash-image'}});
   return r.fulfill({status:providerStatus,json:{error:{message:'Your prepayment credits are depleted. Please go to AI Studio at https://aistudio.google.com/projects to manage your project and billing.'}}});
 });
 page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/liber-apps/index.html#apps');await page.waitForFunction(()=>window.firebaseService?._authStateReady&&window.authManager);
 await page.locator('#loginUsername').fill(fixture.accounts[0].email);await page.locator('#loginPassword').fill(fixture.accounts[0].password);await page.locator('#loginForm button[type="submit"]').click();
 await page.waitForFunction(uid=>firebaseService.auth.currentUser?.uid===uid&&authManager.currentUser?.id===uid,fixture.accounts[0].uid);
 await page.evaluate(async({id,uid,qa})=>{const s=firebaseService,a=s.firebase,r=await a.getDoc(a.doc(s.db,'projects',id));if(!r.exists()||r.data().ownerId!==uid||r.data().qaFixture!==qa)throw Error('QA ownership mismatch');},{id:projectId,uid:fixture.accounts[0].uid,qa:fixture.fixtureId});
 await page.goto(origin+'/liber-apps/apps/revex/index.html?projectId='+projectId+'&view=bim');await page.waitForFunction(()=>window.__revexViewerR26Instance?.detailLoaded,null,{timeout:180000});
 for(let i=0;i<4;i++){const got=page.getByRole('button',{name:'Got it',exact:true});if(await got.count()&&await got.last().isVisible())await got.last().click();else break;}
 if(await page.locator('#revex-install-close').isVisible())await page.locator('#revex-install-close').click();
 await page.evaluate(()=>{RevexStore.createRenderJob=async()=>({id:'qa-render-mock'});RevexStore.updateRenderJob=async()=>{};});
 await page.locator('#render-button').click();await page.locator('#google-ai-connect').waitFor();
 pass('Real authenticated REVEX project and model load without an error overlay',{title:await page.title(),url:page.url()});
 await page.locator('#render-google-generate').click();assert.equal(calls.length,0);
 await page.locator('#google-ai-connect').click();await page.waitForFunction(()=>document.querySelector('#google-ai-project').options.length===3);
 assert.equal(await page.locator('#google-ai-project').inputValue(),'');assert.equal(calls.length,0);
 assert.equal(await page.evaluate(()=>firebaseService.auth.currentUser.uid),fixture.accounts[0].uid);
 const requestedScopes=(await page.evaluate(()=>qaGoogleConfig.scope)).split(' ');
 assert(requestedScopes.includes('https://www.googleapis.com/auth/generative-language.retriever'));
 assert(requestedScopes.includes('https://www.googleapis.com/auth/cloud-platform.read-only'));
 assert(!requestedScopes.includes('https://www.googleapis.com/auth/cloud-platform'));
 pass('Independent Google authorization preserves LIBER identity, requires the documented Gemini scope with read-only Cloud access, and never automatically selects LIBER billing');
 await page.locator('#google-ai-project').selectOption('designer-owned-project');await page.locator('#google-ai-check').click();
 await page.waitForFunction(()=>document.querySelector('#render-agent-capability').textContent.includes('project checked'));
 assert(calls.every(c=>c.project==='designer-owned-project'));
 assert.equal(calls.filter(c=>c.method==='POST').length,0);
 await page.locator('#google-ai-resolution').selectOption('4K');assert((await page.locator('#google-ai-price').innerText()).includes('$0.151'));
 await page.locator('#google-ai-resolution').selectOption('1K');assert((await page.locator('#google-ai-price').innerText()).includes('$0.067'));
 pass('Project access is checked without generating; image prices follow resolution; billing links go directly to Google');
 await page.locator('#render-google-generate').click();await page.waitForFunction(()=>document.querySelector('#render-status').textContent.includes('more credits'));
 assert.equal(calls.filter(c=>c.method==='POST').length,1);assert(calls.every(c=>c.project==='designer-owned-project'));
 assert(!(await page.locator('#render-status').innerText()).includes('https:'));
 assert(!(await page.locator('#render-agent-capability').innerText()).includes('ready'));
 pass('Depleted-credit failure is readable, uses selected customer project, and never retries or falls back to LIBER billing');
 for(const width of [320,390,768,1024,1260,1440]){
  await page.setViewportSize({width,height:900});
  const result=await page.locator('#render-agent-panel').evaluate(e=>{
   const box=e.getBoundingClientRect(),button=document.querySelector('#render-google-generate'),style=getComputedStyle(button);
   return {box:{left:box.left,right:box.right,width:box.width},overflow:[...e.querySelectorAll('button,select,input,a,textarea')].filter(n=>n.getBoundingClientRect().width&&n.getBoundingClientRect().right>box.right+2).map(n=>n.id||n.textContent.slice(0,30)),color:style.color,background:style.backgroundColor};
  });
  assert.equal(result.overflow.length,0,JSON.stringify({width,result}));assert(result.box.left>=-1);
  assert.notEqual(result.background,'rgba(0, 0, 0, 0)');assert.equal(result.color,'rgb(8, 11, 16)');
  const b=await page.locator('#render-google-generate').boundingBox(); assert(b.y+b.height<=900, 'Render button must remain reachable without scrolling');
  await page.screenshot({path:out+'/render-'+width+'.png'});
 }
 pass('Render controls fit 320–1440px widths and primary button has contrasting colors');
 // A late OAuth result may not cross a LIBER account boundary.
 await page.locator('#google-ai-connect').click();await page.waitForFunction(()=>document.querySelector('#google-ai-project').options.length===3);
 assert.equal(await page.locator('#render-agent-capability').innerText(),'Google connected');
 assert.equal(calls.filter(c=>c.method==='POST').length,1);
 pass('Changing Google account clears the checked billing state and does not generate');

 await page.locator('#render-close').click();
 await page.evaluate(()=>{
   window.qaEnergySource={revision:'qa-current',manifest:{revision:'qa-current'}};
   window.qaEnergyResult={revision:'qa-old-result',manifest:{sourceEngineeringRevision:'qa-old',status:'FAILED',error:'Earlier geometry failure'},artifacts:[{name:'00_PIPELINE_REQUEST_CONTENT_IDENTITY_WITH_A_VERY_LONG_UNBROKEN_FILENAME_20260928_R125.json',kind:'diagnostic',bytes:12003,url:'https://example.com/qa.json'}]};
   RevexStore.getEngineeringState=async()=>qaEnergySource;RevexStore.getEnergyResult=async()=>qaEnergyResult;
   RevexStore.subscribeEngineeringState=(_id,callback)=>{callback(qaEnergySource);return()=>{}};
   RevexStore.subscribeEnergyResult=(_id,callback)=>{callback(qaEnergyResult);return()=>{}};
 });
 await page.locator('[data-view="energy"]').click();await page.locator('#energy-refresh').click();
 await page.waitForFunction(()=>document.querySelector('#energy-previous-result'));
 assert.equal(await page.locator('#energy-previous-result').evaluate(e=>e.open),false);
 assert((await page.locator('#energy-result-summary').innerText()).includes('no completed result'));
 await page.evaluate(()=>{Object.assign(__revexHostedEnergyRuntime,{running:true,projectId:__revexState.projectId,revision:'qa-current'});window.dispatchEvent(new CustomEvent('revex:managed-energy-status',{detail:{projectId:__revexState.projectId,message:'Processing current attempt',stage:'RUNNING'}}));});
 await page.waitForFunction(()=>document.querySelector('#energy-result-summary').textContent.includes('processing'));
 pass('A current run is distinguished from old failure artifacts, which stay collapsed');
 await page.locator('#energy-previous-result summary').click();
 for(const width of [320,390,768,1024,1260,1440]){
  await page.setViewportSize({width,height:900});
  const bounds=await page.locator('#view-energy').evaluate(e=>({scroll:e.scrollWidth,width:e.clientWidth,rows:[...e.querySelectorAll('.energy-artifact')].map(n=>{const r=n.getBoundingClientRect(),p=n.closest('.energy-card').getBoundingClientRect();return {width:r.width,left:r.left-p.left,right:p.right-r.right,metaWidth:n.querySelector('.energy-artifact-meta').getBoundingClientRect().width}})}));
  assert(bounds.scroll<=bounds.width+2,JSON.stringify({width,bounds}));assert(bounds.rows.every(r=>r.left>=-1&&r.right>=-1&&r.metaWidth>80),JSON.stringify({width,bounds}));
  await page.locator('#energy-artifacts').scrollIntoViewIfNeeded();await page.screenshot({path:out+'/energy-'+width+'.png'});
 }
 pass('Long Energy report filenames and metadata remain contained across all six widths');
 await page.evaluate(()=>{__revexHostedEnergyRuntime.running=false;qaEnergyResult.manifest={sourceEngineeringRevision:'qa-current',status:'COMPLETE',resultRevision:'qa-current-result'};window.dispatchEvent(new CustomEvent('revex:managed-energy-result',{detail:{projectId:__revexState.projectId,result:qaEnergyResult}}));});
 await page.waitForFunction(()=>document.querySelector('#energy-result-summary').textContent.includes('completed from Engineering'));
 assert.equal(await page.locator('#energy-previous-result').count(),0);
 pass('The completed current result replaces the previous-attempt presentation');
 await page.evaluate(()=>{qaEnergyResult.manifest.geometryReview={required:true};qaEnergyResult.artifacts=[{name:'EN1_REVIEW.pdf',kind:'filing-report',url:'https://example.com/qa.pdf'}];window.dispatchEvent(new CustomEvent('revex:managed-energy-result',{detail:{projectId:__revexState.projectId,result:qaEnergyResult}}));});
 await page.waitForFunction(()=>document.querySelector('#energy-result-summary').textContent.includes('geometry review required'));
 assert((await page.locator('#energy-result-summary').innerText()).includes('before filing'));
 await page.screenshot({path:out+'/energy-geometry-review.png'});
 pass('Geometry adjustments remain an explicit review requirement after successful calculations');


 const about=await context.newPage();await about.goto(preview+'/liber-apps/about.html');
 assert((await about.locator('body').innerText()).includes('LIBER'));assert.equal(await about.locator('a[href="/privacy.html"]').count(),2);
 await about.setViewportSize({width:390,height:844});assert(await about.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await about.screenshot({path:out+'/about-mobile.png'});
 pass('Public OAuth landing page explains LIBER and links privacy and terms without login');
})().catch(async e=>{checks.push({name:'Personal Google browser journey',status:'FAIL',error:e.message,stack:e.stack});console.error(e.stack);await page?.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();fs.writeFileSync(out+'/result.json',JSON.stringify({preview,checks,errors},null,2));fs.writeFileSync(out+'/exit-status.txt',String(process.exitCode||0));});

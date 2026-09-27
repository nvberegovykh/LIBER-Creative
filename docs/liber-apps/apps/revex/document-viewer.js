import { getDocument, GlobalWorkerOptions } from './vendor/pdfjs-6.3.289/build/pdf.mjs';
GlobalWorkerOptions.workerSrc=new URL('./vendor/pdfjs-6.3.289/build/pdf.worker.mjs',import.meta.url).href;
const $=id=>document.getElementById(id), vendor=new URL('./vendor/pdfjs-6.3.289/',import.meta.url).href;
let documentToken=0,renderToken=0,task=null,pdf=null,picture=null,source=null,currentPage=1,totalPages=1,rotation=0,zoom=null,view=null,renderTask=null,mode='',pending=[],calibrations=new Map(),lines=new Map(),pageText='';
const status=text=>{$('status').textContent=text;}, pageKey=()=>String(currentPage), scaleData=()=>calibrations.get(pageKey());
function permitted(url){try{const u=new URL(url,location.href);return ['https:','http:','blob:'].includes(u.protocol)?u.href:'';}catch(_){return '';}}
function controls(ready){$('previous').disabled=!ready||currentPage<=1;$('next').disabled=!ready||currentPage>=totalPages;$('page').disabled=!ready;$('page').value=currentPage;$('page').max=totalPages;$('total').textContent=`/ ${totalPages}`;for(const id of ['zoom-in','zoom-out','fit','rotate','calibrate','text-toggle'])$(id).disabled=!ready;$('text-toggle').disabled=!ready||!pdf;$('measure').disabled=!ready||!scaleData();$('clear-measurements').disabled=!(lines.get(pageKey())||[]).length;}
function clearMode(){mode='';pending=[];$('calibration-input').hidden=true;$('measure').setAttribute('aria-pressed','false');$('calibrate').setAttribute('aria-pressed','false');draw();}
function hint(){const s=scaleData();$('measure-hint').textContent=mode==='calibrate'?(pending.length===2?'Enter the real length of the selected line.':'Select two ends of a known dimension.') : mode==='measure'?'Select two points to measure. Escape cancels.':s?`Calibrated in ${s.unit} for this page. Measurements use your calibration.`:'Calibrate from a known dimension on this page.';}
function toPage(x,y){return pdf?view.convertToPdfPoint(x,y):[x/view.scale,y/view.scale];}
function toScreen(point){return pdf?view.convertToViewportPoint(...point):point.map(x=>x*view.scale);}
function distance(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1]);}
function draw(){
 const svg=$('measure-overlay');svg.replaceChildren();svg.classList.toggle('active',Boolean(mode)&&!$('paper').hidden);hint();
 const all=[...(lines.get(pageKey())||[]),...(pending.length?[{points:pending,pending:true}]:[])];
 for(const row of all){const pts=row.points.map(toScreen);if(!pts.length)continue;
  const color=row.pending?'#e48b20':'#197eac';
  if(pts.length===2){const el=document.createElementNS('http://www.w3.org/2000/svg','line');for(const [k,v] of Object.entries({x1:pts[0][0],y1:pts[0][1],x2:pts[1][0],y2:pts[1][1],stroke:color,'stroke-width':3}))el.setAttribute(k,v);svg.append(el);}
  for(const p of pts){const el=document.createElementNS('http://www.w3.org/2000/svg','circle');for(const [k,v] of Object.entries({cx:p[0],cy:p[1],r:5,fill:color,stroke:'white','stroke-width':1.5}))el.setAttribute(k,v);svg.append(el);}
 }
 const list=$('measurements');list.replaceChildren();const s=scaleData();
 (lines.get(pageKey())||[]).forEach((row,i)=>{const li=document.createElement('li');li.textContent=`${(distance(...row.points)*s.ratio).toFixed(3)} ${s.unit}`;const button=document.createElement('button');button.textContent='Remove';button.setAttribute('aria-label',`Remove measurement ${i+1}`);button.onclick=()=>{lines.get(pageKey()).splice(i,1);draw();controls(Boolean(view));};li.append(button);list.append(li);});
}
async function renderPage(){
 if(!pdf&&!picture)return;const run=++renderToken,owner=documentToken;renderTask?.cancel();view=null;controls(false);status('Rendering page…');
 try{
  const page=pdf?await pdf.getPage(currentPage):null;if(run!==renderToken||owner!==documentToken)return;
  const natural=page?page.getViewport({scale:1,rotation}):{width:picture.naturalWidth,height:picture.naturalHeight};
  const available=Math.max(240,$('viewport').clientWidth-32),factor=zoom||Math.min(2,available/natural.width);
  const viewport=page?page.getViewport({scale:factor,rotation}):{width:natural.width*factor,height:natural.height*factor,scale:factor};
  let element;
  if(page){element=document.createElement('canvas');const dpr=Math.min(devicePixelRatio||1,2,Math.sqrt(16000000/(viewport.width*viewport.height)));element.width=Math.ceil(viewport.width*dpr);element.height=Math.ceil(viewport.height*dpr);element.style.width=`${viewport.width}px`;element.style.height=`${viewport.height}px`;renderTask=page.render({canvasContext:element.getContext('2d'),viewport,transform:dpr===1?null:[dpr,0,0,dpr,0,0]});await renderTask.promise;const text=await page.getTextContent();if(run!==renderToken||owner!==documentToken)return;pageText=text.items.map(item=>item.str+(item.hasEOL?'\n':' ')).join('');}
  else{element=picture.cloneNode();element.style.width=`${viewport.width}px`;element.style.height=`${viewport.height}px`;pageText='';}
  if(run!==renderToken||owner!==documentToken)return;view=viewport;$('page-content').replaceChildren(element);$('page-text').textContent=pageText;$('measure-overlay').setAttribute('viewBox',`0 0 ${viewport.width} ${viewport.height}`);$('zoom').textContent=`${Math.round(factor*100)}%`;controls(true);$('rotate').disabled=!pdf;draw();status(`${source.title||'Document'} · page ${currentPage} of ${totalPages}`);parent.postMessage({type:'revex-document-rendered',identity:source.identity,page:currentPage,totalPages},location.origin);
 }catch(error){if(run===renderToken&&owner===documentToken&&error.name!=='RenderingCancelledException'){status(`Could not render this page: ${error.message}. Use Open original or select another page.`);controls(Boolean(pdf||picture));}}
}
async function load(data){
 const owner=++documentToken;++renderToken;renderTask?.cancel();task?.destroy().catch(()=>{});task=null;pdf=null;picture=null;view=null;source=data;calibrations.clear();lines.clear();clearMode();$('page-content').replaceChildren();$('page-text').textContent='';$('page-text').hidden=true;$('paper').hidden=false;$('text-toggle').setAttribute('aria-pressed','false');controls(false);
 const url=permitted(data.url);if(!url){status('This document has no supported source URL.');return;}$('original').href=url;
 currentPage=Math.max(1,Number(data.page)||1);rotation=0;zoom=null;status('Loading document…');
 try{
  const mime=String(data.mime||''),name=String(data.name||data.title||'').toLowerCase();
  if(mime==='application/pdf'||/\.pdf($|[?#])/.test(name)||/\.pdf($|[?#])/i.test(url)){
   const loading=getDocument({url,cMapUrl:vendor+'cmaps/',cMapPacked:true,standardFontDataUrl:vendor+'standard_fonts/',wasmUrl:vendor+'wasm/',iccUrl:vendor+'iccs/'});task=loading;
   loading.onPassword=(update,reason)=>{if(owner!==documentToken)return;status('This PDF needs a password. Use Open original to unlock it.');};
   const result=await loading.promise;if(owner!==documentToken){result.destroy();return;}pdf=result;totalPages=pdf.numPages;currentPage=Math.min(currentPage,totalPages);await renderPage();
  }else if(mime.startsWith('image/')||/\.(png|jpe?g|webp|gif|bmp)$/i.test(name)){
   const img=new Image();img.alt=data.title||'Project image';img.src=url;await img.decode();if(owner!==documentToken)return;picture=img;totalPages=1;currentPage=1;await renderPage();
  }else if(mime.startsWith('text/')||/\.(txt|json|csv|log|err|xml|md)$/i.test(name)){
   const response=await fetch(url);if(!response.ok)throw new Error(`Download returned ${response.status}`);const reader=response.body.getReader(),parts=[];let bytes=0;while(true){const result=await reader.read();if(result.done)break;bytes+=result.value.length;if(bytes>2000000){await reader.cancel();throw new Error('This text file is too large for preview. Open the original file');}parts.push(result.value);if(owner!==documentToken){await reader.cancel();return;}}
   const text=await new Blob(parts).text();if(owner!==documentToken)return;$('paper').hidden=true;$('page-text').hidden=false;$('page-text').textContent=text;status(data.title||'Document');
  }else status('This file type opens in its original application. Use Open original.');
 }catch(error){if(owner===documentToken)status(`Could not open document: ${error.message}. Use Open original or select the document again.`);}
}
function changePage(n){if(!Number.isInteger(n)||n<1||n>totalPages){$('page').value=currentPage;return;}currentPage=n;clearMode();void renderPage();}
$('previous').onclick=()=>changePage(currentPage-1);$('next').onclick=()=>changePage(currentPage+1);$('page').onchange=()=>changePage(Number($('page').value));
$('fit').onclick=()=>{zoom=null;void renderPage();};$('rotate').onclick=()=>{rotation=(rotation+90)%360;void renderPage();};
for(const [id,multiplier] of [['zoom-in',1.25],['zoom-out',.8]])$(id).onclick=()=>{zoom=Math.min(5,Math.max(.1,(view?.scale||1)*multiplier));void renderPage();};
$('text-toggle').onclick=()=>{const show=$('page-text').hidden;$('page-text').hidden=!show;$('paper').hidden=show;$('text-toggle').setAttribute('aria-pressed',String(show));clearMode();};
$('calibrate').onclick=()=>{clearMode();mode='calibrate';$('paper').hidden=false;$('page-text').hidden=true;$('text-toggle').setAttribute('aria-pressed','false');$('calibrate').setAttribute('aria-pressed','true');draw();};
$('measure').onclick=()=>{const was=mode==='measure';clearMode();if(!was){mode='measure';$('paper').hidden=false;$('page-text').hidden=true;$('text-toggle').setAttribute('aria-pressed','false');$('measure').setAttribute('aria-pressed','true');}draw();};
$('measure-overlay').addEventListener('pointerdown',event=>{if(!mode||!view||pending.length===2)return;event.preventDefault();const r=event.currentTarget.getBoundingClientRect();pending.push(toPage((event.clientX-r.left)*view.width/r.width,(event.clientY-r.top)*view.height/r.height));if(pending.length===2){if(distance(...pending)<.001){pending=[];status('Choose two different points.');}else if(mode==='calibrate'){$('calibration-input').hidden=false;$('known-length').value='';$('known-length').focus();}else{const rows=lines.get(pageKey())||[];rows.push({points:pending});lines.set(pageKey(),rows);pending=[];controls(true);}}draw();});
$('apply-scale').onclick=()=>{const length=Number($('known-length').value);if(pending.length!==2||!Number.isFinite(length)||length<=0){status('Enter a positive known length.');return;}calibrations.set(pageKey(),{ratio:length/distance(...pending),unit:$('unit').value});clearMode();controls(true);status('Scale applied to this page.');};
$('clear-measurements').onclick=()=>{lines.delete(pageKey());clearMode();controls(Boolean(view));};
window.addEventListener('keydown',event=>{if(event.key==='Escape'){clearMode();return;}if(/INPUT|SELECT|TEXTAREA/.test(event.target.tagName))return;if(event.key==='ArrowRight')changePage(currentPage+1);if(event.key==='ArrowLeft')changePage(currentPage-1);});
let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);if(!zoom&&(pdf||picture))resizeTimer=setTimeout(()=>void renderPage(),180);}).observe($('viewport'));
window.addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='revex-document-open')return;void load(event.data.document);});
controls(false);parent.postMessage({type:'revex-document-ready'},location.origin);

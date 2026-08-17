import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..','..');
const revex=path.join(root,'docs','liber-apps','apps','revex');
const PORT=41739;
const VERTICES=1_200_000;

function syntheticGeometry(){
  const bodyBytes=8+4+1+8+4+8+4+VERTICES*6*4+1;
  const buffer=Buffer.alloc(bodyBytes);
  let p=0;
  buffer.write('RVXSCN2\0',p,'ascii');p+=8;
  buffer.writeInt32LE(2,p);p+=4;
  buffer.writeUInt8(1,p++);
  buffer.writeDoubleLE(1,p);p+=8;
  buffer.writeInt32LE(1,p);p+=4;
  buffer.writeDoubleLE(0,p);p+=8;
  buffer.writeInt32LE(VERTICES,p);p+=4;
  // Repeated tiny triangles intentionally compress well but still require the browser
  // to decode and construct a very large single source mesh part.
  for(let i=0;i<VERTICES;i++){
    const tri=i%3;
    const x=tri===1?1:0,y=tri===2?1:0,z=(Math.floor(i/3)%64)*0.0001;
    buffer.writeFloatLE(x,p);p+=4;buffer.writeFloatLE(y,p);p+=4;buffer.writeFloatLE(z,p);p+=4;
    buffer.writeFloatLE(0,p);p+=4;buffer.writeFloatLE(0,p);p+=4;buffer.writeFloatLE(1,p);p+=4;
  }
  buffer.writeUInt8(0,p++);
  return zlib.gzipSync(buffer,{level:1});
}

const geometry=syntheticGeometry();
const harness=`<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#111;color:#eee;font:14px sans-serif}#viewer{width:900px;height:600px}#probe{position:fixed;right:10px;top:10px;z-index:20}
</style><script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.179.1/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.179.1/examples/jsm/"}}</script></head><body>
<section id="view-bim"><div id="viewer"></div><div id="issue-pins"></div><div id="viewer-message"></div>
<button id="fit-model"></button><button id="fit-model-rail"></button><button id="detail-toggle">Model</button><button id="walk-toggle"></button><select id="walk-floor"></select><input id="walk-height" value="5.5"><input id="walk-fov" value="55"><button id="section-toggle"></button><div id="section-controls"></div><div id="walk-controls"></div></section>
<button id="probe">probe</button>
<script>window.RevexStore={};window.__clicked=0;document.getElementById('probe').onclick=()=>window.__clicked++;window.__revexState={issues:[],viewerData:null,cloudState:null,bimAppearances:new Map(),bimOverlays:new Map()};</script>
<script src="/revex/viewer-runtime-r75.js"></script>
<script src="/revex/viewer-safety-r107.js"></script>
<script type="module" src="/revex/viewer-r26.js"></script>
</body></html>`;

const mime=file=>file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream';
const server=http.createServer(async(req,res)=>{
  try{
    if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end(harness)}
    if(req.url==='/synthetic.rvxmesh.gz'){res.writeHead(200,{'content-type':'application/gzip','cache-control':'no-store'});return res.end(geometry)}
    if(req.url?.startsWith('/revex/')){
      const file=path.join(revex,decodeURIComponent(req.url.slice('/revex/'.length).split('?')[0]));
      const data=await fs.readFile(file);res.writeHead(200,{'content-type':mime(file),'cache-control':'no-store'});return res.end(data);
    }
    res.writeHead(404);res.end('not found');
  }catch(error){res.writeHead(500);res.end(String(error?.stack||error))}
});
await new Promise(resolve=>server.listen(PORT,'127.0.0.1',resolve));

const browser=await chromium.launch({headless:true,args:['--use-gl=swiftshader','--enable-webgl','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1200,height:800}});
const errors=[];
page.on('pageerror',error=>errors.push('pageerror: '+error.message));
page.on('console',message=>{if(message.type()==='error')errors.push('console: '+message.text())});
try{
  await page.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:'networkidle',timeout:30000});
  await page.waitForFunction(()=>window.__revexViewerR26Instance&&window.__revexViewerR26Instance.__r107Safety,{timeout:15000});
  await page.evaluate(()=>{
    const data={source:{documentTitle:'r107 synthetic',viewName:'3D'},levels:[],elements:[{id:1,uniqueId:'synthetic-1',category:'Walls',categoryKey:'walls',family:'Basic Wall',type:'Synthetic',proxyEligible:true,bbox:{min:[0,0,0],max:[10,1,10]}}],geometry:{displayFormat:'rvxmesh-gzip-pages',highDetail:{elements:1}}};
    const state={modelUrl:'/synthetic.rvxmesh.gz',modelFormat:'rvxmesh-gzip-pages',modelPages:[{url:'/synthetic.rvxmesh.gz'}]};
    window.__revexState.viewerData=data;window.__revexState.cloudState=state;
    window.__revexViewerR26Instance.load(state,data);
  });
  // Let the proxy shell settle, then explicitly request exact model detail. This proves
  // the full functionality path, not a proxy-only safe mode.
  await page.waitForTimeout(800);
  await page.locator('#detail-toggle').click({timeout:1500});
  const started=Date.now();
  let lastTicks=-1;
  while(Date.now()-started<30000){
    const sample=await Promise.race([
      page.evaluate(()=>({ticks:window.__revexHeartbeatR107?.ticks||0,maxGap:window.__revexHeartbeatR107?.maxGap||0,detailLoaded:!!window.__revexViewerR26Instance?.detailLoaded,detailLoading:!!window.__revexViewerR26Instance?.detailLoading})),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('REVEX browser main thread stopped answering for >1500 ms.')),1500))
    ]);
    if(lastTicks>=0&&sample.ticks<=lastTicks)throw new Error('REVEX heartbeat stopped while exact BIM geometry was loading.');
    lastTicks=sample.ticks;
    await page.locator('#probe').click({timeout:1000});
    const clicked=await page.evaluate(()=>window.__clicked);
    if(clicked<1)throw new Error('REVEX UI click was not processed while BIM geometry was loading.');
    if(sample.detailLoaded){
      if(sample.maxGap>1200)throw new Error(`REVEX main-thread gap exceeded 1200 ms (${sample.maxGap.toFixed(1)} ms).`);
      console.log(JSON.stringify({schema:'liber.revex.r107.browser-responsiveness.v1',status:'PASSED',vertices:VERTICES,ticks:sample.ticks,maxGapMs:Math.round(sample.maxGap),detailLoaded:true,uiClicks:clicked},null,2));
      process.exitCode=0;return;
    }
    await page.waitForTimeout(350);
  }
  throw new Error('Exact BIM detail did not finish inside the 30 s browser regression window.');
}finally{
  if(errors.length)console.error('Browser errors:',errors.join('\n'));
  await browser.close();server.close();
}

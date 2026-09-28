'use strict';
// Resolve only Google's own grounding redirect. Never fetch a model-supplied merchant URL.
function publicUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname.includes('.')&&!/^(?:\d|\[)/.test(u.hostname)&&!/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname)?u.href:null;}catch{return null;}}
async function directSource(source,request=fetch){
 const original=publicUrl(source.url);if(!original)return source;
 const u=new URL(original);if(u.hostname!=='vertexaisearch.cloud.google.com'||!u.pathname.startsWith('/grounding-api-redirect/'))return {...source,url:original,direct:true};
 try{const response=await request(original,{redirect:'manual',signal:AbortSignal.timeout(4500)});await response.body?.cancel();const target=publicUrl(response.headers.get('location'));if(response.status>=300&&response.status<400&&target&&new URL(target).hostname!=='vertexaisearch.cloud.google.com')return {...source,url:target,groundingUrl:original,direct:true};}catch{}
 return {...source,direct:false};
}
function verifiedProducts(proposed,sources,supports){
 const seen=new Set();return (Array.isArray(proposed)?proposed:[]).filter(p=>{
  if(!p||typeof p.sourceKey!=='string'||seen.has(p.sourceKey)||!sources.some(s=>s.key===p.sourceKey&&s.direct)||typeof p.name!=='string'||!p.name.trim())return false;
  seen.add(p.sourceKey);return true;
 }).slice(0,5).map(p=>{
  const evidence=supports.filter(s=>s.sourceKeys.includes(p.sourceKey)).map(s=>s.text).join('\n');
  const quote=typeof p.deliveryEvidence==='string'&&p.deliveryEvidence.length>=15&&evidence.includes(p.deliveryEvidence)?p.deliveryEvidence:'';
  return {sourceKey:p.sourceKey,name:p.name.slice(0,200),reason:String(p.reason||'').slice(0,500),deliveryEvidence:quote,availability:quote?'Delivery mentioned in source; confirm your ZIP at checkout':'Confirm NYC delivery and current stock with the seller'};
 });
}
function productPage(source){
 if(!source?.direct||!publicUrl(source.url))return false;
 const u=new URL(source.url);
 return /\/(?:p|pd|pdp|products?)\/[^/]+/i.test(u.pathname)&&!/(?:\.(?:pdf|zip|rfa)$|\/collections?\/|\/search\/)/i.test(u.pathname)&&!/(?:^|\.)(?:bimobject\.com|blocksrvt\.com)$/.test(u.hostname);
}
// Preserve actual product-page evidence even if the prose described another variant.
// A search result alone does not establish a match, stock, price or delivery.
function productPageFallback(sources,existing=[]){
 const seen=new Set(existing.map(p=>p.sourceKey));return sources.filter(s=>!seen.has(s.key)&&productPage(s)).slice(0,Math.max(0,5-existing.length)).map(s=>({sourceKey:s.key,name:s.title&&!/^[\w.-]+\.[a-z]{2,}$/i.test(s.title)?s.title.slice(0,200):'Product details · '+new URL(s.url).hostname.replace(/^www\./,''),reason:'Found during research. Check the exact model, size and finish on the seller’s page.',deliveryEvidence:'',availability:'Confirm NYC delivery and current stock with the seller'}));
}
module.exports={publicUrl,directSource,verifiedProducts,productPage,productPageFallback};

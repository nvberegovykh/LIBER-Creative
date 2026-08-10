(function(root){
  'use strict';
  const Store=root.RevexStore;
  if(!Store||root.__revexCacheR21) return;
  root.__revexCacheR21=true;
  const cache=new Map();
  const memo=(name,keyFn,ttl=30000)=>{
    const original=typeof Store[name]==='function'?Store[name].bind(Store):null;
    if(!original) return;
    Store[name]=function(...args){
      const key=name+':'+keyFn(...args),now=Date.now(),hit=cache.get(key);
      if(hit&&now-hit.at<ttl) return hit.promise;
      const promise=Promise.resolve().then(()=>original(...args)).catch(error=>{cache.delete(key);throw error;});
      cache.set(key,{at:now,promise});return promise;
    };
  };
  memo('getState',id=>String(id||''),12000);
  memo('fetchJson',url=>String(url||''),45000);
  memo('listDesignEdits',id=>String(id||''),12000);
  memo('listChapterEdits',id=>String(id||''),12000);
  memo('listIssues',id=>String(id||''),8000);
  memo('listLibrary',id=>String(id||''),8000);
  root.addEventListener('revex:r20-revision',()=>cache.clear());
  root.addEventListener('revex:r21-revision',()=>cache.clear());
  console.log('[REVEX] revision cache 20260810r24',{dedupe:true});
})(window);
